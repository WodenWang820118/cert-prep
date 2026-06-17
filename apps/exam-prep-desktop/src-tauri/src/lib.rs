use std::{
    fs,
    io::Read,
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::path::BaseDirectory;
use tauri::{Manager, Runtime};

const PYTHON_RUNTIME_KIND: &str = "python_backend";
const PYTHON_RUNTIME_LABEL: &str = "Python backend runtime";
const BACKEND_RUNTIME_DIR: &str = "python_backend";
const BACKEND_RUNTIME_MANIFEST: &str = "backend-runtime-manifest.json";
const OCR_RUNTIME_MANIFEST: &str = "ocr-runtime-manifest.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BackendConfig {
    pub base_url: String,
    pub token: String,
}

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

#[derive(Debug, Clone, Deserialize, Serialize)]
struct RuntimeManifest {
    kind: String,
    version: String,
    target: String,
    entrypoint: String,
    artifact: RuntimeArtifact,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct RuntimeArtifact {
    file_name: String,
    sha256: String,
    bytes: u64,
    url: Option<String>,
}

#[derive(Debug, Clone)]
struct RuntimeJob {
    id: String,
    status: String,
    detail: String,
    completed: Option<u64>,
    total: Option<u64>,
    created_at: String,
    updated_at: String,
    error: Option<String>,
}

struct BackendRuntimeInner {
    data_dir: PathBuf,
    backend_manifest_path: Option<PathBuf>,
    ocr_manifest_path: Option<PathBuf>,
    config: Mutex<Option<BackendConfig>>,
    child: Mutex<Option<Child>>,
    job: Mutex<Option<RuntimeJob>>,
}

#[derive(Clone)]
pub struct BackendState {
    inner: Arc<BackendRuntimeInner>,
}

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
        self.kill_child();
    }
}

impl BackendRuntimeInner {
    fn kill_child(&self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut child) = child.take() {
                let _ = child.kill();
            }
        }
    }
}

impl BackendState {
    fn new(
        data_dir: PathBuf,
        backend_manifest_path: Option<PathBuf>,
        ocr_manifest_path: Option<PathBuf>,
    ) -> Self {
        Self {
            inner: Arc::new(BackendRuntimeInner {
                data_dir,
                backend_manifest_path,
                ocr_manifest_path,
                config: Mutex::new(None),
                child: Mutex::new(None),
                job: Mutex::new(None),
            }),
        }
    }

    fn set_config(&self, config: BackendConfig) {
        if let Ok(mut current) = self.inner.config.lock() {
            *current = Some(config);
        }
    }

    fn backend_config(&self) -> Option<BackendConfig> {
        self.inner
            .config
            .lock()
            .ok()
            .and_then(|config| config.clone())
    }

    fn status(&self) -> DesktopRuntimeStatus {
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

    fn active_job(&self) -> Option<RuntimeJob> {
        self.inner.job.lock().ok().and_then(|job| {
            job.as_ref()
                .filter(|job| matches!(job.status.as_str(), "queued" | "running"))
                .cloned()
        })
    }

    fn installed_runtime_dir(&self) -> PathBuf {
        self.inner
            .data_dir
            .join("runtimes")
            .join(BACKEND_RUNTIME_DIR)
    }

    fn installed_manifest_path(&self) -> PathBuf {
        self.installed_runtime_dir().join("runtime-manifest.json")
    }

    fn installed_manifest(&self) -> Option<RuntimeManifest> {
        load_runtime_manifest(&self.installed_manifest_path()).ok()
    }

    fn installed_entrypoint(&self) -> Option<PathBuf> {
        let manifest = self.installed_manifest()?;
        let entrypoint = self.installed_runtime_dir().join(manifest.entrypoint);
        entrypoint.is_file().then_some(entrypoint)
    }

    fn try_launch_installed_backend(&self) -> Result<(), String> {
        let entrypoint = self
            .installed_entrypoint()
            .ok_or_else(|| "Python backend runtime is not installed.".to_string())?;
        launch_backend_entrypoint(&self.inner, &entrypoint)
    }

    fn start_installation(&self) -> DesktopRuntimeInstallation {
        if self.backend_config().is_some() {
            return completed_installation("Python backend runtime is already running.");
        }

        if let Some(job) = self.active_job() {
            return installation_from_job(job);
        }

        let job = RuntimeJob {
            id: uuid::Uuid::new_v4().to_string(),
            status: "queued".into(),
            detail: "Python backend runtime installation queued.".into(),
            completed: None,
            total: None,
            created_at: now_string(),
            updated_at: now_string(),
            error: None,
        };
        let job_id = job.id.clone();
        if let Ok(mut current) = self.inner.job.lock() {
            *current = Some(job.clone());
        }

        let inner = Arc::clone(&self.inner);
        thread::spawn(move || install_python_runtime(inner, job_id));
        installation_from_job(job)
    }

    fn get_installation(&self, job_id: &str) -> Result<DesktopRuntimeInstallation, String> {
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

#[tauri::command]
fn backend_config(state: tauri::State<'_, BackendState>) -> Result<BackendConfig, String> {
    state
        .backend_config()
        .ok_or_else(|| "Desktop backend runtime is not ready.".to_string())
}

#[tauri::command]
fn desktop_runtime_status(state: tauri::State<'_, BackendState>) -> DesktopRuntimeStatus {
    state.status()
}

#[tauri::command]
fn start_python_runtime_installation(
    state: tauri::State<'_, BackendState>,
) -> DesktopRuntimeInstallation {
    state.start_installation()
}

#[tauri::command]
fn get_python_runtime_installation(
    job_id: String,
    state: tauri::State<'_, BackendState>,
) -> Result<DesktopRuntimeInstallation, String> {
    state.get_installation(&job_id)
}

fn install_python_runtime(inner: Arc<BackendRuntimeInner>, job_id: String) {
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

fn launch_backend_entrypoint(
    inner: &Arc<BackendRuntimeInner>,
    entrypoint: &Path,
) -> Result<(), String> {
    if inner
        .config
        .lock()
        .ok()
        .and_then(|config| config.clone())
        .is_some()
    {
        return Ok(());
    }

    let port = reserve_loopback_port()?;
    let token = uuid::Uuid::new_v4().to_string();
    fs::create_dir_all(&inner.data_dir)
        .map_err(|error| format!("failed to create app data directory: {error}"))?;

    let mut command = Command::new(entrypoint);
    command
        .env("EXAM_PREP_HOST", sidecar_host())
        .env("EXAM_PREP_PORT", port.to_string())
        .env("EXAM_PREP_API_TOKEN", token.as_str())
        .env(
            "EXAM_PREP_DATA_DIR",
            inner.data_dir.to_string_lossy().to_string(),
        )
        .env("EXAM_PREP_LLM_PROVIDER", "ollama")
        .env("EXAM_PREP_OCR_PROVIDER", "paddle")
        .env("EXAM_PREP_OCR_RUNTIME_MODE", "external")
        .env("EXAM_PREP_OCR_DEVICE", "auto")
        .env("EXAM_PREP_OLLAMA_MODEL", "gemma4:12b")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    if let Some(manifest_path) = inner
        .ocr_manifest_path
        .as_ref()
        .filter(|path| path.is_file())
    {
        command.env(
            "EXAM_PREP_OCR_RUNTIME_MANIFEST_PATH",
            manifest_path.to_string_lossy().to_string(),
        );
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to launch backend runtime: {error}"))?;
    if let Err(error) = wait_for_backend(port, Duration::from_secs(10)) {
        let _ = child.kill();
        return Err(error);
    }

    if let Ok(mut current_child) = inner.child.lock() {
        if let Some(mut old_child) = current_child.take() {
            let _ = old_child.kill();
        }
        *current_child = Some(child);
    }
    if let Ok(mut config) = inner.config.lock() {
        *config = Some(build_backend_config(
            format!("http://127.0.0.1:{port}"),
            token,
        ));
    }
    Ok(())
}

fn reserve_loopback_port() -> Result<u16, String> {
    TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("failed to reserve backend port: {error}"))?
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("failed to read backend port: {error}"))
}

fn wait_for_backend(port: u16, timeout: Duration) -> Result<(), String> {
    let started_at = Instant::now();
    while started_at.elapsed() < timeout {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err(format!(
        "backend runtime did not become ready on port {port}"
    ))
}

fn sidecar_host() -> &'static str {
    "127.0.0.1"
}

fn load_runtime_manifest(path: &Path) -> Result<RuntimeManifest, String> {
    let content = fs::read_to_string(path).map_err(|error| {
        format!(
            "failed to read runtime manifest {}: {error}",
            path.display()
        )
    })?;
    serde_json::from_str(&content).map_err(|error| {
        format!(
            "failed to parse runtime manifest {}: {error}",
            path.display()
        )
    })
}

fn write_installed_manifest(runtime_dir: &Path, manifest: &RuntimeManifest) -> Result<(), String> {
    let path = runtime_dir.join("runtime-manifest.json");
    let content = serde_json::to_string_pretty(manifest)
        .map_err(|error| format!("failed to serialize runtime manifest: {error}"))?;
    fs::write(path, format!("{content}\n"))
        .map_err(|error| format!("failed to write installed runtime manifest: {error}"))
}

fn download_artifact(url: &str, destination: &Path) -> Result<(), String> {
    if let Some(path) = url.strip_prefix("file://") {
        fs::copy(Path::new(path), destination)
            .map(|_| ())
            .map_err(|error| format!("failed to copy runtime artifact: {error}"))
    } else if Path::new(url).is_file() {
        fs::copy(Path::new(url), destination)
            .map(|_| ())
            .map_err(|error| format!("failed to copy runtime artifact: {error}"))
    } else if url.starts_with("http://") || url.starts_with("https://") {
        powershell(&format!(
            "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '{}' -OutFile '{}'",
            ps_quote(url),
            ps_quote(&destination.display().to_string())
        ))
        .map_err(|error| format!("failed to download runtime artifact: {error}"))
    } else {
        Err(format!("unsupported runtime artifact URL: {url}"))
    }
}

fn verify_artifact(path: &Path, artifact: &RuntimeArtifact) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|error| {
        format!(
            "failed to stat runtime artifact {}: {error}",
            path.display()
        )
    })?;
    if metadata.len() != artifact.bytes {
        return Err(format!(
            "runtime artifact size mismatch: expected {}, found {}",
            artifact.bytes,
            metadata.len()
        ));
    }

    let digest = sha256_file(path)?;
    if digest.to_lowercase() != artifact.sha256.to_lowercase() {
        return Err("runtime artifact checksum mismatch.".into());
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| {
        format!(
            "failed to open runtime artifact {}: {error}",
            path.display()
        )
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("failed to read runtime artifact: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn extract_zip(artifact: &Path, destination: &Path) -> Result<(), String> {
    powershell(&format!(
        "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
        ps_quote(&artifact.display().to_string()),
        ps_quote(&destination.display().to_string())
    ))
    .map_err(|error| format!("failed to extract runtime artifact: {error}"))
}

fn powershell(script: &str) -> Result<(), String> {
    let output = Command::new(powershell_executable())
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Err(if stderr.is_empty() { stdout } else { stderr })
}

fn powershell_executable() -> PathBuf {
    ["SystemRoot", "WINDIR"]
        .iter()
        .filter_map(|key| std::env::var(key).ok())
        .map(|root| {
            PathBuf::from(root)
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe")
        })
        .find(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("powershell.exe"))
}

fn ps_quote(value: &str) -> String {
    value.replace('\'', "''")
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

fn installation_from_job(job: RuntimeJob) -> DesktopRuntimeInstallation {
    DesktopRuntimeInstallation {
        id: job.id,
        kind: PYTHON_RUNTIME_KIND.into(),
        provider: "pyinstaller".into(),
        model: "exam-prep-backend".into(),
        status: job.status,
        detail: job.detail,
        completed: job.completed,
        total: job.total,
        created_at: job.created_at,
        updated_at: job.updated_at,
        error: job.error,
    }
}

fn completed_installation(detail: &str) -> DesktopRuntimeInstallation {
    let now = now_string();
    DesktopRuntimeInstallation {
        id: uuid::Uuid::new_v4().to_string(),
        kind: PYTHON_RUNTIME_KIND.into(),
        provider: "pyinstaller".into(),
        model: "exam-prep-backend".into(),
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

fn resource_path<R: Runtime>(app: &tauri::App<R>, file_name: &str) -> Option<PathBuf> {
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

fn external_backend_env() -> Option<BackendConfig> {
    match (
        std::env::var("EXAM_PREP_BACKEND_URL"),
        std::env::var("EXAM_PREP_BACKEND_TOKEN"),
    ) {
        (Ok(base_url), Ok(token)) => Some(build_backend_config(base_url, token)),
        _ => None,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("failed to resolve app data directory: {error}"))?;
            fs::create_dir_all(&data_dir)
                .map_err(|error| format!("failed to create app data directory: {error}"))?;

            let state = BackendState::new(
                data_dir,
                resource_path(app, BACKEND_RUNTIME_MANIFEST),
                resource_path(app, OCR_RUNTIME_MANIFEST),
            );
            if let Some(config) = external_backend_env() {
                state.set_config(config);
            } else {
                let _ = state.try_launch_installed_backend();
            }
            app.manage(state);
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(state) = window.try_state::<BackendState>() {
                    state.inner.kill_child();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            backend_config,
            desktop_runtime_status,
            start_python_runtime_installation,
            get_python_runtime_installation
        ])
        .run(tauri::generate_context!())
        .expect("failed to run exam prep desktop app");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

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
    fn reserve_loopback_port_returns_bindable_port() {
        let port = reserve_loopback_port().expect("port should be reserved");

        assert!(port > 0);
    }

    #[test]
    fn sidecar_host_is_loopback_only() {
        assert_eq!(sidecar_host(), "127.0.0.1");
    }

    #[test]
    fn external_backend_env_requires_url_and_token() {
        std::env::remove_var("EXAM_PREP_BACKEND_URL");
        std::env::remove_var("EXAM_PREP_BACKEND_TOKEN");
        assert_eq!(external_backend_env(), None);

        std::env::set_var("EXAM_PREP_BACKEND_URL", "http://127.0.0.1:5000");
        assert_eq!(external_backend_env(), None);

        std::env::set_var("EXAM_PREP_BACKEND_TOKEN", "dev-token");
        assert_eq!(
            external_backend_env(),
            Some(build_backend_config("http://127.0.0.1:5000", "dev-token"))
        );

        std::env::remove_var("EXAM_PREP_BACKEND_URL");
        std::env::remove_var("EXAM_PREP_BACKEND_TOKEN");
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
    fn sha256_file_hashes_artifact_bytes() {
        let path =
            std::env::temp_dir().join(format!("exam-prep-hash-{}.txt", uuid::Uuid::new_v4()));
        let mut file = fs::File::create(&path).expect("temp file");
        file.write_all(b"runtime").expect("write");

        assert_eq!(
            sha256_file(&path).expect("hash"),
            "d92c6a81b2ff50096bcda80885427d1f59a25b5f483f7055523504925d16ab23"
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn powershell_executable_prefers_windows_absolute_path() {
        let executable = powershell_executable();

        if let Ok(root) = std::env::var("SystemRoot") {
            let expected = PathBuf::from(root)
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe");
            if expected.is_file() {
                assert_eq!(executable, expected);
                return;
            }
        }

        assert_eq!(executable, PathBuf::from("powershell.exe"));
    }

    #[test]
    fn missing_runtime_status_is_installable() {
        let data_dir =
            std::env::temp_dir().join(format!("exam-prep-runtime-{}", uuid::Uuid::new_v4()));
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
}
