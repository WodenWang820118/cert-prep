use std::{
    fs,
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

use crate::{
    archives::extract_zip,
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
    if manifest
        .artifact
        .url
        .as_deref()
        .is_some_and(|url| !url.trim().is_empty())
    {
        return Err("Bundled Python backend runtime manifest must use url: null.".to_string());
    }
    let artifact_name = safe_relative_path(&manifest.artifact.file_name, "artifact file_name")?;
    if artifact_name.components().count() != 1 {
        return Err("Python backend runtime artifact file_name must be a plain file name.".into());
    }
    let artifact_path = manifest_path
        .parent()
        .ok_or_else(|| "Python backend runtime manifest has no resource directory.".to_string())?
        .join(artifact_name);

    update_job(
        inner,
        job_id,
        "running",
        "Verifying bundled Python backend runtime.",
        Some(manifest.artifact.bytes),
        Some(manifest.artifact.bytes),
        None,
    );
    verify_artifact(&artifact_path, &manifest.artifact)?;

    let runtime_root = inner.data_dir.join("runtimes");
    fs::create_dir_all(&runtime_root)
        .map_err(|error| format!("failed to create runtime root: {error}"))?;
    let extract_dir = runtime_root.join(format!(".python-backend-install-{job_id}"));
    if extract_dir.exists() {
        fs::remove_dir_all(&extract_dir)
            .map_err(|error| format!("failed to clean runtime extraction directory: {error}"))?;
    }
    fs::create_dir_all(&extract_dir)
        .map_err(|error| format!("failed to create runtime extraction directory: {error}"))?;
    if let Err(error) = extract_zip(&artifact_path, &extract_dir) {
        let _ = fs::remove_dir_all(&extract_dir);
        return Err(error);
    }

    let entrypoint_relative = match safe_relative_path(&manifest.entrypoint, "entrypoint") {
        Ok(path) => path,
        Err(error) => {
            let _ = fs::remove_dir_all(&extract_dir);
            return Err(error);
        }
    };
    let entrypoint = extract_dir.join(&entrypoint_relative);
    if !entrypoint.is_file() {
        let _ = fs::remove_dir_all(&extract_dir);
        return Err(format!(
            "Python backend runtime entrypoint was not found: {}",
            manifest.entrypoint
        ));
    }

    if let Err(error) = write_installed_manifest(&extract_dir, &manifest) {
        let _ = fs::remove_dir_all(&extract_dir);
        return Err(error);
    }
    let runtime_dir = runtime_root.join(BACKEND_RUNTIME_DIR);
    replace_runtime_directory(&extract_dir, &runtime_dir, job_id)?;
    Ok(runtime_dir.join(entrypoint_relative))
}

fn safe_relative_path<'a>(value: &'a str, label: &str) -> Result<&'a std::path::Path, String> {
    let path = std::path::Path::new(value);
    if value.trim().is_empty()
        || path.components().any(|component| {
            !matches!(component, std::path::Component::Normal(_))
                || component.as_os_str().to_string_lossy().contains(':')
        })
    {
        return Err(format!("Python backend runtime {label} is unsafe: {value}"));
    }
    Ok(path)
}

fn replace_runtime_directory(
    staging: &std::path::Path,
    destination: &std::path::Path,
    job_id: &str,
) -> Result<(), String> {
    let backup = destination.with_file_name(format!(".python-backend-backup-{job_id}"));
    if backup.exists() {
        fs::remove_dir_all(&backup)
            .map_err(|error| format!("failed to clean runtime backup: {error}"))?;
    }
    let had_previous = destination.exists();
    if had_previous {
        fs::rename(destination, &backup)
            .map_err(|error| format!("failed to stage existing Python backend runtime: {error}"))?;
    }
    if let Err(error) = fs::rename(staging, destination) {
        if had_previous {
            let _ = fs::rename(&backup, destination);
        }
        return Err(format!(
            "failed to atomically install Python backend runtime: {error}"
        ));
    }
    if had_previous {
        let _ = fs::remove_dir_all(backup);
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        capture_runtime::CaptureRuntimeConnection,
        manifests::{RuntimeArtifact, RuntimeManifest},
    };
    use sha2::{Digest, Sha256};
    use std::{io::Write, sync::Mutex};
    use zip::write::SimpleFileOptions;

    #[test]
    fn bundled_runtime_installs_from_manifest_sibling_and_replaces_old_runtime() {
        let root = temp_root();
        let resource_dir = root.join("resources");
        let data_dir = root.join("data");
        fs::create_dir_all(&resource_dir).expect("resources");
        let artifact_name = "cert-prep-backend-runtime-x86_64-pc-windows-msvc.zip";
        let artifact_path = resource_dir.join(artifact_name);
        write_runtime_zip(&artifact_path, "cert-prep-backend.exe", b"new-runtime");
        let bytes = fs::metadata(&artifact_path)
            .expect("artifact metadata")
            .len();
        let sha256 = hash_file(&artifact_path);
        let manifest = RuntimeManifest {
            kind: PYTHON_RUNTIME_KIND.into(),
            version: "0.1.0".into(),
            target: "x86_64-pc-windows-msvc".into(),
            entrypoint: "cert-prep-backend.exe".into(),
            artifact: RuntimeArtifact {
                file_name: artifact_name.into(),
                sha256,
                bytes,
                url: None,
            },
        };
        let manifest_path = resource_dir.join("backend-runtime-manifest.json");
        fs::write(
            &manifest_path,
            serde_json::to_string(&manifest).expect("manifest JSON"),
        )
        .expect("manifest");
        let old_runtime = data_dir.join("runtimes").join(BACKEND_RUNTIME_DIR);
        fs::create_dir_all(&old_runtime).expect("old runtime");
        fs::write(old_runtime.join("old.txt"), "old").expect("old marker");
        let inner = runtime_inner(data_dir.clone(), manifest_path);

        let entrypoint = install_python_runtime_inner(&inner, "test-job").expect("install");

        assert_eq!(fs::read(entrypoint).expect("entrypoint"), b"new-runtime");
        assert!(!old_runtime.join("old.txt").exists());
        assert!(old_runtime.join("runtime-manifest.json").is_file());
        assert!(artifact_path.is_file());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn bundled_runtime_rejects_remote_url_before_replacing_installed_runtime() {
        let root = temp_root();
        let resource_dir = root.join("resources");
        let data_dir = root.join("data");
        fs::create_dir_all(&resource_dir).expect("resources");
        let manifest = RuntimeManifest {
            kind: PYTHON_RUNTIME_KIND.into(),
            version: "0.1.0".into(),
            target: "x86_64-pc-windows-msvc".into(),
            entrypoint: "cert-prep-backend.exe".into(),
            artifact: RuntimeArtifact {
                file_name: "runtime.zip".into(),
                sha256: "0".repeat(64),
                bytes: 1,
                url: Some("https://example.test/runtime.zip".into()),
            },
        };
        let manifest_path = resource_dir.join("backend-runtime-manifest.json");
        fs::write(
            &manifest_path,
            serde_json::to_string(&manifest).expect("manifest JSON"),
        )
        .expect("manifest");
        let old_runtime = data_dir.join("runtimes").join(BACKEND_RUNTIME_DIR);
        fs::create_dir_all(&old_runtime).expect("old runtime");
        fs::write(old_runtime.join("old.txt"), "old").expect("old marker");
        let inner = runtime_inner(data_dir, manifest_path);

        let error = install_python_runtime_inner(&inner, "test-job").expect_err("reject URL");

        assert!(error.contains("must use url: null"));
        assert!(old_runtime.join("old.txt").is_file());
        let _ = fs::remove_dir_all(root);
    }

    fn runtime_inner(data_dir: PathBuf, manifest_path: PathBuf) -> BackendRuntimeInner {
        BackendRuntimeInner {
            data_dir,
            backend_manifest_path: Some(manifest_path),
            ocr_manifest_path: None,
            windowsml_ocr_manifest_path: None,
            capture_runtime: CaptureRuntimeConnection {
                base_url: "http://127.0.0.1:41001".into(),
                token: "capture-sidecar-test-token".into(),
                runtime_version: "0.1.0".into(),
                api_version: "1.0".into(),
                capture_document_schema_version: "1".into(),
            },
            config: Mutex::new(None),
            child: Mutex::new(None),
            job: Mutex::new(None),
        }
    }

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "cert-prep-runtime-install-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("temp root");
        root
    }

    fn write_runtime_zip(path: &std::path::Path, name: &str, content: &[u8]) {
        let file = fs::File::create(path).expect("runtime ZIP");
        let mut writer = zip::ZipWriter::new(file);
        writer
            .start_file(name, SimpleFileOptions::default())
            .expect("entry");
        writer.write_all(content).expect("content");
        writer.finish().expect("finish ZIP");
    }

    fn hash_file(path: &std::path::Path) -> String {
        let bytes = fs::read(path).expect("artifact bytes");
        format!("{:x}", Sha256::digest(bytes))
    }
}
