mod archives;
mod backend;
mod backend_process;
mod capture_manifest;
mod capture_runtime;
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
use capture_runtime::{bundled_capture_runtime_paths, CaptureRuntimeState};
use constants::{
    BACKEND_RUNTIME_MANIFEST, CAPTURE_RUNTIME_MANIFEST, WINDOWSML_OCR_RUNTIME_MANIFEST,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = resolved_app_data_dir(app)?;
            fs::create_dir_all(&data_dir)
                .map_err(|error| format!("failed to create app data directory: {error}"))?;

            let (capture_manifest_path, capture_executable_path) =
                bundled_capture_runtime_paths(resource_path(app, CAPTURE_RUNTIME_MANIFEST))?;
            let capture_state = CaptureRuntimeState::launch(
                &capture_manifest_path,
                &capture_executable_path,
                &data_dir,
            )?;

            let state = BackendState::new(
                data_dir,
                resource_path(app, BACKEND_RUNTIME_MANIFEST),
                None,
                resource_path(app, WINDOWSML_OCR_RUNTIME_MANIFEST),
                capture_state.connection(),
            );
            if let Some(config) = external_backend_env() {
                state.set_config(config);
            } else {
                let launch_result = state.try_launch_installed_backend();
                if launch_result.is_err() && package_qa_auto_install_enabled() {
                    state.start_installation();
                }
            }
            app.manage(capture_state);
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
                if let Some(state) = window.try_state::<CaptureRuntimeState>() {
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
        .expect("failed to run cert prep desktop app");
}

fn package_qa_auto_install_enabled() -> bool {
    std::env::var("CERT_PREP_PACKAGE_QA_AUTO_INSTALL_BUNDLED_BACKEND")
        .ok()
        .as_deref()
        .is_some_and(package_qa_auto_install_value)
}

fn package_qa_auto_install_value(value: &str) -> bool {
    value.trim().eq_ignore_ascii_case("true")
}

fn resolved_app_data_dir(app: &tauri::App) -> Result<PathBuf, String> {
    if let Ok(value) = std::env::var("CERT_PREP_DESKTOP_DATA_DIR") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    app.path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data directory: {error}"))
}

#[cfg(test)]
mod tests {
    use super::package_qa_auto_install_value;

    #[test]
    fn bundled_backend_auto_install_is_explicitly_qa_only() {
        assert!(package_qa_auto_install_value(" true "));
        assert!(!package_qa_auto_install_value("1"));
        assert!(!package_qa_auto_install_value("false"));
    }
}
