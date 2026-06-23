use std::{
    fs::{self, OpenOptions},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

use crate::{
    backend::{build_backend_config, BackendConfig, BackendRuntimeInner},
    windows_process::terminate_backend_process_tree,
};

const DEFAULT_OLLAMA_MODEL: &str = "qwen3.5:4b";
const DEFAULT_BACKEND_READY_TIMEOUT_SECS: u64 = 60;

pub(crate) fn launch_backend_entrypoint(
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
        .current_dir(entrypoint.parent().unwrap_or_else(|| Path::new(".")))
        .env("EXAM_PREP_HOST", sidecar_host())
        .env("EXAM_PREP_PORT", port.to_string())
        .env("EXAM_PREP_API_TOKEN", token.as_str())
        .env(
            "EXAM_PREP_DATA_DIR",
            inner.data_dir.to_string_lossy().to_string(),
        )
        .env("EXAM_PREP_LLM_PROVIDER", "ollama")
        .env("EXAM_PREP_OCR_PROVIDER", configured_ocr_provider())
        .env("EXAM_PREP_OCR_RUNTIME_MODE", "external")
        .env("EXAM_PREP_OCR_DEVICE", "auto")
        .env("EXAM_PREP_OCR_DIRECTML_DEVICE_ID", "-1")
        .env("EXAM_PREP_OCR_AMD_NPU_DEVICE_ID", configured_amd_npu_device_id())
        .env("EXAM_PREP_OCR_AMD_NPU_POLICY", configured_amd_npu_policy())
        .env("EXAM_PREP_OLLAMA_MODEL", configured_ollama_model())
        .env("EXAM_PREP_STREAMING_DRAFT_GENERATION_ON_UPLOAD", "true")
        .stdin(Stdio::null())
        .stdout(configured_log_stdio("backend.stdout.log"))
        .stderr(configured_log_stdio("backend.stderr.log"));

    forward_env(&mut command, "EXAM_PREP_OLLAMA_FALLBACK_MODELS");
    forward_env(&mut command, "EXAM_PREP_OCR_PAGE_WORKERS");
    forward_env(
        &mut command,
        "EXAM_PREP_STREAMING_DRAFT_GENERATION_PAGE_LIMIT",
    );
    forward_env(&mut command, "EXAM_PREP_STREAMING_DRAFT_WORKERS");

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
    if let Some(manifest_path) = inner
        .directml_ocr_manifest_path
        .as_ref()
        .filter(|path| path.is_file())
    {
        command.env(
            "EXAM_PREP_DIRECTML_OCR_RUNTIME_MANIFEST_PATH",
            manifest_path.to_string_lossy().to_string(),
        );
    }
    if let Some(manifest_path) = inner
        .amd_npu_ocr_manifest_path
        .as_ref()
        .filter(|path| path.is_file())
    {
        command.env(
            "EXAM_PREP_AMD_NPU_OCR_RUNTIME_MANIFEST_PATH",
            manifest_path.to_string_lossy().to_string(),
        );
    }
    let child = command
        .spawn()
        .map_err(|error| format!("failed to launch backend runtime: {error}"))?;
    if let Err(error) = wait_for_backend(port, backend_ready_timeout()) {
        terminate_backend_process_tree(child);
        return Err(error);
    }

    if let Ok(mut current_child) = inner.child.lock() {
        if let Some(old_child) = current_child.take() {
            terminate_backend_process_tree(old_child);
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

fn configured_ollama_model() -> String {
    std::env::var("EXAM_PREP_OLLAMA_MODEL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_OLLAMA_MODEL.to_string())
}

fn configured_ocr_provider() -> String {
    std::env::var("EXAM_PREP_OCR_PROVIDER")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| matches!(value.as_str(), "directml" | "paddle" | "amd_npu"))
        .unwrap_or_else(|| "directml".to_string())
}

fn configured_amd_npu_device_id() -> String {
    trimmed_env_var("EXAM_PREP_OCR_AMD_NPU_DEVICE_ID").unwrap_or_else(|| "auto".to_string())
}

fn configured_amd_npu_policy() -> String {
    trimmed_env_var("EXAM_PREP_OCR_AMD_NPU_POLICY")
        .map(|value| value.to_ascii_uppercase())
        .filter(|value| {
            matches!(
                value.as_str(),
                "DEFAULT"
                    | "MAX_EFFICIENCY"
                    | "MIN_OVERALL_POWER"
                    | "PREFER_NPU"
                    | "PREFER_GPU"
                    | "MAX_PERFORMANCE"
            )
        })
        .unwrap_or_else(|| "PREFER_NPU".to_string())
}

fn backend_ready_timeout() -> Duration {
    Duration::from_secs(
        std::env::var("EXAM_PREP_BACKEND_READY_TIMEOUT_SECS")
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
    let Some(log_dir) = trimmed_env_var("EXAM_PREP_BACKEND_LOG_DIR").map(PathBuf::from) else {
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
        std::env::var("EXAM_PREP_BACKEND_URL"),
        std::env::var("EXAM_PREP_BACKEND_TOKEN"),
    ) {
        (Ok(base_url), Ok(token)) => Some(build_backend_config(base_url, token)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn configured_ollama_model_uses_default_or_explicit_override() {
        std::env::remove_var("EXAM_PREP_OLLAMA_MODEL");

        assert_eq!(configured_ollama_model(), "qwen3.5:4b");

        std::env::set_var("EXAM_PREP_OLLAMA_MODEL", " qwen3.5:2b ");
        assert_eq!(configured_ollama_model(), "qwen3.5:2b");

        std::env::set_var("EXAM_PREP_OLLAMA_MODEL", " ");
        assert_eq!(configured_ollama_model(), "qwen3.5:4b");

        std::env::remove_var("EXAM_PREP_OLLAMA_MODEL");
    }

    #[test]
    fn configured_ocr_provider_defaults_to_directml_and_allows_explicit_overrides() {
        std::env::remove_var("EXAM_PREP_OCR_PROVIDER");

        assert_eq!(configured_ocr_provider(), "directml");

        std::env::set_var("EXAM_PREP_OCR_PROVIDER", " paddle ");
        assert_eq!(configured_ocr_provider(), "paddle");

        std::env::set_var("EXAM_PREP_OCR_PROVIDER", " AMD_NPU ");
        assert_eq!(configured_ocr_provider(), "amd_npu");

        std::env::set_var("EXAM_PREP_OCR_PROVIDER", "cpu");
        assert_eq!(configured_ocr_provider(), "directml");

        std::env::remove_var("EXAM_PREP_OCR_PROVIDER");
    }

    #[test]
    fn configured_amd_npu_policy_uses_supported_override_or_default() {
        std::env::remove_var("EXAM_PREP_OCR_AMD_NPU_POLICY");

        assert_eq!(configured_amd_npu_policy(), "PREFER_NPU");

        std::env::set_var("EXAM_PREP_OCR_AMD_NPU_POLICY", " min_overall_power ");
        assert_eq!(configured_amd_npu_policy(), "MIN_OVERALL_POWER");

        std::env::set_var("EXAM_PREP_OCR_AMD_NPU_POLICY", "cpu");
        assert_eq!(configured_amd_npu_policy(), "PREFER_NPU");

        std::env::remove_var("EXAM_PREP_OCR_AMD_NPU_POLICY");
    }

    #[test]
    fn backend_ready_timeout_uses_positive_override_or_default() {
        std::env::remove_var("EXAM_PREP_BACKEND_READY_TIMEOUT_SECS");

        assert_eq!(backend_ready_timeout(), Duration::from_secs(60));

        std::env::set_var("EXAM_PREP_BACKEND_READY_TIMEOUT_SECS", " 90 ");
        assert_eq!(backend_ready_timeout(), Duration::from_secs(90));

        std::env::set_var("EXAM_PREP_BACKEND_READY_TIMEOUT_SECS", "0");
        assert_eq!(backend_ready_timeout(), Duration::from_secs(60));

        std::env::remove_var("EXAM_PREP_BACKEND_READY_TIMEOUT_SECS");
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
}
