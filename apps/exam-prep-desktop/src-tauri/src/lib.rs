use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendConfig {
    pub base_url: String,
    pub token: String,
}

pub fn build_backend_config(base_url: impl Into<String>, token: impl Into<String>) -> BackendConfig {
    BackendConfig {
        base_url: base_url.into(),
        token: token.into(),
    }
}

#[tauri::command]
fn backend_config() -> BackendConfig {
    let base_url =
        std::env::var("EXAM_PREP_BACKEND_URL").unwrap_or_else(|_| "http://127.0.0.1:8765".into());
    let token = std::env::var("EXAM_PREP_BACKEND_TOKEN")
        .unwrap_or_else(|_| "exam-prep-local-dev-token".into());
    build_backend_config(base_url, token)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
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
}
