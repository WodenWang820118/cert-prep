use std::{
    fs,
    net::{TcpListener, TcpStream},
    path::Path,
    process::{Command, Stdio},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

use crate::{
    backend::{build_backend_config, BackendConfig, BackendRuntimeInner},
    windows_process::terminate_backend_process_tree,
};

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
        .env("EXAM_PREP_OLLAMA_MODEL", "qwen3:14b")
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

    let child = command
        .spawn()
        .map_err(|error| format!("failed to launch backend runtime: {error}"))?;
    if let Err(error) = wait_for_backend(port, Duration::from_secs(10)) {
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
