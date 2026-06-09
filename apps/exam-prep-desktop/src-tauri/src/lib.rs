use std::{
    net::{TcpListener, TcpStream},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{Manager, Runtime};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendConfig {
    pub base_url: String,
    pub token: String,
}

pub struct BackendState {
    config: BackendConfig,
    child: Mutex<Option<CommandChild>>,
}

pub fn build_backend_config(base_url: impl Into<String>, token: impl Into<String>) -> BackendConfig {
    BackendConfig {
        base_url: base_url.into(),
        token: token.into(),
    }
}

impl Drop for BackendState {
    fn drop(&mut self) {
        self.kill_child();
    }
}

impl BackendState {
    fn kill_child(&self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.take() {
                let _ = child.kill();
            }
        }
    }
}

#[tauri::command]
fn backend_config(state: tauri::State<'_, BackendState>) -> BackendConfig {
    state.config.clone()
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
    Err(format!("backend sidecar did not become ready on port {port}"))
}

fn launch_backend_sidecar<R: Runtime>(app: &tauri::App<R>) -> Result<BackendState, String> {
    if let Some(config) = external_backend_env() {
        return Ok(BackendState {
            config,
            child: Mutex::new(None),
        });
    }

    let port = reserve_loopback_port()?;
    let token = uuid::Uuid::new_v4().to_string();
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data directory: {error}"))?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|error| format!("failed to create app data directory: {error}"))?;

    let (_events, child) = app
        .shell()
        .sidecar("exam-prep-backend")
        .map_err(|error| format!("failed to create backend sidecar command: {error}"))?
        .env("EXAM_PREP_HOST", sidecar_host())
        .env("EXAM_PREP_PORT", port.to_string())
        .env("EXAM_PREP_API_TOKEN", token.as_str())
        .env("EXAM_PREP_DATA_DIR", data_dir.to_string_lossy().to_string())
        .spawn()
        .map_err(|error| format!("failed to launch backend sidecar: {error}"))?;

    if let Err(error) = wait_for_backend(port, Duration::from_secs(10)) {
        let _ = child.kill();
        return Err(error);
    }

    Ok(BackendState {
        config: build_backend_config(format!("http://127.0.0.1:{port}"), token),
        child: Mutex::new(Some(child)),
    })
}

fn sidecar_host() -> &'static str {
    "127.0.0.1"
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
            let backend = launch_backend_sidecar(app)?;
            app.manage(backend);
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(state) = window.try_state::<BackendState>() {
                    state.kill_child();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![backend_config])
        .run(tauri::generate_context!())
        .expect("failed to run exam prep desktop app");
}

#[cfg(test)]
mod tests {
    use super::*;

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
