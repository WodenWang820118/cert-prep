mod archives;
mod backend;
mod backend_process;
mod capture_manifest;
mod capture_runtime;
mod commands;
mod constants;
mod manifests;
mod runtime_installation;

use std::{fs, path::PathBuf, thread};
use tauri::Manager;

pub use backend::{build_backend_config, BackendConfig, BackendState, DesktopRuntimeStatus};
pub use runtime_installation::DesktopRuntimeInstallation;

use backend::resource_path;
use backend_process::external_backend_env;
use constants::{BACKEND_RUNTIME_MANIFEST, CAPTURE_RUNTIME_MANIFEST};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = resolved_app_data_dir(app)?;
            fs::create_dir_all(&data_dir)
                .map_err(|error| format!("failed to create app data directory: {error}"))?;

            let state = BackendState::new(
                data_dir,
                resource_path(app, BACKEND_RUNTIME_MANIFEST),
                resource_path(app, CAPTURE_RUNTIME_MANIFEST),
            );
            if let Some(config) = external_backend_env() {
                state.set_external_config(config);
            } else {
                // Never hold Tauri setup (and therefore the first WebView
                // paint) on a packaged Python backend readiness probe. A
                // previously installed backend may take tens of seconds to
                // become ready; the shell must remain visible so the user can
                // inspect runtime state or explicitly install/start it.
                let startup_state = state.clone();
                thread::spawn(move || {
                    let launch_result = startup_state.try_launch_installed_backend();
                    if launch_result.is_err() && package_qa_auto_install_enabled() {
                        startup_state.start_installation();
                    }
                });
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
            commands::get_python_runtime_installation,
            commands::capture_runtime_status,
            commands::install_capture_runtime,
            commands::start_capture_runtime,
            commands::get_capture_runtime_installation
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

#[cfg(test)]
mod shared_sidecar_contract_tests {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::mpsc,
        thread,
    };

    use crate::constants::CAPTURE_RUNTIME_VERSION;
    use capture_sidecar_launcher::{probe_ready_once, ProbeResult, SidecarManifest};

    fn manifest() -> SidecarManifest {
        SidecarManifest {
            manifest_version: "1".into(),
            runtime_version: CAPTURE_RUNTIME_VERSION.into(),
            api_version: "2.0".into(),
            capture_document_schema_version: "2".into(),
            platform: "windows".into(),
            arch: "x86_64".into(),
            file_name: "capture-runtime-x86_64-pc-windows-msvc.exe".into(),
            bytes: 1,
            sha256: "0".repeat(64),
            schema_file_name: "capture-document.schema.json".into(),
            schema_sha256: "0".repeat(64),
        }
    }

    #[test]
    fn shared_authenticated_readiness_contract_is_consumer_green() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let (sender, receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 4096];
            let count = stream.read(&mut request).expect("request");
            sender
                .send(request[..count].to_vec())
                .expect("request bytes");
            let body = format!(
                r#"{{"ready":true,"runtimeVersion":"{}","apiVersion":"2.0","captureDocumentSchemaVersion":"2","capabilities":{{}}}}"#,
                CAPTURE_RUNTIME_VERSION
            );
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("response");
        });

        let result =
            probe_ready_once(port, "cert-prep-test-token", &manifest()).expect("readiness probe");
        assert!(matches!(result, ProbeResult::Ready(_)));
        let request = String::from_utf8(receiver.recv().expect("request")).expect("utf8");
        assert!(request.contains("Authorization: Bearer cert-prep-test-token"));
        server.join().expect("server");
    }
}
