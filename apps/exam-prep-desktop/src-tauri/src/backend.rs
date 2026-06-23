use std::{
    path::PathBuf,
    process::Child,
    sync::{Arc, Mutex},
    thread,
};

use serde::Serialize;
use tauri::path::BaseDirectory;
use tauri::Manager;
use tauri::Runtime;

use crate::{
    backend_process::launch_backend_entrypoint,
    constants::{BACKEND_RUNTIME_DIR, PYTHON_RUNTIME_KIND, PYTHON_RUNTIME_LABEL},
    manifests::{load_runtime_manifest, RuntimeManifest},
    runtime_installation::{
        completed_installation, install_python_runtime, installation_from_job, RuntimeJob,
    },
    windows_process::terminate_backend_process_tree,
    DesktopRuntimeInstallation,
};

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
    pub(crate) ocr_manifest_path: Option<PathBuf>,
    pub(crate) windowsml_ocr_manifest_path: Option<PathBuf>,
    pub(crate) config: Mutex<Option<BackendConfig>>,
    pub(crate) child: Mutex<Option<Child>>,
    pub(crate) job: Mutex<Option<RuntimeJob>>,
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
        self.terminate_child_process_tree();
    }
}

impl BackendRuntimeInner {
    pub(crate) fn terminate_child_process_tree(&self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.take() {
                terminate_backend_process_tree(child);
            }
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
        ocr_manifest_path: Option<PathBuf>,
        windowsml_ocr_manifest_path: Option<PathBuf>,
    ) -> Self {
        Self {
            inner: Arc::new(BackendRuntimeInner {
                data_dir,
                backend_manifest_path,
                ocr_manifest_path,
                windowsml_ocr_manifest_path,
                config: Mutex::new(None),
                child: Mutex::new(None),
                job: Mutex::new(None),
            }),
        }
    }

    pub(crate) fn terminate_child_process_tree(&self) {
        self.inner.terminate_child_process_tree();
    }

    pub(crate) fn set_config(&self, config: BackendConfig) {
        if let Ok(mut current) = self.inner.config.lock() {
            *current = Some(config);
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

    pub(crate) fn try_launch_installed_backend(&self) -> Result<(), String> {
        let entrypoint = self
            .installed_entrypoint()
            .ok_or_else(|| "Python backend runtime is not installed.".to_string())?;
        launch_backend_entrypoint(&self.inner, &entrypoint)
    }

    pub(crate) fn start_installation(&self) -> DesktopRuntimeInstallation {
        if self.backend_config().is_some() {
            return completed_installation("Python backend runtime is already running.");
        }

        if let Some(job) = self.active_job() {
            return installation_from_job(job);
        }

        let job = RuntimeJob::queued();
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

fn resource_candidates(file_name: &str) -> [String; 2] {
    [file_name.to_string(), format!("resources/{file_name}")]
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
                "resources/backend-runtime-manifest.json".to_string()
            ]
        );
    }

    #[test]
    fn missing_runtime_status_is_installable() {
        let data_dir =
            std::env::temp_dir().join(format!("exam-prep-runtime-{}", uuid::Uuid::new_v4()));
        let state = BackendState::new(data_dir.clone(), None, None, None);

        let status = state.status();

        assert_eq!(status.status, "missing");
        assert_eq!(
            status.unavailable_reason,
            Some("python_runtime_missing".into())
        );
        assert!(!status.running);

        let _ = fs::remove_dir_all(data_dir);
    }
}
