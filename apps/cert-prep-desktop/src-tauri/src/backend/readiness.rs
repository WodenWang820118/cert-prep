use std::path::PathBuf;

use serde::Serialize;

use crate::{
    capture_runtime::{CaptureRuntimeConnection, CaptureRuntimeState},
    constants::{CAPTURE_RUNTIME_VERSION, PYTHON_RUNTIME_KIND, PYTHON_RUNTIME_LABEL},
    manifests::RuntimeManifest,
    runtime_installation::RuntimeJob,
    runtime_update::{RuntimeUpdateNotice, RuntimeUpdates},
};

use super::BackendState;

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

impl BackendState {
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
            error: self.failed_job_error(),
        }
    }

    pub(crate) fn active_job(&self) -> Option<RuntimeJob> {
        self.inner.job.lock().ok().and_then(|job| {
            job.as_ref()
                .filter(|job| matches!(job.status.as_str(), "queued" | "running"))
                .cloned()
        })
    }

    fn installed_manifest(&self) -> Option<RuntimeManifest> {
        self.inner.installed_backend().map(|(_, manifest)| manifest)
    }

    pub(crate) fn installed_entrypoint(&self) -> Option<PathBuf> {
        self.inner.installed_backend_entrypoint()
    }

    fn failed_job_error(&self) -> Option<String> {
        self.inner.job.lock().ok().and_then(|job| {
            job.as_ref()
                .filter(|job| job.status == "failed")
                .and_then(|job| job.error.clone())
        })
    }

    pub(crate) fn capture_runtime_connection(
        &self,
    ) -> Result<Option<CaptureRuntimeConnection>, String> {
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
                    self.inner.installed_capture_runtime_paths().is_ok(),
                    false,
                    &job.status,
                    &job.detail,
                    unavailable_reason,
                    Some(job.clone()),
                    job.error,
                );
            }
        }

        if self.inner.installed_capture_runtime_paths().is_ok() {
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

    pub(crate) fn capture_job(&self) -> Option<RuntimeJob> {
        self.inner
            .capture_job
            .lock()
            .ok()
            .and_then(|job| job.clone())
    }

    pub(crate) fn runtime_update_notice(&self) -> RuntimeUpdateNotice {
        self.inner
            .runtime_updates
            .lock()
            .map(|updates| updates.notice())
            .unwrap_or_else(|_| RuntimeUpdates::default().notice())
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
        version: Some(CAPTURE_RUNTIME_VERSION.into()),
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

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
