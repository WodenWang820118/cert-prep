use std::{
    fs::{self, OpenOptions},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{atomic::Ordering, Arc},
    thread,
    time::{Duration, Instant},
};

use crate::{
    backend::{build_backend_config, BackendConfig, BackendRuntimeInner},
    capture_runtime::CaptureRuntimeConnection,
    windows_process::terminate_owned_process_tree,
};

const DEFAULT_BACKEND_READY_TIMEOUT_SECS: u64 = 60;
const FIXED_OLLAMA_MODEL: &str = "qwen3.5:4b";
const FIXED_OLLAMA_PROFILE_ID: &str = "auto";

pub(crate) fn launch_backend_entrypoint(
    inner: &Arc<BackendRuntimeInner>,
    entrypoint: &Path,
    capture_runtime: Option<&CaptureRuntimeConnection>,
    replace_existing: bool,
) -> Result<(), String> {
    // Startup probing, post-install launch, and Capture Runtime activation can
    // all request an owned backend. Serialize the full readiness-and-swap
    // transaction so a slower stale candidate can never replace a newer one.
    let _launch = inner
        .backend_launch
        .lock()
        .map_err(|_| "Backend launch state is unavailable.".to_string())?;
    if inner.closing.load(Ordering::SeqCst) {
        return Err("Cert Prep is closing; backend runtime was not launched.".into());
    }
    if inner
        .config
        .lock()
        .map_err(|_| "Backend configuration state is unavailable.".to_string())?
        .is_some()
        && !replace_existing
    {
        return Ok(());
    }

    let port = reserve_loopback_port()?;
    let token = uuid::Uuid::new_v4().to_string();
    fs::create_dir_all(&inner.data_dir)
        .map_err(|error| format!("failed to create app data directory: {error}"))?;

    let mut command = Command::new(entrypoint);
    command.current_dir(entrypoint.parent().unwrap_or_else(|| Path::new(".")));
    for env in backend_launch_env(&inner.data_dir, port, &token, capture_runtime) {
        command.env(env.name, env.value);
    }
    command
        .stdin(Stdio::null())
        .stdout(configured_log_stdio("backend.stdout.log"))
        .stderr(configured_log_stdio("backend.stderr.log"));

    command.env_remove("CERT_PREP_OLLAMA_FALLBACK_MODELS");
    forward_env(
        &mut command,
        "CERT_PREP_STREAMING_DRAFT_GENERATION_PAGE_LIMIT",
    );
    forward_env(&mut command, "CERT_PREP_STREAMING_DRAFT_WORKERS");

    let child = command
        .spawn()
        .map_err(|error| format!("failed to launch backend runtime: {error}"))?;
    if let Err(error) = wait_for_backend(port, backend_ready_timeout(), Some(&inner.closing)) {
        terminate_owned_process_tree(child);
        return Err(error);
    }

    if inner.closing.load(Ordering::SeqCst) {
        terminate_owned_process_tree(child);
        return Err("Cert Prep is closing; backend runtime was not launched.".into());
    }
    let mut config = match inner.config.lock() {
        Ok(config) => config,
        Err(_) => {
            terminate_owned_process_tree(child);
            return Err("Backend configuration state is unavailable.".into());
        }
    };
    let mut current_child = match inner.child.lock() {
        Ok(child_state) => child_state,
        Err(_) => {
            drop(config);
            terminate_owned_process_tree(child);
            return Err("Backend process state is unavailable.".into());
        }
    };
    if inner.closing.load(Ordering::SeqCst) {
        drop(current_child);
        drop(config);
        terminate_owned_process_tree(child);
        return Err("Cert Prep is closing; backend runtime was not launched.".into());
    }
    let old_child = current_child.replace(child);
    *config = Some(build_backend_config(
        format!("http://127.0.0.1:{port}"),
        token,
    ));
    drop(current_child);
    drop(config);
    if let Some(old_child) = old_child {
        terminate_owned_process_tree(old_child);
    }
    Ok(())
}

#[derive(PartialEq, Eq)]
struct BackendEnv {
    name: &'static str,
    value: String,
}

impl BackendEnv {
    fn new(name: &'static str, value: impl Into<String>) -> Self {
        Self {
            name,
            value: value.into(),
        }
    }
}

fn backend_launch_env(
    data_dir: &Path,
    port: u16,
    token: &str,
    capture_runtime: Option<&CaptureRuntimeConnection>,
) -> Vec<BackendEnv> {
    let mut environment = vec![
        BackendEnv::new("CERT_PREP_HOST", sidecar_host()),
        BackendEnv::new("CERT_PREP_PORT", port.to_string()),
        BackendEnv::new("CERT_PREP_API_TOKEN", token),
        BackendEnv::new("CERT_PREP_DATA_DIR", data_dir.to_string_lossy().to_string()),
        BackendEnv::new("CERT_PREP_LLM_PROVIDER", configured_llm_provider()),
        BackendEnv::new("CERT_PREP_OLLAMA_MODEL", FIXED_OLLAMA_MODEL),
        BackendEnv::new("CERT_PREP_OLLAMA_PROFILE_ENABLED", "true"),
        BackendEnv::new("CERT_PREP_OLLAMA_PROFILE_ID", FIXED_OLLAMA_PROFILE_ID),
        BackendEnv::new("CERT_PREP_STREAMING_DRAFT_GENERATION_ON_UPLOAD", "true"),
    ];
    if let Some(capture_runtime) = capture_runtime {
        environment.extend([
            BackendEnv::new(
                "CERT_PREP_CAPTURE_RUNTIME_URL",
                capture_runtime.base_url.clone(),
            ),
            BackendEnv::new(
                "CERT_PREP_CAPTURE_RUNTIME_TOKEN",
                capture_runtime.token.clone(),
            ),
            BackendEnv::new(
                "CERT_PREP_CAPTURE_RUNTIME_VERSION",
                capture_runtime.runtime_version.clone(),
            ),
            BackendEnv::new(
                "CERT_PREP_CAPTURE_RUNTIME_API_VERSION",
                capture_runtime.api_version.clone(),
            ),
            BackendEnv::new(
                "CERT_PREP_CAPTURE_DOCUMENT_SCHEMA_VERSION",
                capture_runtime.capture_document_schema_version.clone(),
            ),
        ]);
    }
    environment
}

fn reserve_loopback_port() -> Result<u16, String> {
    TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("failed to reserve backend port: {error}"))?
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("failed to read backend port: {error}"))
}

fn wait_for_backend(
    port: u16,
    timeout: Duration,
    cancelled: Option<&std::sync::atomic::AtomicBool>,
) -> Result<(), String> {
    let started_at = Instant::now();
    while started_at.elapsed() < timeout {
        if cancelled.is_some_and(|cancelled| cancelled.load(Ordering::SeqCst)) {
            return Err(
                "Cert Prep is closing; backend runtime readiness wait was cancelled.".into(),
            );
        }
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

fn configured_llm_provider() -> String {
    std::env::var("CERT_PREP_LLM_PROVIDER")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| matches!(value.as_str(), "auto" | "ollama"))
        .unwrap_or_else(|| "auto".to_string())
}

fn backend_ready_timeout() -> Duration {
    Duration::from_secs(
        std::env::var("CERT_PREP_BACKEND_READY_TIMEOUT_SECS")
            .ok()
            .and_then(|value| value.trim().parse::<u64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_BACKEND_READY_TIMEOUT_SECS),
    )
}

fn forward_env(command: &mut Command, name: &str) {
    if let Some(value) = trimmed_env_var(name) {
        command.env(name, value);
    }
}

fn configured_log_stdio(file_name: &str) -> Stdio {
    let Some(log_dir) = trimmed_env_var("CERT_PREP_BACKEND_LOG_DIR").map(PathBuf::from) else {
        return Stdio::null();
    };
    if fs::create_dir_all(&log_dir).is_err() {
        return Stdio::null();
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join(file_name))
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null())
}

fn trimmed_env_var(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(crate) fn external_backend_env() -> Option<BackendConfig> {
    match (
        std::env::var("CERT_PREP_BACKEND_URL"),
        std::env::var("CERT_PREP_BACKEND_TOKEN"),
    ) {
        (Ok(base_url), Ok(token)) => Some(build_backend_config(base_url, token)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Condvar, Mutex, MutexGuard};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn lock_env() -> MutexGuard<'static, ()> {
        ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn capture_runtime() -> CaptureRuntimeConnection {
        CaptureRuntimeConnection {
            base_url: "http://127.0.0.1:41001".into(),
            token: "capture-sidecar-test-token".into(),
            runtime_version: "0.3.8".into(),
            api_version: "1.0".into(),
            capture_document_schema_version: "1".into(),
        }
    }

    #[test]
    fn reserve_loopback_port_returns_bindable_port() {
        let port = reserve_loopback_port().expect("port should be reserved");

        assert!(port > 0);
    }

    #[test]
    fn backend_launch_waits_for_the_current_launch_transaction() {
        let root = std::env::temp_dir().join(format!(
            "cert-prep-backend-launch-lock-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("temp root");
        let inner = Arc::new(BackendRuntimeInner {
            data_dir: root.clone(),
            backend_manifest_path: None,
            capture_runtime_manifest_path: None,
            capture_runtime: Mutex::new(None),
            backend_launch: Mutex::new(()),
            config: Mutex::new(None),
            child: Mutex::new(None),
            job: Mutex::new(None),
            capture_job: Mutex::new(None),
            capture_start_active: Mutex::new(false),
            capture_start_complete: Condvar::new(),
            external_backend: Mutex::new(false),
            closing: std::sync::atomic::AtomicBool::new(false),
        });
        let current_launch = inner.backend_launch.lock().expect("launch lock");
        let launch_inner = Arc::clone(&inner);
        let missing_entrypoint = root.join("missing-backend.exe");
        let (result_tx, result_rx) = mpsc::channel();
        let launch_thread = thread::spawn(move || {
            let result = launch_backend_entrypoint(&launch_inner, &missing_entrypoint, None, false);
            result_tx.send(result).expect("launch result");
        });

        assert!(matches!(
            result_rx.recv_timeout(Duration::from_millis(100)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));

        drop(current_launch);
        let error = result_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("serialized launch should resume")
            .expect_err("missing backend must fail");
        launch_thread.join().expect("launch thread");

        assert!(error.contains("failed to launch backend runtime"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn sidecar_host_is_loopback_only() {
        assert_eq!(sidecar_host(), "127.0.0.1");
    }

    #[test]
    fn configured_llm_provider_defaults_to_auto_and_allows_explicit_providers() {
        let _env = lock_env();
        std::env::remove_var("CERT_PREP_LLM_PROVIDER");

        assert_eq!(configured_llm_provider(), "auto");

        std::env::set_var("CERT_PREP_LLM_PROVIDER", " ollama ");
        assert_eq!(configured_llm_provider(), "ollama");

        std::env::set_var("CERT_PREP_LLM_PROVIDER", " AUTO ");
        assert_eq!(configured_llm_provider(), "auto");

        std::env::set_var("CERT_PREP_LLM_PROVIDER", "retired-provider");
        assert_eq!(configured_llm_provider(), "auto");

        std::env::set_var("CERT_PREP_LLM_PROVIDER", "openai");
        assert_eq!(configured_llm_provider(), "auto");

        std::env::remove_var("CERT_PREP_LLM_PROVIDER");
    }

    #[test]
    fn backend_launch_env_collects_auditable_runtime_settings() {
        let _env = lock_env();
        std::env::remove_var("CERT_PREP_OLLAMA_MODEL");
        std::env::remove_var("CERT_PREP_LLM_PROVIDER");

        let env = backend_launch_env(
            Path::new("cert-prep-data"),
            8123,
            "test-token",
            Some(&capture_runtime()),
        );

        assert_eq!(env_value(&env, "CERT_PREP_HOST"), Some("127.0.0.1"));
        assert_eq!(env_value(&env, "CERT_PREP_PORT"), Some("8123"));
        assert_eq!(env_value(&env, "CERT_PREP_API_TOKEN"), Some("test-token"));
        assert_eq!(
            env_value(&env, "CERT_PREP_DATA_DIR"),
            Some("cert-prep-data")
        );
        assert_eq!(env_value(&env, "CERT_PREP_LLM_PROVIDER"), Some("auto"));
        assert_eq!(
            env_value(&env, "CERT_PREP_OLLAMA_MODEL"),
            Some(FIXED_OLLAMA_MODEL)
        );
        assert_eq!(
            env_value(&env, "CERT_PREP_OLLAMA_PROFILE_ENABLED"),
            Some("true")
        );
        assert_eq!(
            env_value(&env, "CERT_PREP_OLLAMA_PROFILE_ID"),
            Some(FIXED_OLLAMA_PROFILE_ID)
        );
        assert_eq!(
            env_value(&env, "CERT_PREP_STREAMING_DRAFT_GENERATION_ON_UPLOAD"),
            Some("true")
        );
        assert_eq!(
            env_value(&env, "CERT_PREP_CAPTURE_RUNTIME_URL"),
            Some("http://127.0.0.1:41001")
        );
        assert_eq!(
            env_value(&env, "CERT_PREP_CAPTURE_RUNTIME_TOKEN"),
            Some("capture-sidecar-test-token")
        );
        assert_eq!(
            env_value(&env, "CERT_PREP_CAPTURE_RUNTIME_VERSION"),
            Some("0.3.8")
        );
        assert_eq!(
            env_value(&env, "CERT_PREP_CAPTURE_RUNTIME_API_VERSION"),
            Some("1.0")
        );
        assert_eq!(
            env_value(&env, "CERT_PREP_CAPTURE_DOCUMENT_SCHEMA_VERSION"),
            Some("1")
        );
    }

    #[test]
    fn backend_launch_env_ignores_legacy_ollama_model_override() {
        let _env = lock_env();
        std::env::set_var("CERT_PREP_OLLAMA_MODEL", " qwen3.5:2b ");
        std::env::set_var("CERT_PREP_LLM_PROVIDER", "ollama");

        let env = backend_launch_env(
            Path::new("cert-prep-data"),
            8123,
            "test-token",
            Some(&capture_runtime()),
        );

        assert_eq!(env_value(&env, "CERT_PREP_LLM_PROVIDER"), Some("ollama"));
        assert_eq!(
            env_value(&env, "CERT_PREP_OLLAMA_MODEL"),
            Some(FIXED_OLLAMA_MODEL)
        );

        std::env::remove_var("CERT_PREP_OLLAMA_MODEL");
        std::env::remove_var("CERT_PREP_LLM_PROVIDER");
    }

    #[test]
    fn backend_launch_env_omits_capture_credentials_until_capture_runtime_starts() {
        let env = backend_launch_env(Path::new("cert-prep-data"), 8123, "test-token", None);

        for name in [
            "CERT_PREP_CAPTURE_RUNTIME_URL",
            "CERT_PREP_CAPTURE_RUNTIME_TOKEN",
            "CERT_PREP_CAPTURE_RUNTIME_VERSION",
            "CERT_PREP_CAPTURE_RUNTIME_API_VERSION",
            "CERT_PREP_CAPTURE_DOCUMENT_SCHEMA_VERSION",
        ] {
            assert_eq!(env_value(&env, name), None, "{name} must be absent");
        }
    }

    #[test]
    fn backend_ready_timeout_uses_positive_override_or_default() {
        let _env = lock_env();
        std::env::remove_var("CERT_PREP_BACKEND_READY_TIMEOUT_SECS");

        assert_eq!(backend_ready_timeout(), Duration::from_secs(60));

        std::env::set_var("CERT_PREP_BACKEND_READY_TIMEOUT_SECS", " 90 ");
        assert_eq!(backend_ready_timeout(), Duration::from_secs(90));

        std::env::set_var("CERT_PREP_BACKEND_READY_TIMEOUT_SECS", "0");
        assert_eq!(backend_ready_timeout(), Duration::from_secs(60));

        std::env::remove_var("CERT_PREP_BACKEND_READY_TIMEOUT_SECS");
    }

    #[test]
    fn external_backend_env_requires_url_and_token() {
        let _env = lock_env();
        std::env::remove_var("CERT_PREP_BACKEND_URL");
        std::env::remove_var("CERT_PREP_BACKEND_TOKEN");
        assert_eq!(external_backend_env(), None);

        std::env::set_var("CERT_PREP_BACKEND_URL", "http://127.0.0.1:5000");
        assert_eq!(external_backend_env(), None);

        std::env::set_var("CERT_PREP_BACKEND_TOKEN", "dev-token");
        assert_eq!(
            external_backend_env(),
            Some(build_backend_config("http://127.0.0.1:5000", "dev-token"))
        );

        std::env::remove_var("CERT_PREP_BACKEND_URL");
        std::env::remove_var("CERT_PREP_BACKEND_TOKEN");
    }

    fn env_value<'a>(env: &'a [BackendEnv], name: &str) -> Option<&'a str> {
        env.iter()
            .find(|item| item.name == name)
            .map(|item| item.value.as_str())
    }
}
