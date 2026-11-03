mod configuration;
mod launch;
mod paths;
mod readiness;
mod shutdown;

pub use configuration::{build_backend_config, BackendConfig};
pub use readiness::DesktopRuntimeStatus;

pub(crate) use paths::resource_path;

use std::{
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc, Condvar, Mutex},
};

use capture_sidecar_launcher::OwnedSidecarProcess;

use crate::{
    capture_runtime::CaptureRuntimeState, runtime_installation::RuntimeJob,
    runtime_update::RuntimeUpdates,
};

pub(crate) struct BackendRuntimeInner {
    pub(crate) data_dir: PathBuf,
    pub(crate) backend_manifest_path: Option<PathBuf>,
    pub(crate) capture_runtime_manifest_path: Option<PathBuf>,
    pub(crate) capture_runtime: Mutex<Option<CaptureRuntimeState>>,
    pub(crate) backend_launch: Mutex<()>,
    pub(crate) config: Mutex<Option<BackendConfig>>,
    pub(crate) child: Mutex<Option<OwnedSidecarProcess>>,
    pub(crate) job: Mutex<Option<RuntimeJob>>,
    pub(crate) capture_job: Mutex<Option<RuntimeJob>>,
    pub(crate) capture_start_active: Mutex<bool>,
    pub(crate) capture_start_complete: Condvar,
    pub(crate) external_backend: Mutex<bool>,
    pub(crate) closing: AtomicBool,
    pub(crate) runtime_updates: Mutex<RuntimeUpdates>,
}

/// Refresh jobs queued by `plan_startup_runtime_refresh`, run by the
/// startup workers.
#[derive(Debug, Default)]
pub(crate) struct StartupRuntimeRefresh {
    pub(crate) backend_job: Option<String>,
    pub(crate) capture_job: Option<String>,
}

/// Shared Tauri state for backend runtime process and installation lifecycle.
#[derive(Clone)]
pub struct BackendState {
    inner: Arc<BackendRuntimeInner>,
}

impl BackendState {
    pub(crate) fn new(
        data_dir: PathBuf,
        backend_manifest_path: Option<PathBuf>,
        capture_runtime_manifest_path: Option<PathBuf>,
    ) -> Self {
        Self {
            inner: Arc::new(BackendRuntimeInner {
                data_dir,
                backend_manifest_path,
                capture_runtime_manifest_path,
                capture_runtime: Mutex::new(None),
                backend_launch: Mutex::new(()),
                config: Mutex::new(None),
                child: Mutex::new(None),
                job: Mutex::new(None),
                capture_job: Mutex::new(None),
                capture_start_active: Mutex::new(false),
                capture_start_complete: Condvar::new(),
                external_backend: Mutex::new(false),
                closing: AtomicBool::new(false),
                runtime_updates: Mutex::new(RuntimeUpdates::default()),
            }),
        }
    }
}
