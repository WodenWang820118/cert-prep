use crate::{
    backend::{BackendConfig, BackendState, DesktopRuntimeStatus},
    DesktopRuntimeInstallation,
};

/// Returns the backend URL and token once the desktop runtime is ready.
#[tauri::command]
pub fn backend_config(state: tauri::State<'_, BackendState>) -> Result<BackendConfig, String> {
    state
        .backend_config()
        .ok_or_else(|| "Desktop backend runtime is not ready.".to_string())
}

/// Reports the packaged Python backend runtime status for the desktop shell.
#[tauri::command]
pub fn desktop_runtime_status(state: tauri::State<'_, BackendState>) -> DesktopRuntimeStatus {
    state.status()
}

/// Starts the packaged Python backend runtime installation job.
#[tauri::command]
pub fn start_python_runtime_installation(
    state: tauri::State<'_, BackendState>,
) -> DesktopRuntimeInstallation {
    state.start_installation()
}

/// Returns the current state for a packaged Python runtime installation job.
#[tauri::command]
pub fn get_python_runtime_installation(
    job_id: String,
    state: tauri::State<'_, BackendState>,
) -> Result<DesktopRuntimeInstallation, String> {
    state.get_installation(&job_id)
}

/// Reports whether the optional Capture Runtime is missing, installed, starting, or running.
#[tauri::command]
pub fn capture_runtime_status(state: tauri::State<'_, BackendState>) -> DesktopRuntimeStatus {
    state.capture_runtime_status()
}

/// Verifies and stages the bundled Capture Runtime without launching it.
#[tauri::command]
pub fn install_capture_runtime(
    state: tauri::State<'_, BackendState>,
) -> DesktopRuntimeInstallation {
    state.start_capture_runtime_installation()
}

/// Starts an already verified Capture Runtime and rotates the owned backend connection.
#[tauri::command]
pub fn start_capture_runtime(state: tauri::State<'_, BackendState>) -> DesktopRuntimeInstallation {
    state.start_installed_capture_runtime()
}

/// Returns the current explicit Capture Runtime install/start job.
#[tauri::command]
pub fn get_capture_runtime_installation(
    job_id: String,
    state: tauri::State<'_, BackendState>,
) -> Result<DesktopRuntimeInstallation, String> {
    state.get_capture_runtime_installation(&job_id)
}
