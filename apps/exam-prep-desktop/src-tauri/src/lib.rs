mod archives;
mod backend;
mod backend_process;
mod commands;
mod constants;
mod manifests;
mod runtime_installation;
mod windows_process;

use std::{fs, path::PathBuf};
use tauri::Manager;

pub use backend::{build_backend_config, BackendConfig, BackendState, DesktopRuntimeStatus};
pub use runtime_installation::DesktopRuntimeInstallation;

use backend::resource_path;
use backend_process::external_backend_env;
use constants::{BACKEND_RUNTIME_MANIFEST, OCR_RUNTIME_MANIFEST};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let data_dir = resolved_app_data_dir(app)?;
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
            if matches!(
                event,
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
            ) {
                if let Some(state) = window.try_state::<BackendState>() {
                    state.terminate_child_process_tree();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::backend_config,
            commands::desktop_runtime_status,
            commands::start_python_runtime_installation,
            commands::get_python_runtime_installation
        ])
        .run(tauri::generate_context!())
        .expect("failed to run exam prep desktop app");
}

fn resolved_app_data_dir(app: &tauri::App) -> Result<PathBuf, String> {
    if let Ok(value) = std::env::var("EXAM_PREP_DESKTOP_DATA_DIR") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    app.path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data directory: {error}"))
}
