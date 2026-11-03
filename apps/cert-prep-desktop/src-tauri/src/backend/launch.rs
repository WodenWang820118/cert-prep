use std::{
    sync::{atomic::Ordering, Arc},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::{
    backend_process::launch_backend_entrypoint,
    capture_manifest::load_capture_runtime_manifest,
    capture_runtime::{install_bundled_capture_runtime, CaptureRuntimeState},
    constants::CAPTURE_RUNTIME_MODEL,
    manifests::load_runtime_manifest,
    runtime_installation::{
        completed_installation, failed_installation, install_python_runtime, installation_from_job,
        RuntimeJob,
    },
    runtime_slots::{CAPTURE_RUNTIME_SLOT, PYTHON_BACKEND_SLOT},
    runtime_update::{BACKEND_UPDATE_KIND, CAPTURE_UPDATE_KIND},
    DesktopRuntimeInstallation,
};

use super::{BackendRuntimeInner, BackendState, StartupRuntimeRefresh};

enum CaptureJobClaim {
    Claimed,
    Existing(RuntimeJob),
}

impl BackendRuntimeInner {
    fn finish_runtime_update(&self, kind: &str, result: Result<(), String>) {
        if let Ok(mut updates) = self.runtime_updates.lock() {
            updates.finish(kind, result);
        }
    }
}

impl BackendState {
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
        if self.inner.installed_capture_runtime_paths().is_err() {
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

    /// Startup step, run synchronously in Tauri setup before the WebView can
    /// request anything: decides which runtimes the user installed from an
    /// earlier app version and queues their refresh jobs, so the first
    /// `runtime_update_status` poll already shows the notice and no user
    /// install or start can race the refresh.
    pub(crate) fn plan_startup_runtime_refresh(&self) -> StartupRuntimeRefresh {
        let data_dir = &self.inner.data_dir;
        let backend_bytes = self
            .inner
            .backend_bundle_identity()
            .filter(|identity| PYTHON_BACKEND_SLOT.needs_refresh(data_dir, identity))
            .and_then(|_| self.inner.backend_manifest_path.as_deref())
            .map(|path| load_runtime_manifest(path).map_or(0, |manifest| manifest.artifact.bytes));
        let capture_bytes = self
            .inner
            .capture_bundle_identity()
            .filter(|identity| CAPTURE_RUNTIME_SLOT.needs_refresh(data_dir, identity))
            .and_then(|_| self.inner.capture_runtime_manifest_path.as_deref())
            .map(|path| load_capture_runtime_manifest(path).map_or(0, |manifest| manifest.bytes));

        let Ok(mut updates) = self.inner.runtime_updates.lock() else {
            return StartupRuntimeRefresh::default();
        };
        let backend_job = backend_bytes.and_then(|bytes| {
            let mut job = RuntimeJob::queued_python_backend();
            job.detail =
                "Updating the Python backend runtime to the version bundled with this app.".into();
            let job_id = job.id.clone();
            let mut current = self.inner.job.lock().ok()?;
            *current = Some(job);
            updates.plan(BACKEND_UPDATE_KIND, bytes);
            Some(job_id)
        });
        let capture_job = capture_bytes.and_then(|bytes| {
            let mut job = RuntimeJob::queued_capture_runtime();
            job.detail = "Updating Capture Runtime to the version bundled with this app.".into();
            let job_id = job.id.clone();
            matches!(self.claim_capture_job(job), Ok(CaptureJobClaim::Claimed)).then(|| {
                updates.plan(CAPTURE_UPDATE_KIND, bytes);
                job_id
            })
        });
        StartupRuntimeRefresh {
            backend_job,
            capture_job,
        }
    }

    /// Startup worker: removes leftovers of earlier installs and runs the
    /// planned Capture Runtime refresh. Engines and user data live outside
    /// the runtime slots and are kept.
    pub(crate) fn refresh_installed_capture_runtime(&self, job_id: Option<String>) {
        CAPTURE_RUNTIME_SLOT.sweep(&self.inner.data_dir);
        let Some(job_id) = job_id else {
            return;
        };
        install_capture_runtime(Arc::clone(&self.inner), job_id.clone());
        let result = match self.capture_job().filter(|job| job.id == job_id) {
            Some(job) if job.status == "succeeded" => Ok(()),
            Some(job) => Err(job.error.unwrap_or(job.detail)),
            None => Err("Capture Runtime update state is unavailable.".into()),
        };
        self.inner
            .finish_runtime_update(CAPTURE_UPDATE_KIND, result);
    }

    /// Startup worker: launches the installed Python backend. A planned
    /// refresh reinstalls it from the bundle first, as a normal installation
    /// job. On failure the previous copy stays on disk but is not launched.
    pub(crate) fn launch_installed_backend_at_startup(
        &self,
        job_id: Option<String>,
    ) -> Result<(), String> {
        PYTHON_BACKEND_SLOT.sweep(&self.inner.data_dir);
        let Some(job_id) = job_id else {
            return self.try_launch_installed_backend();
        };
        install_python_runtime(Arc::clone(&self.inner), job_id.clone());
        let job = self.get_installation(&job_id)?;
        // The update is applied once the installed copy matches the bundle,
        // even if launching the backend afterwards failed.
        let applied = if self.inner.installed_backend_entrypoint().is_some() {
            Ok(())
        } else {
            Err(job.error.clone().unwrap_or_else(|| job.detail.clone()))
        };
        self.inner
            .finish_runtime_update(BACKEND_UPDATE_KIND, applied);
        match job.status.as_str() {
            "succeeded" => Ok(()),
            _ => Err(job.error.unwrap_or(job.detail)),
        }
    }

    fn try_launch_installed_backend(&self) -> Result<(), String> {
        let entrypoint = self
            .installed_entrypoint()
            .ok_or_else(|| "Python backend runtime is not installed.".to_string())?;
        let capture_connection = self.capture_runtime_connection()?;
        launch_backend_entrypoint(&self.inner, &entrypoint, capture_connection.as_ref(), false)
    }

    pub(crate) fn start_installation(&self) -> DesktopRuntimeInstallation {
        // The startup probe may finish after the window has begun closing. Do
        // not create a late worker that could outlive the desktop shell and
        // race the process cleanup path.
        if self.inner.closing.load(Ordering::SeqCst) {
            return failed_installation(
                "Cert Prep is closing; Python backend runtime was not installed.",
            );
        }
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

    fn active_capture_job(&self) -> Option<RuntimeJob> {
        self.capture_job()
            .filter(|job| matches!(job.status.as_str(), "queued" | "starting" | "running"))
    }
}

fn completed_capture_installation(detail: &str) -> DesktopRuntimeInstallation {
    let now = installation_timestamp();
    DesktopRuntimeInstallation {
        id: uuid::Uuid::new_v4().to_string(),
        kind: "capture_runtime".into(),
        provider: "bundled-release".into(),
        model: CAPTURE_RUNTIME_MODEL.into(),
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
        Err(error) => {
            eprintln!("Capture Runtime installation failed: {error}");
            update_capture_job(&inner, &job_id, "failed", &error, Some(error.clone()));
        }
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
        let (manifest_path, executable_path) = inner.installed_capture_runtime_paths()?;
        let capture_runtime = CaptureRuntimeState::launch_cancellable(
            &manifest_path,
            &executable_path,
            &inner.data_dir,
            Some(&inner.closing),
        )?;
        restart_owned_backend_with_capture_runtime(&inner, capture_runtime)?;
        Ok::<(), String>(())
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
    if !inner
        .backend_manifest_path
        .as_ref()
        .is_some_and(|path| path.is_file())
    {
        return Err("Python backend runtime manifest is not bundled.".into());
    }
    let entrypoint = inner.installed_backend_entrypoint().ok_or_else(|| {
        "Python backend runtime is not installed. Install it before starting Capture Runtime."
            .to_string()
    })?;

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn closing_state_rejects_python_runtime_installation_without_creating_a_worker() {
        let data_dir = std::env::temp_dir().join(format!(
            "cert-prep-closing-installation-{}",
            uuid::Uuid::new_v4()
        ));
        let state = BackendState::new(data_dir.clone(), None, None);

        state.terminate_child_process_tree();

        let installation = state.start_installation();

        assert_eq!(installation.status, "failed");
        assert_eq!(
            installation.error.as_deref(),
            Some("Cert Prep is closing; Python backend runtime was not installed.")
        );
        assert!(state.active_job().is_none());

        let _ = fs::remove_dir_all(data_dir);
    }
}
