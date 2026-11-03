use serde::Serialize;

use super::BackendState;

/// Connection information used by the Angular app to reach the local backend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BackendConfig {
    pub base_url: String,
    pub token: String,
}

/// Builds backend connection details without changing the transport schema.
pub fn build_backend_config(
    base_url: impl Into<String>,
    token: impl Into<String>,
) -> BackendConfig {
    BackendConfig {
        base_url: base_url.into(),
        token: token.into(),
    }
}

impl BackendState {
    pub(crate) fn set_external_config(&self, config: BackendConfig) {
        if let Ok(mut current) = self.inner.config.lock() {
            *current = Some(config);
        }
        if let Ok(mut external) = self.inner.external_backend.lock() {
            *external = true;
        }
    }

    pub(crate) fn backend_config(&self) -> Option<BackendConfig> {
        self.inner
            .config
            .lock()
            .ok()
            .and_then(|config| config.clone())
    }
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
}
