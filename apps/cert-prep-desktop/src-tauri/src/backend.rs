use std::{
    path::PathBuf,
    process::Child,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::path::BaseDirectory;
use tauri::Manager;
use tauri::Runtime;

use crate::{
    backend_process::launch_backend_entrypoint,
    capture_runtime::{
        install_bundled_capture_runtime, installed_capture_runtime_paths, CaptureRuntimeConnection,
        CaptureRuntimeState,
    },
    constants::{BACKEND_RUNTIME_DIR, PYTHON_RUNTIME_KIND, PYTHON_RUNTIME_LABEL},
    manifests::{load_runtime_manifest, RuntimeManifest},
    runtime_installation::{
        completed_installation, install_python_runtime, installation_from_job, RuntimeJob,
    },
    windows_process::terminate_owned_process_tree,
    DesktopRuntimeInstallation,
};

const CAPTURE_START_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

enum CaptureJobClaim {
    Claimed,
    Existing(RuntimeJob),
}

/// Connection information used by the Angular app to reach the local backend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BackendConfig {
    pub base_url: String,
    pub token: String,
}

/// User-facing status for the packaged Python backend runtime.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRuntimeStatus {
    pub kind: String,
    pub label: String,
    pub available: bool,
    pub running: bool,
    pub status: String,
    pub detail: String,
    pub unavailable_reason: Option<String>,
    pub version: Option<String>,
    pub installed_path: Option<String>,
    pub base_url: Option<String>,
    pub token: Option<String>,
    pub job_id: Option<String>,
    pub completed: Option<u64>,
    pub total: Option<u64>,
    pub error: Option<String>,
}

pub(crate) struct BackendRuntimeInner {
    pub(crate) data_dir: PathBuf,
    pub(crate) backend_manifest_path: Option<PathBuf>,
    pub(crate) capture_runtime_manifest_path: Option<PathBuf>,
    pub(crate) capture_runtime: Mutex<Option<CaptureRuntimeState>>,
    pub(crate) backend_launch: Mutex<()>,
    pub(crate) config: Mutex<Option<BackendConfig>>,
    pub(crate) child: Mutex<Option<Child>>,
    pub(crate) job: Mutex<Option<RuntimeJob>>,
    pub(crate) capture_job: Mutex<Option<RuntimeJob>>,
    pub(crate) capture_start_active: Mutex<bool>,
    pub(crate) capture_start_complete: Condvar,
    pub(crate) external_backend: Mutex<bool>,
    pub(crate) closing: AtomicBool,
}

/// Shared Tauri state for backend runtime process and installation lifecycle.
#[derive(Clone)]
pub struct BackendState {
    inner: Arc<BackendRuntimeInner>,
}

/// Builds backend connection details without changing the transport schema.
pub fn build_backend_config(
    base_url: impl Into<String>,
    token: impl Into<String>,
) -> BackendConfig {
    BackendConfig {
        base_url: base_url.into(),
        token: token.into(),
    }
}

impl Drop for BackendRuntimeInner {
    fn drop(&mut self) {
        self.closing.store(true, Ordering::SeqCst);
        self.terminate_child_process_tree();
        self.terminate_capture_runtime_process_tree();
        self.wait_for_capture_start_shutdown(CAPTURE_START_SHUTDOWN_TIMEOUT);
        self.terminate_capture_runtime_process_tree();
    }
}

impl BackendRuntimeInner {
    pub(crate) fn terminate_child_process_tree(&self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.take() {
                terminate_owned_process_tree(child);
            }
        }
    }

    pub(crate) fn terminate_capture_runtime_process_tree(&self) {
        if let Ok(mut runtime) = self.capture_runtime.lock() {
            if let Some(runtime) = runtime.take() {
                runtime.terminate_child_process_tree();
            }
        }
    }

    fn begin_capture_start(&self) -> Result<(), String> {
        let mut active = self
            .capture_start_active
            .lock()
            .map_err(|_| "Capture Runtime start state is unavailable.".to_string())?;
        if *active {
            return Err("Capture Runtime is already starting.".into());
        }
        *active = true;
        Ok(())
    }

    fn finish_capture_start(&self) {
        if let Ok(mut active) = self.capture_start_active.lock() {
            *active = false;
            self.capture_start_complete.notify_all();
        }
    }

    /// Give a cancellation-aware sidecar start a short, bounded window to
    /// terminate its locally-owned child before the desktop process exits.
    fn wait_for_capture_start_shutdown(&self, timeout: Duration) -> bool {
        let Ok(active) = self.capture_start_active.lock() else {
            return false;
        };
        match self
            .capture_start_complete
            .wait_timeout_while(active, timeout, |active| *active)
        {
            Ok((active, _)) => !*active,
            Err(_) => false,
        }
    }

    fn installed_runtime_dir(&self) -> PathBuf {
        self.data_dir.join("runtimes").join(BACKEND_RUNTIME_DIR)
    }

    fn installed_manifest_path(&self) -> PathBuf {
        self.installed_runtime_dir().join("runtime-manifest.json")
    }
}

impl BackendState {
    pub(crate) fn new(
        data_dir: PathBuf,
        backend_manifest_path: Option<PathBuf>,
        capture_runtime_manifest_path: Option<PathBuf>,
    ) -> Self {
        Self {
            inner: Arc::new(BackendRuntimeInner {
                data_dir,
                backend_manifest_path,
                capture_runtime_manifest_path,
                capture_runtime: Mutex::new(None),
                backend_launch: Mutex::new(()),
                config: Mutex::new(None),
                child: Mutex::new(None),
                job: Mutex::new(None),
                capture_job: Mutex::new(None),
                capture_start_active: Mutex::new(false),
                capture_start_complete: Condvar::new(),
                external_backend: Mutex::new(false),
                closing: AtomicBool::new(false),
            }),
        }
    }

    pub(crate) fn terminate_child_process_tree(&self) {
        self.inner.closing.store(true, Ordering::SeqCst);
        self.inner.terminate_child_process_tree();
        self.inner.terminate_capture_runtime_process_tree();
        self.inner
            .wait_for_capture_start_shutdown(CAPTURE_START_SHUTDOWN_TIMEOUT);
        // A start may have completed its handoff immediately before the
        // cancellation check. Terminate the newly-managed process too.
        self.inner.terminate_capture_runtime_process_tree();
    }

    pub(crate) fn set_external_config(&self, config: BackendConfig) {
        if let Ok(mut current) = self.inner.config.lock() {
            *current = Some(config);
        }
        if let Ok(mut external) = self.inner.external_backend.lock() {
            *external = true;
        }
    }

    pub(crate) fn backend_config(&self) -> Option<BackendConfig> {
        self.inner
            .config
            .lock()
            .ok()
            .and_then(|config| config.clone())
    }

    pub(crate) fn status(&self) -> DesktopRuntimeStatus {
        if let Some(config) = self.backend_config() {
            return DesktopRuntimeStatus {
                kind: PYTHON_RUNTIME_KIND.into(),
                label: PYTHON_RUNTIME_LABEL.into(),
                available: true,
                running: true,
                status: "running".into(),
                detail: "Python backend runtime is running.".into(),
                unavailable_reason: None,
                version: self.installed_manifest().map(|manifest| manifest.version),
                installed_path: self
                    .installed_entrypoint()
                    .map(|path| path.display().to_string()),
                base_url: Some(config.base_url),
                token: Some(config.token),
                job_id: None,
                completed: None,
                total: None,
                error: None,
            };
        }

        if let Some(job) = self.active_job() {
            return DesktopRuntimeStatus {
                kind: PYTHON_RUNTIME_KIND.into(),
                label: PYTHON_RUNTIME_LABEL.into(),
                available: false,
                running: false,
                status: job.status,
                detail: job.detail,
                unavailable_reason: Some("python_runtime_installing".into()),
                version: None,
                installed_path: None,
                base_url: None,
                token: None,
                job_id: Some(job.id),
                completed: job.completed,
                total: job.total,
                error: job.error,
            };
        }

        if let Some(entrypoint) = self.installed_entrypoint() {
            return DesktopRuntimeStatus {
                kind: PYTHON_RUNTIME_KIND.into(),
                label: PYTHON_RUNTIME_LABEL.into(),
                available: true,
                running: false,
                status: "installed".into(),
                detail: "Python backend runtime is installed but not running.".into(),
                unavailable_reason: Some("python_runtime_not_running".into()),
                version: self.installed_manifest().map(|manifest| manifest.version),
                installed_path: Some(entrypoint.display().to_string()),
                base_url: None,
                token: None,
                job_id: None,
                completed: None,
                total: None,
                error: None,
            };
        }

        DesktopRuntimeStatus {
            kind: PYTHON_RUNTIME_KIND.into(),
            label: PYTHON_RUNTIME_LABEL.into(),
            available: false,
            running: false,
            status: "missing".into(),
            detail: "Python backend runtime is not installed.".into(),
            unavailable_reason: Some("python_runtime_missing".into()),
            version: None,
            installed_path: None,
            base_url: None,
            token: None,
            job_id: None,
            completed: None,
            total: None,
            error: None,
        }
    }

    pub(crate) fn active_job(&self) -> Option<RuntimeJob> {
        self.inner.job.lock().ok().and_then(|job| {
            job.as_ref()
                .filter(|job| matches!(job.status.as_str(), "queued" | "running"))
                .cloned()
        })
    }

    fn installed_runtime_dir(&self) -> PathBuf {
        self.inner.installed_runtime_dir()
    }

    fn installed_manifest_path(&self) -> PathBuf {
        self.inner.installed_manifest_path()
    }

    fn installed_manifest(&self) -> Option<RuntimeManifest> {
        load_runtime_manifest(&self.installed_manifest_path()).ok()
    }

    fn installed_entrypoint(&self) -> Option<PathBuf> {
        let manifest = self.installed_manifest()?;
        let entrypoint = self.installed_runtime_dir().join(manifest.entrypoint);
        entrypoint.is_file().then_some(entrypoint)
    }

    fn capture_runtime_connection(&self) -> Result<Option<CaptureRuntimeConnection>, String> {
        self.inner
            .capture_runtime
            .lock()
            .map_err(|_| "Capture Runtime ownership state is unavailable.".to_string())
            .map(|runtime| runtime.as_ref().map(CaptureRuntimeState::connection))
    }

    pub(crate) fn capture_runtime_status(&self) -> DesktopRuntimeStatus {
        match self.capture_runtime_connection() {
            Ok(Some(_)) => {
                return capture_runtime_status(
                    true,
                    true,
                    "running",
                    "Capture Runtime is running.",
                    None,
                    None,
                    None,
                );
            }
            Err(error) => {
                return capture_runtime_status(
                    false,
                    false,
                    "failed",
                    &error,
                    Some("capture_runtime_failed".into()),
                    None,
                    Some(error.clone()),
                );
            }
            Ok(None) => {}
        }

        match self.inner.external_backend.lock() {
            Ok(external) if *external => {
                return capture_runtime_status(
                    false,
                    false,
                    "requires_host_configuration",
                    "Capture Runtime requires host configuration because an external backend is active.",
                    Some("requires_host_configuration".into()),
                    None,
                    None,
                );
            }
            Err(_) => {
                return capture_runtime_status(
                    false,
                    false,
                    "failed",
                    "Capture Runtime ownership state is unavailable.",
                    Some("capture_runtime_failed".into()),
                    None,
                    Some("Capture Runtime ownership state is unavailable.".into()),
                );
            }
            Ok(_) => {}
        }

        if let Some(job) = self.capture_job() {
            let unavailable_reason = match job.status.as_str() {
                "queued" | "starting" | "running" => Some("capture_runtime_starting".into()),
                "failed" => Some("capture_runtime_failed".into()),
                _ => None,
            };
            if unavailable_reason.is_some() {
                return capture_runtime_status(
                    installed_capture_runtime_paths(&self.inner.data_dir).is_ok(),
                    false,
                    &job.status,
                    &job.detail,
                    unavailable_reason,
                    Some(job.clone()),
                    job.error,
                );
            }
        }

        if installed_capture_runtime_paths(&self.inner.data_dir).is_ok() {
            return capture_runtime_status(
                true,
                false,
                "installed",
                "Capture Runtime is installed but stopped.",
                Some("capture_runtime_stopped".into()),
                None,
                None,
            );
        }

        capture_runtime_status(
            false,
            false,
            "missing",
            "Capture Runtime is not installed.",
            Some("capture_runtime_missing".into()),
            None,
            None,
        )
    }

    fn capture_job(&self) -> Option<RuntimeJob> {
        self.inner
            .capture_job
            .lock()
            .ok()
            .and_then(|job| job.clone())
    }

    fn active_capture_job(&self) -> Option<RuntimeJob> {
        self.capture_job()
            .filter(|job| matches!(job.status.as_str(), "queued" | "starting" | "running"))
    }

    /// Atomically retain an active job or claim the right to launch exactly
    /// one worker for a new capture runtime action.
    fn claim_capture_job(&self, requested: RuntimeJob) -> Result<CaptureJobClaim, String> {
        let mut current = self
            .inner
            .capture_job
            .lock()
            .map_err(|_| "Capture Runtime installation state is unavailable.".to_string())?;
        if let Some(active) = current
            .as_ref()
            .filter(|job| matches!(job.status.as_str(), "queued" | "starting" | "running"))
            .cloned()
        {
            return Ok(CaptureJobClaim::Existing(active));
        }
        *current = Some(requested);
        Ok(CaptureJobClaim::Claimed)
    }

    pub(crate) fn start_capture_runtime_installation(&self) -> DesktopRuntimeInstallation {
        if self.inner.closing.load(Ordering::SeqCst) {
            return failed_capture_installation(
                "Cert Prep is closing; Capture Runtime was not installed.",
            );
        }
        if let Some(job) = self.active_capture_job() {
            return installation_from_job(job);
        }
        if matches!(
            self.capture_runtime_status().status.as_str(),
            "installed" | "running"
        ) {
            return completed_capture_installation("Capture Runtime is already installed.");
        }

        let job = RuntimeJob::queued_capture_runtime();
        let job_id = job.id.clone();
        match self.claim_capture_job(job.clone()) {
            Ok(CaptureJobClaim::Existing(active)) => return installation_from_job(active),
            Ok(CaptureJobClaim::Claimed) => {}
            Err(error) => return failed_capture_installation(&error),
        }
        let inner = Arc::clone(&self.inner);
        thread::spawn(move || install_capture_runtime(inner, job_id));
        installation_from_job(job)
    }

    pub(crate) fn start_installed_capture_runtime(&self) -> DesktopRuntimeInstallation {
        if self.inner.closing.load(Ordering::SeqCst) {
            return failed_capture_installation(
                "Cert Prep is closing; Capture Runtime was not started.",
            );
        }
        if let Some(job) = self.active_capture_job() {
            return installation_from_job(job);
        }
        match self.capture_runtime_connection() {
            Ok(Some(_)) => {
                return completed_capture_installation("Capture Runtime is already running.");
            }
            Err(error) => return failed_capture_installation(&error),
            Ok(None) => {}
        }
        if self
            .inner
            .external_backend
            .lock()
            .ok()
            .is_some_and(|external| *external)
        {
            return failed_capture_installation(
                "Capture Runtime requires host configuration because an external backend is active.",
            );
        }
        if installed_capture_runtime_paths(&self.inner.data_dir).is_err() {
            return failed_capture_installation(
                "Capture Runtime is not installed. Install it before starting it.",
            );
        }

        let mut job = RuntimeJob::queued_capture_runtime();
        job.status = "starting".into();
        job.detail = "Capture Runtime start queued.".into();
        let job_id = job.id.clone();
        match self.claim_capture_job(job.clone()) {
            Ok(CaptureJobClaim::Existing(active)) => return installation_from_job(active),
            Ok(CaptureJobClaim::Claimed) => {}
            Err(error) => return failed_capture_installation(&error),
        }
        if let Err(error) = self.inner.begin_capture_start() {
            update_capture_job(&self.inner, &job_id, "failed", &error, Some(error.clone()));
            return failed_capture_installation(&error);
        }
        let inner = Arc::clone(&self.inner);
        thread::spawn(move || start_capture_runtime(inner, job_id));
        installation_from_job(job)
    }

    pub(crate) fn get_capture_runtime_installation(
        &self,
        job_id: &str,
    ) -> Result<DesktopRuntimeInstallation, String> {
        let job = self
            .inner
            .capture_job
            .lock()
            .map_err(|_| "Capture Runtime installation state is unavailable.".to_string())?
            .as_ref()
            .filter(|job| job.id == job_id)
            .cloned()
            .ok_or_else(|| "Capture Runtime installation job was not found.".to_string())?;
        Ok(installation_from_job(job))
    }

    pub(crate) fn try_launch_installed_backend(&self) -> Result<(), String> {
        let entrypoint = self
            .installed_entrypoint()
            .ok_or_else(|| "Python backend runtime is not installed.".to_string())?;
        let capture_connection = self.capture_runtime_connection()?;
        launch_backend_entrypoint(&self.inner, &entrypoint, capture_connection.as_ref(), false)
    }

    pub(crate) fn start_installation(&self) -> DesktopRuntimeInstallation {
        if self.backend_config().is_some() {
            return completed_installation("Python backend runtime is already running.");
        }

        if let Some(job) = self.active_job() {
            return installation_from_job(job);
        }

        let job = RuntimeJob::queued_python_backend();
        let job_id = job.id.clone();
        if let Ok(mut current) = self.inner.job.lock() {
            *current = Some(job.clone());
        }

        let inner = Arc::clone(&self.inner);
        thread::spawn(move || install_python_runtime(inner, job_id));
        installation_from_job(job)
    }

    pub(crate) fn get_installation(
        &self,
        job_id: &str,
    ) -> Result<DesktopRuntimeInstallation, String> {
        let job = self
            .inner
            .job
            .lock()
            .map_err(|_| "Runtime installation state is unavailable.".to_string())?
            .as_ref()
            .filter(|job| job.id == job_id)
            .cloned()
            .ok_or_else(|| "Python runtime installation job was not found.".to_string())?;
        Ok(installation_from_job(job))
    }
}

fn capture_runtime_status(
    available: bool,
    running: bool,
    status: &str,
    detail: &str,
    unavailable_reason: Option<String>,
    job: Option<RuntimeJob>,
    error: Option<String>,
) -> DesktopRuntimeStatus {
    DesktopRuntimeStatus {
        kind: "capture_runtime".into(),
        label: "Capture Runtime".into(),
        available,
        running,
        status: status.into(),
        detail: detail.into(),
        unavailable_reason,
        version: Some("0.3.8".into()),
        installed_path: None,
        // The Capture Runtime endpoint and bearer token are intentionally
        // absent from the desktop/WebView status transport.
        base_url: None,
        token: None,
        job_id: job.as_ref().map(|job| job.id.clone()),
        completed: job.as_ref().and_then(|job| job.completed),
        total: job.as_ref().and_then(|job| job.total),
        error,
    }
}

fn completed_capture_installation(detail: &str) -> DesktopRuntimeInstallation {
    let now = installation_timestamp();
    DesktopRuntimeInstallation {
        id: uuid::Uuid::new_v4().to_string(),
        kind: "capture_runtime".into(),
        provider: "bundled-release".into(),
        model: "capture-runtime@0.3.8".into(),
        status: "succeeded".into(),
        detail: detail.into(),
        completed: None,
        total: None,
        created_at: now.clone(),
        updated_at: now,
        error: None,
    }
}

fn failed_capture_installation(detail: &str) -> DesktopRuntimeInstallation {
    DesktopRuntimeInstallation {
        error: Some(detail.into()),
        status: "failed".into(),
        ..completed_capture_installation(detail)
    }
}

fn update_capture_job(
    inner: &BackendRuntimeInner,
    job_id: &str,
    status: &str,
    detail: &str,
    error: Option<String>,
) {
    if let Ok(mut current) = inner.capture_job.lock() {
        if let Some(job) = current.as_mut().filter(|job| job.id == job_id) {
            job.status = status.into();
            job.detail = detail.into();
            job.error = error;
            job.updated_at = installation_timestamp();
        }
    }
}

fn install_capture_runtime(inner: Arc<BackendRuntimeInner>, job_id: String) {
    update_capture_job(
        &inner,
        &job_id,
        "running",
        "Verifying bundled Capture Runtime.",
        None,
    );
    let result = inner
        .capture_runtime_manifest_path
        .as_ref()
        .filter(|path| path.is_file())
        .ok_or_else(|| {
            "Bundled Capture Runtime is unavailable. Reinstall Cert Prep to restore it.".to_string()
        })
        .and_then(|manifest| install_bundled_capture_runtime(manifest, &inner.data_dir));
    match result {
        Ok(_) => update_capture_job(
            &inner,
            &job_id,
            "succeeded",
            "Capture Runtime is installed and stopped. Start it when you are ready.",
            None,
        ),
        Err(error) => update_capture_job(&inner, &job_id, "failed", &error, Some(error.clone())),
    }
}

fn start_capture_runtime(inner: Arc<BackendRuntimeInner>, job_id: String) {
    let _start_guard = CaptureStartGuard {
        inner: Arc::clone(&inner),
    };
    update_capture_job(
        &inner,
        &job_id,
        "starting",
        "Starting Capture Runtime.",
        None,
    );
    let result = (|| {
        let (manifest_path, executable_path) = installed_capture_runtime_paths(&inner.data_dir)?;
        let capture_runtime = CaptureRuntimeState::launch_cancellable(
            &manifest_path,
            &executable_path,
            &inner.data_dir,
            Some(&inner.closing),
        )?;
        restart_owned_backend_with_capture_runtime(&inner, capture_runtime)
    })();
    match result {
        Ok(()) => update_capture_job(
            &inner,
            &job_id,
            "succeeded",
            "Capture Runtime and the Cert Prep backend are ready.",
            None,
        ),
        Err(error) => update_capture_job(&inner, &job_id, "failed", &error, Some(error.clone())),
    }
}

struct CaptureStartGuard {
    inner: Arc<BackendRuntimeInner>,
}

impl Drop for CaptureStartGuard {
    fn drop(&mut self) {
        self.inner.finish_capture_start();
    }
}

fn restart_owned_backend_with_capture_runtime(
    inner: &Arc<BackendRuntimeInner>,
    capture_runtime: CaptureRuntimeState,
) -> Result<(), String> {
    if inner.closing.load(Ordering::SeqCst) {
        return Err("Cert Prep is closing; Capture Runtime was not started.".into());
    }
    if *inner
        .external_backend
        .lock()
        .map_err(|_| "External backend ownership state is unavailable.".to_string())?
    {
        return Err(
            "Capture Runtime requires host configuration because an external backend is active."
                .into(),
        );
    }
    let manifest_path = inner
        .backend_manifest_path
        .as_ref()
        .filter(|path| path.is_file())
        .ok_or_else(|| "Python backend runtime manifest is not bundled.".to_string())?;
    let manifest = load_runtime_manifest(manifest_path)?;
    let entrypoint = inner.installed_runtime_dir().join(manifest.entrypoint);
    if !entrypoint.is_file() {
        return Err(
            "Python backend runtime is not installed. Install it before starting Capture Runtime."
                .into(),
        );
    }

    let connection = capture_runtime.connection();
    // Acquire the ownership lock before starting the backend candidate. If it
    // is poisoned, the candidate is never spawned; once the candidate is
    // ready, this guard makes the final sidecar swap infallible.
    let mut current = inner
        .capture_runtime
        .lock()
        .map_err(|_| "Capture Runtime ownership state is unavailable.".to_string())?;
    // `launch_backend_entrypoint` only swaps the existing owned backend after
    // the candidate passed its local readiness probe. Any failure therefore
    // drops this new sidecar and retains the previous backend configuration.
    launch_backend_entrypoint(inner, &entrypoint, Some(&connection), true)?;
    if let Some(previous) = current.replace(capture_runtime) {
        previous.terminate_child_process_tree();
    }
    Ok(())
}

fn installation_timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".into())
}

pub(crate) fn resource_path<R: Runtime>(app: &tauri::App<R>, file_name: &str) -> Option<PathBuf> {
    for candidate in resource_candidates(file_name) {
        if let Ok(path) = app.path().resolve(candidate, BaseDirectory::Resource) {
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

fn resource_candidates(file_name: &str) -> [String; 3] {
    [
        file_name.to_string(),
        format!("resources/{file_name}"),
        format!("generated-resources/{file_name}"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::BACKEND_RUNTIME_MANIFEST;
    use std::fs;

    #[test]
    fn build_backend_config_preserves_url_and_token() {
        let config = build_backend_config("http://127.0.0.1:49152", "secret-token");

        assert_eq!(
            config,
            BackendConfig {
                base_url: "http://127.0.0.1:49152".into(),
                token: "secret-token".into(),
            }
        );
    }

    #[test]
    fn backend_config_serializes_for_angular_transport() {
        let config = build_backend_config("http://127.0.0.1:49152", "secret-token");
        let json = serde_json::to_value(config).expect("config should serialize");

        assert_eq!(
            json,
            serde_json::json!({
                "base_url": "http://127.0.0.1:49152",
                "token": "secret-token"
            })
        );
    }

    #[test]
    fn resource_candidates_cover_flat_and_nested_resource_paths() {
        assert_eq!(
            resource_candidates(BACKEND_RUNTIME_MANIFEST),
            [
                "backend-runtime-manifest.json".to_string(),
                "resources/backend-runtime-manifest.json".to_string(),
                "generated-resources/backend-runtime-manifest.json".to_string()
            ]
        );
    }

    #[test]
    fn missing_runtime_status_is_installable() {
        let data_dir =
            std::env::temp_dir().join(format!("cert-prep-runtime-{}", uuid::Uuid::new_v4()));
        let state = BackendState::new(data_dir.clone(), None, None);

        let status = state.status();

        assert_eq!(status.status, "missing");
        assert_eq!(
            status.unavailable_reason,
            Some("python_runtime_missing".into())
        );
        assert!(!status.running);

        let _ = fs::remove_dir_all(data_dir);
    }

    #[test]
    fn capture_runtime_status_reports_missing_starting_and_failed_without_connection_data() {
        let data_dir = std::env::temp_dir().join(format!(
            "cert-prep-capture-runtime-status-{}",
            uuid::Uuid::new_v4()
        ));
        let state = BackendState::new(data_dir.clone(), None, None);

        let missing = state.capture_runtime_status();
        assert_eq!(missing.status, "missing");
        assert_eq!(
            missing.unavailable_reason.as_deref(),
            Some("capture_runtime_missing")
        );
        assert_eq!(missing.base_url, None);
        assert_eq!(missing.token, None);

        let mut starting = RuntimeJob::queued_capture_runtime();
        starting.status = "starting".into();
        starting.detail = "Starting Capture Runtime.".into();
        *state.inner.capture_job.lock().expect("capture job") = Some(starting);
        let starting = state.capture_runtime_status();
        assert_eq!(starting.status, "starting");
        assert_eq!(
            starting.unavailable_reason.as_deref(),
            Some("capture_runtime_starting")
        );
        assert_eq!(starting.base_url, None);
        assert_eq!(starting.token, None);

        let mut failed = RuntimeJob::queued_capture_runtime();
        failed.status = "failed".into();
        failed.detail = "Capture Runtime start failed.".into();
        failed.error = Some("Capture Runtime start failed.".into());
        *state.inner.capture_job.lock().expect("capture job") = Some(failed);
        let failed = state.capture_runtime_status();
        assert_eq!(failed.status, "failed");
        assert_eq!(
            failed.unavailable_reason.as_deref(),
            Some("capture_runtime_failed")
        );
        assert_eq!(failed.base_url, None);
        assert_eq!(failed.token, None);

        let _ = fs::remove_dir_all(data_dir);
    }
}
