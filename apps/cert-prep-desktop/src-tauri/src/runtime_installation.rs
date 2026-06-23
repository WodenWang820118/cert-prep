use std::{
    fs,
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

use crate::{
    archives::{download_artifact, extract_zip},
    backend::BackendRuntimeInner,
    backend_process::launch_backend_entrypoint,
    constants::{BACKEND_RUNTIME_DIR, PYTHON_RUNTIME_KIND},
    manifests::{load_runtime_manifest, verify_artifact, write_installed_manifest},
};

/// Runtime installation job state returned to Angular during install polling.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRuntimeInstallation {
    pub id: String,
    pub kind: String,
    pub provider: String,
    pub model: String,
    pub status: String,
    pub detail: String,
    pub completed: Option<u64>,
    pub total: Option<u64>,
    pub created_at: String,
    pub updated_at: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct RuntimeJob {
    pub(crate) id: String,
    pub(crate) status: String,
    pub(crate) detail: String,
    pub(crate) completed: Option<u64>,
    pub(crate) total: Option<u64>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) error: Option<String>,
}

impl RuntimeJob {
    pub(crate) fn queued() -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            status: "queued".into(),
            detail: "Python backend runtime installation queued.".into(),
            completed: None,
            total: None,
            created_at: now_string(),
            updated_at: now_string(),
            error: None,
        }
    }
}

pub(crate) fn install_python_runtime(inner: Arc<BackendRuntimeInner>, job_id: String) {
    update_job(
        &inner,
        &job_id,
        "running",
        "Resolving Python backend runtime manifest.",
        None,
        None,
        None,
    );

    let result = install_python_runtime_inner(&inner, &job_id).and_then(|entrypoint| {
        update_job(
            &inner,
            &job_id,
            "running",
            "Launching Python backend runtime.",
            None,
            None,
            None,
        );
        launch_backend_entrypoint(&inner, &entrypoint)
    });

    match result {
        Ok(()) => update_job(
            &inner,
            &job_id,
            "succeeded",
            "Python backend runtime is ready.",
            None,
            None,
            None,
        ),
        Err(error) => {
            let detail = error.clone();
            update_job(&inner, &job_id, "failed", &detail, None, None, Some(error));
        }
    }
}

fn install_python_runtime_inner(
    inner: &BackendRuntimeInner,
    job_id: &str,
) -> Result<PathBuf, String> {
    let manifest_path = inner
        .backend_manifest_path
        .as_ref()
        .filter(|path| path.is_file())
        .ok_or_else(|| "Python backend runtime manifest is not bundled.".to_string())?;
    let manifest = load_runtime_manifest(manifest_path)?;
    if manifest.kind != PYTHON_RUNTIME_KIND {
        return Err(format!(
            "Unsupported runtime manifest kind: {}",
            manifest.kind
        ));
    }
    let source_url = manifest
        .artifact
        .url
        .as_ref()
        .filter(|url| !url.trim().is_empty())
        .ok_or_else(|| "Python backend runtime manifest is missing a release URL.".to_string())?;

    let download_dir = inner.data_dir.join("runtime-downloads");
    fs::create_dir_all(&download_dir)
        .map_err(|error| format!("failed to create runtime download directory: {error}"))?;
    let artifact_path = download_dir.join(&manifest.artifact.file_name);

    update_job(
        inner,
        job_id,
        "running",
        "Downloading Python backend runtime.",
        Some(0),
        Some(manifest.artifact.bytes),
        None,
    );
    download_artifact(source_url, &artifact_path)?;

    update_job(
        inner,
        job_id,
        "running",
        "Verifying Python backend runtime.",
        Some(manifest.artifact.bytes),
        Some(manifest.artifact.bytes),
        None,
    );
    verify_artifact(&artifact_path, &manifest.artifact)?;

    let extract_dir = download_dir.join(format!("extract-{}", job_id));
    if extract_dir.exists() {
        fs::remove_dir_all(&extract_dir)
            .map_err(|error| format!("failed to clean runtime extraction directory: {error}"))?;
    }
    fs::create_dir_all(&extract_dir)
        .map_err(|error| format!("failed to create runtime extraction directory: {error}"))?;
    extract_zip(&artifact_path, &extract_dir)?;

    let entrypoint = extract_dir.join(&manifest.entrypoint);
    if !entrypoint.is_file() {
        return Err(format!(
            "Python backend runtime entrypoint was not found: {}",
            manifest.entrypoint
        ));
    }

    let runtime_dir = inner.data_dir.join("runtimes").join(BACKEND_RUNTIME_DIR);
    if runtime_dir.exists() {
        fs::remove_dir_all(&runtime_dir)
            .map_err(|error| format!("failed to replace Python backend runtime: {error}"))?;
    }
    fs::create_dir_all(
        runtime_dir
            .parent()
            .ok_or_else(|| "runtime directory has no parent".to_string())?,
    )
    .map_err(|error| format!("failed to create runtime root: {error}"))?;
    fs::rename(&extract_dir, &runtime_dir)
        .map_err(|error| format!("failed to install Python backend runtime: {error}"))?;
    write_installed_manifest(&runtime_dir, &manifest)?;
    Ok(runtime_dir.join(manifest.entrypoint))
}

fn update_job(
    inner: &BackendRuntimeInner,
    job_id: &str,
    status: &str,
    detail: &str,
    completed: Option<u64>,
    total: Option<u64>,
    error: Option<String>,
) {
    if let Ok(mut current) = inner.job.lock() {
        if let Some(job) = current.as_mut().filter(|job| job.id == job_id) {
            job.status = status.into();
            job.detail = detail.into();
            if completed.is_some() {
                job.completed = completed;
            }
            if total.is_some() {
                job.total = total;
            }
            job.error = error;
            job.updated_at = now_string();
        }
    }
}

pub(crate) fn installation_from_job(job: RuntimeJob) -> DesktopRuntimeInstallation {
    DesktopRuntimeInstallation {
        id: job.id,
        kind: PYTHON_RUNTIME_KIND.into(),
        provider: "pyinstaller".into(),
        model: "cert-prep-backend".into(),
        status: job.status,
        detail: job.detail,
        completed: job.completed,
        total: job.total,
        created_at: job.created_at,
        updated_at: job.updated_at,
        error: job.error,
    }
}

pub(crate) fn completed_installation(detail: &str) -> DesktopRuntimeInstallation {
    let now = now_string();
    DesktopRuntimeInstallation {
        id: uuid::Uuid::new_v4().to_string(),
        kind: PYTHON_RUNTIME_KIND.into(),
        provider: "pyinstaller".into(),
        model: "cert-prep-backend".into(),
        status: "succeeded".into(),
        detail: detail.into(),
        completed: None,
        total: None,
        created_at: now.clone(),
        updated_at: now,
        error: None,
    }
}

fn now_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".into())
}
