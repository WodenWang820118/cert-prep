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
    SidecarLaunchSpec,
};

use crate::{
    capture_manifest::{
        load_capture_runtime_manifest, validate_capture_manifest_contract, verify_capture_runtime,
    },
    constants::CAPTURE_RUNTIME_MANIFEST,
    process_owner::{owned_runtime_process, RuntimeProcessOwner},
    runtime_slots::{bundle_identity, CAPTURE_RUNTIME_SLOT},
};

const LOOPBACK_HOST: &str = "127.0.0.1";
const DEFAULT_READY_TIMEOUT: Duration = Duration::from_secs(45);
const DEFAULT_RETENTION_HOURS: &str = "24";
const CERT_MAX_AUDIO_UPLOAD_BYTES: &str = "104857600";
const CERT_MAX_PDF_PAGES: &str = "250";
const CERT_MAX_IMAGE_PIXELS: &str = "50000000";
const ACCEPTANCE_ISOLATION_ENV: &str = "CERT_PREP_ACCEPTANCE_ISOLATION";
const ACCEPTANCE_WORKER_MIRROR_URL_ENV: &str =
    "CERT_PREP_CAPTURE_RUNTIME_WORKER_MIRROR_URL";
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
    process: Mutex<Option<RuntimeProcessOwner>>,
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
        if let Ok(mut process) = self.process.lock() {
            if let Some(mut process) = process.take() {
                let _ = process.terminate_once();
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
                process: Mutex::new(Some(owned_runtime_process!(launched.process))),
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
/// The copy goes into a new versioned slot directory and becomes active only
/// after it verified, so a failure keeps the previously installed runtime.
pub(crate) fn install_bundled_capture_runtime(
    bundled_manifest_path: &Path,
    app_data_dir: &Path,
) -> Result<(PathBuf, PathBuf), String> {
    let (source_manifest_path, source_executable_path) =
        bundled_capture_runtime_paths(Some(bundled_manifest_path.to_path_buf()))?;
    let verified = verify_capture_runtime(&source_manifest_path, &source_executable_path)?;
    let identity = bundle_identity(&source_manifest_path)?;
    let source_dir = source_manifest_path
        .parent()
        .ok_or_else(|| "Bundled Capture Runtime manifest has no resource directory.".to_string())?;

    let destination = CAPTURE_RUNTIME_SLOT.install(app_data_dir, &identity, |staging| {
        let staged_manifest = staging.join(CAPTURE_RUNTIME_MANIFEST);
        let staged_executable = staging.join(&verified.manifest.file_name);
        fs::copy(&source_manifest_path, &staged_manifest)
            .map_err(|error| format!("Capture Runtime manifest could not be staged: {error}"))?;
        fs::copy(&source_executable_path, &staged_executable)
            .map_err(|error| format!("Capture Runtime executable could not be staged: {error}"))?;
        fs::copy(
            source_dir.join(&verified.manifest.schema_file_name),
            staging.join(&verified.manifest.schema_file_name),
        )
        .map_err(|error| format!("Capture Runtime schema could not be staged: {error}"))?;
        verify_capture_runtime(&staged_manifest, &staged_executable)?;
        if bundle_identity(&staged_manifest)? != identity {
            return Err("Bundled Capture Runtime manifest changed during installation.".into());
        }
        Ok(())
    })?;
    Ok((
        destination.join(CAPTURE_RUNTIME_MANIFEST),
        destination.join(verified.manifest.file_name),
    ))
}

/// Paths of the installed, verified Capture Runtime. When the app bundles a
/// runtime, only a copy installed from that same bundle counts; a copy left
/// by an earlier app version is reported as not installed.
pub(crate) fn installed_capture_runtime_paths(
    app_data_dir: &Path,
    bundled_manifest_path: Option<&Path>,
) -> Result<(PathBuf, PathBuf), String> {
    let expected_identity = bundled_manifest_path
        .filter(|path| path.is_file())
        .map(bundle_identity)
        .transpose()?;
    let installed_dir = CAPTURE_RUNTIME_SLOT
        .installed_dir(app_data_dir, expected_identity.as_deref())
        .ok_or_else(|| "Capture Runtime for this app version is not installed.".to_string())?;
    let (manifest_path, executable_path) =
        bundled_capture_runtime_paths(Some(installed_dir.join(CAPTURE_RUNTIME_MANIFEST)))?;
    verify_capture_runtime(&manifest_path, &executable_path)?;
    Ok((manifest_path, executable_path))
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
        let mut environment = vec![
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
        ];
        if acceptance_worker_mirror_enabled() {
            if let Ok(url) = std::env::var(ACCEPTANCE_WORKER_MIRROR_URL_ENV) {
                environment.push(("CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN", "1".into()));
                environment.push(("CAPTURE_SMOKE_WORKER_MIRROR_URL", url));
            }
        }
        environment
    }
}

fn acceptance_worker_mirror_enabled() -> bool {
    std::env::var(ACCEPTANCE_ISOLATION_ENV)
        .ok()
        .is_some_and(|value| value.trim() == "1")
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
        include_str!("../../test-fixtures/capture-document-v2.schema.json")
            .replace("\r\n", "\n")
            .replace('\n', "\r\n")
            .into_bytes()
    }

    /// Writes a bundled runtime (manifest, executable, schema) the way the
    /// installer lays it out, with the manifest pinning `executable_bytes`.
    fn write_bundle(resources: &Path, executable_bytes: &[u8]) -> PathBuf {
        fs::create_dir_all(resources).expect("resources");
        fs::write(resources.join(CAPTURE_RUNTIME_BINARY), executable_bytes).expect("executable");
        fs::write(
            resources.join(CAPTURE_DOCUMENT_SCHEMA_FILE),
            canonical_schema_bytes(),
        )
        .expect("schema");
        let mut bundle_manifest = manifest();
        bundle_manifest.bytes = executable_bytes.len() as u64;
        bundle_manifest.sha256 = format!("{:x}", Sha256::digest(executable_bytes));
        let manifest_path = resources.join(CAPTURE_RUNTIME_MANIFEST);
        fs::write(
            &manifest_path,
            serde_json::to_vec(&bundle_manifest).expect("manifest"),
        )
        .expect("manifest path");
        manifest_path
    }

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(label: &str) -> Self {
            Self(std::env::temp_dir().join(format!("{label}-{}", uuid::Uuid::new_v4())))
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn explicit_install_stages_verified_bundle_without_starting_a_process() {
        let root = TempRoot::new("cert-prep-capture-runtime-install");
        let app_data = root.0.join("app-data");
        let manifest_path = write_bundle(&root.0.join("resources"), b"capture-runtime-test-binary");

        let (installed_manifest, installed_executable) =
            install_bundled_capture_runtime(&manifest_path, &app_data).expect("install");

        assert!(installed_manifest.is_file());
        assert!(installed_executable.is_file());
        assert_eq!(
            installed_capture_runtime_paths(&app_data, Some(&manifest_path))
                .expect("installed paths"),
            (installed_manifest, installed_executable),
        );
        assert!(!CAPTURE_RUNTIME_SLOT.needs_refresh(
            &app_data,
            &bundle_identity(&manifest_path).expect("identity")
        ));
        assert!(!app_data.join("capture-workbench").exists());
    }

    #[test]
    fn app_update_with_a_new_bundle_reinstalls_and_keeps_engines() {
        let root = TempRoot::new("cert-prep-capture-runtime-update");
        let app_data = root.0.join("app-data");
        let engines = app_data.join("capture-workbench").join("engines");
        fs::create_dir_all(&engines).expect("engines");
        fs::write(engines.join("model.bin"), "engine").expect("engine");
        let old_bundle = write_bundle(&root.0.join("resources-n"), b"capture-runtime-n");
        let (_, old_executable) =
            install_bundled_capture_runtime(&old_bundle, &app_data).expect("install N");

        // The updated app ships N+1. The copy from N no longer counts.
        let new_bundle = write_bundle(&root.0.join("resources-n1"), b"capture-runtime-n+1");
        let new_identity = bundle_identity(&new_bundle).expect("identity");
        assert!(CAPTURE_RUNTIME_SLOT.needs_refresh(&app_data, &new_identity));
        assert!(installed_capture_runtime_paths(&app_data, Some(&new_bundle))
            .expect_err("stale copy")
            .contains("not installed"));

        let (_, new_executable) =
            install_bundled_capture_runtime(&new_bundle, &app_data).expect("install N+1");

        assert_eq!(fs::read(&new_executable).expect("N+1"), b"capture-runtime-n+1");
        assert!(!old_executable.exists(), "the copy from N is removed");
        assert!(!CAPTURE_RUNTIME_SLOT.needs_refresh(&app_data, &new_identity));
        assert!(engines.join("model.bin").is_file(), "engines survive");
    }

    #[test]
    fn corrupted_bundle_fails_closed_and_keeps_the_installed_runtime() {
        let root = TempRoot::new("cert-prep-capture-runtime-corrupt");
        let app_data = root.0.join("app-data");
        let old_bundle = write_bundle(&root.0.join("resources-n"), b"capture-runtime-n");
        let (old_manifest, old_executable) =
            install_bundled_capture_runtime(&old_bundle, &app_data).expect("install N");
        let new_bundle = write_bundle(&root.0.join("resources-n1"), b"capture-runtime-n+1");
        fs::write(
            root.0.join("resources-n1").join(CAPTURE_RUNTIME_BINARY),
            b"capture-runtime-bad",
        )
        .expect("corrupt");

        let error = install_bundled_capture_runtime(&new_bundle, &app_data)
            .expect_err("corrupted executable");

        assert!(error.contains("SHA-256 mismatch"), "{error}");
        assert_eq!(
            installed_capture_runtime_paths(&app_data, Some(&old_bundle)).expect("N still active"),
            (old_manifest, old_executable),
        );
    }

    #[test]
    fn startup_refresh_reinstalls_only_a_copy_the_user_installed() {
        use crate::backend::BackendState;

        let root = TempRoot::new("cert-prep-capture-runtime-startup");
        let app_data = root.0.join("app-data");
        let old_bundle = write_bundle(&root.0.join("resources-n"), b"capture-runtime-n");
        let new_bundle = write_bundle(&root.0.join("resources-n1"), b"capture-runtime-n+1");

        // Never installed: startup must not install it on its own.
        let fresh_app = BackendState::new(app_data.clone(), None, Some(new_bundle.clone()));
        let refresh = fresh_app.plan_startup_runtime_refresh();
        assert_eq!(refresh.capture_job, None);
        assert_eq!(fresh_app.runtime_update_notice().phase, "idle");
        fresh_app.refresh_installed_capture_runtime(refresh.capture_job);
        assert_eq!(CAPTURE_RUNTIME_SLOT.installed_dir(&app_data, None), None);

        install_bundled_capture_runtime(&old_bundle, &app_data).expect("install N");
        let updated_app = BackendState::new(app_data.clone(), None, Some(new_bundle.clone()));

        // The plan runs before any worker, so the first poll shows the notice.
        let refresh = updated_app.plan_startup_runtime_refresh();
        let notice = updated_app.runtime_update_notice();
        assert_eq!(notice.phase, "applying");
        assert_eq!(notice.runtimes, vec!["capture_runtime"]);
        assert_eq!((notice.completed, notice.total), (0, 1));
        assert_eq!(notice.estimated_seconds, Some(1));
        assert_eq!(updated_app.capture_runtime_status().status, "queued");

        updated_app.refresh_installed_capture_runtime(refresh.capture_job);

        let notice = updated_app.runtime_update_notice();
        assert_eq!(notice.phase, "succeeded");
        assert_eq!((notice.completed, notice.total), (1, 1));
        assert_eq!(updated_app.capture_runtime_status().status, "installed");
        let (_, executable) =
            installed_capture_runtime_paths(&app_data, Some(&new_bundle)).expect("N+1 active");
        assert_eq!(fs::read(executable).expect("N+1"), b"capture-runtime-n+1");
    }

    #[test]
    fn startup_refresh_failure_is_reported_and_keeps_the_installed_runtime() {
        use crate::backend::BackendState;

        let root = TempRoot::new("cert-prep-capture-runtime-startup-fail");
        let app_data = root.0.join("app-data");
        let old_bundle = write_bundle(&root.0.join("resources-n"), b"capture-runtime-n");
        let old_paths = install_bundled_capture_runtime(&old_bundle, &app_data).expect("N");
        let new_bundle = write_bundle(&root.0.join("resources-n1"), b"capture-runtime-n+1");
        fs::write(
            root.0.join("resources-n1").join(CAPTURE_RUNTIME_BINARY),
            b"capture-runtime-bad",
        )
        .expect("corrupt");
        let updated_app = BackendState::new(app_data.clone(), None, Some(new_bundle));

        let refresh = updated_app.plan_startup_runtime_refresh();
        updated_app.refresh_installed_capture_runtime(refresh.capture_job);

        let notice = updated_app.runtime_update_notice();
        assert_eq!(notice.phase, "failed");
        assert!(notice.error.expect("error").contains("SHA-256 mismatch"));
        let status = updated_app.capture_runtime_status();
        assert_eq!(status.status, "failed");
        assert!(status.error.expect("error").contains("SHA-256 mismatch"));
        assert_eq!(
            installed_capture_runtime_paths(&app_data, Some(&old_bundle)).expect("N kept"),
            old_paths,
        );
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
