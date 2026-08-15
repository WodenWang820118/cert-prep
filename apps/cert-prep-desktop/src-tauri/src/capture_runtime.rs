use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use capture_sidecar_launcher::{
    generate_bearer_token, launch_sidecar, reserve_distinct_loopback_port, LaunchOptions,
    OwnedSidecarProcess, SidecarLaunchSpec,
};

use crate::{
    capture_manifest::{
        load_capture_runtime_manifest, validate_capture_manifest_contract, verify_capture_runtime,
    },
    constants::{CAPTURE_RUNTIME_DIR, CAPTURE_RUNTIME_MANIFEST},
};

const LOOPBACK_HOST: &str = "127.0.0.1";
const DEFAULT_READY_TIMEOUT: Duration = Duration::from_secs(45);
const DEFAULT_RETENTION_HOURS: &str = "24";
const CERT_MAX_AUDIO_UPLOAD_BYTES: &str = "104857600";
const CERT_MAX_PDF_PAGES: &str = "250";
const CERT_MAX_IMAGE_PIXELS: &str = "50000000";
const CAPTURE_CHILD_ENV_ALLOWLIST: &[&str] = &[
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATH",
    "PATHEXT",
    "TEMP",
    "TMP",
    "LOCALAPPDATA",
    "APPDATA",
    "USERPROFILE",
    "PROGRAMDATA",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "CommonProgramFiles",
    "CommonProgramFiles(x86)",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "NUMBER_OF_PROCESSORS",
];

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct CaptureRuntimeConnection {
    pub base_url: String,
    pub token: String,
    pub runtime_version: String,
    pub api_version: String,
    pub capture_document_schema_version: String,
}

struct CaptureRuntimeInner {
    child: Mutex<Option<OwnedSidecarProcess>>,
    connection: CaptureRuntimeConnection,
}

#[derive(Clone)]
pub(crate) struct CaptureRuntimeState {
    inner: Arc<CaptureRuntimeInner>,
}

impl Drop for CaptureRuntimeInner {
    fn drop(&mut self) {
        self.terminate_child_process_tree();
    }
}

impl CaptureRuntimeInner {
    fn terminate_child_process_tree(&self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.take() {
                let _ = child.terminate();
            }
        }
    }
}

impl CaptureRuntimeState {
    pub(crate) fn launch_cancellable(
        manifest_path: &Path,
        executable_path: &Path,
        app_data_dir: &Path,
        cancelled: Option<&AtomicBool>,
    ) -> Result<Self, String> {
        if cancelled.is_some_and(|cancelled| cancelled.load(Ordering::SeqCst)) {
            return Err("Capture Runtime start was cancelled.".into());
        }

        let verified = verify_capture_runtime(manifest_path, executable_path)?;
        let never_cancelled = AtomicBool::new(false);
        let stopping = cancelled.unwrap_or(&never_cancelled);
        let data_dir = app_data_dir.join("capture-workbench");
        let mut used_ports = HashSet::new();
        let launched = launch_sidecar(
            &verified,
            stopping,
            LaunchOptions {
                ready_timeout: capture_ready_timeout(),
                ..LaunchOptions::default()
            },
            |_, _| {
                let policy = CaptureLaunchPolicy::new(data_dir.clone(), &used_ports)?;
                used_ports.insert(policy.port);
                fs::create_dir_all(&policy.data_dir).map_err(|error| {
                    format!("Capture runtime data directory could not be created: {error}")
                })?;
                Ok(SidecarLaunchSpec::new(
                    verified.executable_path.clone(),
                    policy.port,
                    policy.token.clone(),
                    policy
                        .environment()
                        .into_iter()
                        .map(|(name, value)| (name.to_owned(), value))
                        .collect(),
                    CAPTURE_CHILD_ENV_ALLOWLIST
                        .iter()
                        .map(|name| (*name).to_owned())
                        .collect(),
                ))
            },
        )?;

        Ok(Self {
            inner: Arc::new(CaptureRuntimeInner {
                child: Mutex::new(Some(launched.process)),
                connection: CaptureRuntimeConnection {
                    base_url: launched.connection.base_url,
                    token: launched.connection.token,
                    runtime_version: launched.connection.runtime_version,
                    api_version: launched.connection.api_version,
                    capture_document_schema_version: launched
                        .connection
                        .capture_document_schema_version,
                },
            }),
        })
    }

    pub(crate) fn connection(&self) -> CaptureRuntimeConnection {
        self.inner.connection.clone()
    }

    pub(crate) fn terminate_child_process_tree(&self) {
        self.inner.terminate_child_process_tree();
    }
}

/// Copies only a verified bundled Capture Runtime into user app data. The
/// caller chooses when to invoke this; Tauri setup deliberately does not.
pub(crate) fn install_bundled_capture_runtime(
    bundled_manifest_path: &Path,
    app_data_dir: &Path,
) -> Result<(PathBuf, PathBuf), String> {
    let (source_manifest_path, source_executable_path) =
        bundled_capture_runtime_paths(Some(bundled_manifest_path.to_path_buf()))?;
    let verified = verify_capture_runtime(&source_manifest_path, &source_executable_path)?;
    let source_dir = source_manifest_path
        .parent()
        .ok_or_else(|| "Bundled Capture Runtime manifest has no resource directory.".to_string())?;
    let runtime_root = app_data_dir.join("runtimes");
    fs::create_dir_all(&runtime_root)
        .map_err(|error| format!("Capture Runtime install root could not be created: {error}"))?;
    clean_stale_capture_runtime_staging(&runtime_root)?;
    let staging = runtime_root.join(format!(".capture-runtime-install-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&staging).map_err(|error| {
        format!("Capture Runtime staging directory could not be created: {error}")
    })?;

    let staged_manifest = staging.join(CAPTURE_RUNTIME_MANIFEST);
    let staged_executable = staging.join(&verified.manifest.file_name);
    let staged_schema = staging.join(&verified.manifest.schema_file_name);
    let copy_result = (|| {
        fs::copy(&source_manifest_path, &staged_manifest)
            .map_err(|error| format!("Capture Runtime manifest could not be staged: {error}"))?;
        fs::copy(&source_executable_path, &staged_executable)
            .map_err(|error| format!("Capture Runtime executable could not be staged: {error}"))?;
        fs::copy(
            source_dir.join(&verified.manifest.schema_file_name),
            &staged_schema,
        )
        .map_err(|error| format!("Capture Runtime schema could not be staged: {error}"))?;
        verify_capture_runtime(&staged_manifest, &staged_executable)?;
        Ok::<(), String>(())
    })();
    if let Err(error) = copy_result {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    let destination = runtime_root.join(CAPTURE_RUNTIME_DIR);
    replace_runtime_directory(&staging, &destination)?;
    Ok((
        destination.join(CAPTURE_RUNTIME_MANIFEST),
        destination.join(verified.manifest.file_name),
    ))
}

pub(crate) fn installed_capture_runtime_paths(
    app_data_dir: &Path,
) -> Result<(PathBuf, PathBuf), String> {
    let manifest_path = app_data_dir
        .join("runtimes")
        .join(CAPTURE_RUNTIME_DIR)
        .join(CAPTURE_RUNTIME_MANIFEST);
    let (manifest_path, executable_path) = bundled_capture_runtime_paths(Some(manifest_path))?;
    verify_capture_runtime(&manifest_path, &executable_path)?;
    Ok((manifest_path, executable_path))
}

fn replace_runtime_directory(staging: &Path, destination: &Path) -> Result<(), String> {
    let backup =
        destination.with_file_name(format!(".capture-runtime-backup-{}", uuid::Uuid::new_v4()));
    if backup.exists() {
        fs::remove_dir_all(&backup)
            .map_err(|error| format!("Capture Runtime backup could not be cleaned: {error}"))?;
    }
    let had_previous = destination.exists();
    if had_previous {
        fs::rename(destination, &backup)
            .map_err(|error| format!("Existing Capture Runtime could not be staged: {error}"))?;
    }
    if let Err(error) = fs::rename(staging, destination) {
        if had_previous {
            let _ = fs::rename(&backup, destination);
        }
        return Err(format!(
            "Capture Runtime installation could not be finalized: {error}"
        ));
    }
    if had_previous {
        let _ = fs::remove_dir_all(backup);
    }
    Ok(())
}

fn clean_stale_capture_runtime_staging(runtime_root: &Path) -> Result<(), String> {
    let entries = fs::read_dir(runtime_root)
        .map_err(|error| format!("Capture Runtime install root could not be read: {error}"))?;
    for entry in entries {
        let entry = entry
            .map_err(|error| format!("Capture Runtime staging entry could not be read: {error}"))?;
        if !entry
            .file_type()
            .map_err(|error| {
                format!("Capture Runtime staging entry type could not be read: {error}")
            })?
            .is_dir()
        {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(uuid) = name.strip_prefix(".capture-runtime-install-") else {
            continue;
        };
        if uuid::Uuid::parse_str(uuid).is_ok() {
            fs::remove_dir_all(entry.path()).map_err(|error| {
                format!("Stale Capture Runtime staging directory could not be removed: {error}")
            })?;
        }
    }
    Ok(())
}

struct CaptureLaunchPolicy {
    port: u16,
    token: String,
    data_dir: PathBuf,
}

impl CaptureLaunchPolicy {
    fn new(data_dir: PathBuf, excluded_ports: &HashSet<u16>) -> Result<Self, String> {
        Ok(Self {
            port: reserve_distinct_loopback_port(excluded_ports)?,
            token: generate_bearer_token()?,
            data_dir,
        })
    }

    fn environment(&self) -> Vec<(&'static str, String)> {
        vec![
            ("CAPTURE_HOST", LOOPBACK_HOST.into()),
            ("CAPTURE_PORT", self.port.to_string()),
            ("CAPTURE_API_TOKEN", self.token.clone()),
            (
                "CAPTURE_ALLOWED_HOSTS",
                format!("{LOOPBACK_HOST}:{}", self.port),
            ),
            ("CAPTURE_ALLOWED_ORIGINS", String::new()),
            ("CAPTURE_ENABLE_API_DOCS", "false".into()),
            (
                "CAPTURE_APP_DATA_DIR",
                self.data_dir.to_string_lossy().into_owned(),
            ),
            ("CAPTURE_EXTRACTION_PROVIDER", "runtime".into()),
            ("CAPTURE_STRUCTURING_PROVIDER", "host".into()),
            ("CAPTURE_RETENTION_HOURS", DEFAULT_RETENTION_HOURS.into()),
            (
                "CAPTURE_MAX_UPLOAD_BYTES",
                CERT_MAX_AUDIO_UPLOAD_BYTES.into(),
            ),
            ("CAPTURE_MAX_PDF_PAGES", CERT_MAX_PDF_PAGES.into()),
            ("CAPTURE_MAX_IMAGE_PIXELS", CERT_MAX_IMAGE_PIXELS.into()),
        ]
    }
}

fn capture_ready_timeout() -> Duration {
    Duration::from_secs(
        std::env::var("CERT_PREP_CAPTURE_RUNTIME_READY_TIMEOUT_SECS")
            .ok()
            .and_then(|value| value.trim().parse::<u64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_READY_TIMEOUT.as_secs()),
    )
}

pub(crate) fn bundled_capture_runtime_paths(
    manifest_path: Option<PathBuf>,
) -> Result<(PathBuf, PathBuf), String> {
    let manifest_path = manifest_path
        .ok_or_else(|| format!("Bundled {CAPTURE_RUNTIME_MANIFEST} was not found."))?;
    let manifest = load_capture_runtime_manifest(&manifest_path)?;
    validate_capture_manifest_contract(&manifest)?;
    let executable_path = manifest_path
        .parent()
        .ok_or_else(|| "Capture runtime manifest has no resource directory.".to_string())?
        .join(&manifest.file_name);
    Ok((manifest_path, executable_path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture_manifest::CaptureRuntimeManifest;
    use crate::constants::{
        CAPTURE_DOCUMENT_SCHEMA_FILE, CAPTURE_DOCUMENT_SCHEMA_SHA256,
        CAPTURE_DOCUMENT_SCHEMA_VERSION, CAPTURE_RUNTIME_API_VERSION, CAPTURE_RUNTIME_BINARY,
        CAPTURE_RUNTIME_VERSION,
    };
    use sha2::{Digest, Sha256};

    fn manifest() -> CaptureRuntimeManifest {
        CaptureRuntimeManifest {
            manifest_version: "1".into(),
            runtime_version: CAPTURE_RUNTIME_VERSION.into(),
            api_version: CAPTURE_RUNTIME_API_VERSION.into(),
            capture_document_schema_version: CAPTURE_DOCUMENT_SCHEMA_VERSION.into(),
            platform: "windows".into(),
            arch: "x86_64".into(),
            file_name: CAPTURE_RUNTIME_BINARY.into(),
            bytes: 1,
            sha256: "0".repeat(64),
            schema_file_name: CAPTURE_DOCUMENT_SCHEMA_FILE.into(),
            schema_sha256: CAPTURE_DOCUMENT_SCHEMA_SHA256.into(),
        }
    }

    fn canonical_schema_bytes() -> Vec<u8> {
        include_str!("../../test-fixtures/capture-document.schema.json")
            .replace("\r\n", "\n")
            .replace('\n', "\r\n")
            .into_bytes()
    }

    #[test]
    fn explicit_install_stages_verified_bundle_without_starting_a_process() {
        let root = std::env::temp_dir().join(format!(
            "cert-prep-capture-runtime-install-{}",
            uuid::Uuid::new_v4()
        ));
        let resources = root.join("resources");
        let app_data = root.join("app-data");
        fs::create_dir_all(&resources).expect("resources");
        let executable = resources.join(CAPTURE_RUNTIME_BINARY);
        let schema = resources.join(CAPTURE_DOCUMENT_SCHEMA_FILE);
        let manifest_path = resources.join(CAPTURE_RUNTIME_MANIFEST);
        let executable_bytes = b"capture-runtime-test-binary";
        let schema_bytes = canonical_schema_bytes();
        fs::write(&executable, executable_bytes).expect("executable");
        fs::write(&schema, &schema_bytes).expect("schema");
        let mut bundle_manifest = manifest();
        bundle_manifest.bytes = executable_bytes.len() as u64;
        bundle_manifest.sha256 = format!("{:x}", Sha256::digest(executable_bytes));
        fs::write(
            &manifest_path,
            serde_json::to_vec(&bundle_manifest).expect("manifest"),
        )
        .expect("manifest path");

        let (installed_manifest, installed_executable) =
            install_bundled_capture_runtime(&manifest_path, &app_data).expect("install");

        assert!(installed_manifest.is_file());
        assert!(installed_executable.is_file());
        assert_eq!(
            installed_capture_runtime_paths(&app_data).expect("installed paths"),
            (installed_manifest, installed_executable),
        );
        assert!(!app_data.join("capture-workbench").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stale_install_cleanup_removes_only_uuid_owned_directories() {
        let root = std::env::temp_dir().join(format!(
            "cert-prep-capture-runtime-staging-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("root");
        let owned = root.join(format!(".capture-runtime-install-{}", uuid::Uuid::new_v4()));
        let unrelated = root.join(".capture-runtime-install-not-a-uuid");
        fs::create_dir_all(&owned).expect("owned");
        fs::create_dir_all(&unrelated).expect("unrelated");

        clean_stale_capture_runtime_staging(&root).expect("cleanup");

        assert!(!owned.exists());
        assert!(unrelated.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cancelled_start_returns_before_loading_or_spawning_the_sidecar() {
        let cancelled = AtomicBool::new(true);
        let result = CaptureRuntimeState::launch_cancellable(
            Path::new("missing-manifest.json"),
            Path::new("missing-runtime.exe"),
            Path::new("missing-app-data"),
            Some(&cancelled),
        );
        let Err(error) = result else {
            panic!("cancelled start must not launch Capture Runtime");
        };

        assert_eq!(error, "Capture Runtime start was cancelled.");
    }
}
