use std::path::{Path, PathBuf};

use tauri::path::BaseDirectory;
use tauri::Manager;
use tauri::Runtime;

use crate::{
    capture_runtime::installed_capture_runtime_paths,
    manifests::{load_runtime_manifest, RuntimeManifest},
    runtime_slots::{bundle_identity, PYTHON_BACKEND_SLOT},
};

use super::BackendRuntimeInner;

/// Identity of a bundled runtime. `None` when the app ships no bundle (for
/// example a development run), so any installed copy is accepted.
fn bundled_identity(manifest_path: Option<&Path>) -> Option<String> {
    manifest_path
        .filter(|path| path.is_file())
        .and_then(|path| bundle_identity(path).ok())
}

impl BackendRuntimeInner {
    pub(crate) fn backend_bundle_identity(&self) -> Option<String> {
        bundled_identity(self.backend_manifest_path.as_deref())
    }

    pub(crate) fn capture_bundle_identity(&self) -> Option<String> {
        bundled_identity(self.capture_runtime_manifest_path.as_deref())
    }

    pub(crate) fn installed_capture_runtime_paths(&self) -> Result<(PathBuf, PathBuf), String> {
        installed_capture_runtime_paths(
            &self.data_dir,
            self.capture_runtime_manifest_path.as_deref(),
        )
    }

    /// The Python backend installed from this app's bundle, with its
    /// installed manifest. A copy left by an earlier app version is ignored.
    pub(crate) fn installed_backend(&self) -> Option<(PathBuf, RuntimeManifest)> {
        let dir = PYTHON_BACKEND_SLOT
            .installed_dir(&self.data_dir, self.backend_bundle_identity().as_deref())?;
        let manifest = load_runtime_manifest(&dir.join("runtime-manifest.json")).ok()?;
        Some((dir, manifest))
    }

    pub(crate) fn installed_backend_entrypoint(&self) -> Option<PathBuf> {
        let (dir, manifest) = self.installed_backend()?;
        let entrypoint = dir.join(manifest.entrypoint);
        entrypoint.is_file().then_some(entrypoint)
    }
}

pub(crate) fn resource_path<R: Runtime>(app: &tauri::App<R>, file_name: &str) -> Option<PathBuf> {
    for candidate in resource_candidates(file_name) {
        if let Ok(path) = app.path().resolve(candidate, BaseDirectory::Resource) {
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

fn resource_candidates(file_name: &str) -> [String; 3] {
    [
        file_name.to_string(),
        format!("resources/{file_name}"),
        format!("generated-resources/{file_name}"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::BACKEND_RUNTIME_MANIFEST;

    #[test]
    fn resource_candidates_cover_flat_and_nested_resource_paths() {
        assert_eq!(
            resource_candidates(BACKEND_RUNTIME_MANIFEST),
            [
                "backend-runtime-manifest.json".to_string(),
                "resources/backend-runtime-manifest.json".to_string(),
                "generated-resources/backend-runtime-manifest.json".to_string()
            ]
        );
    }
}
