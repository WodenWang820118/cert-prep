use std::{sync::atomic::Ordering, time::Duration};

use super::{BackendRuntimeInner, BackendState};

const CAPTURE_START_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

impl Drop for BackendRuntimeInner {
    fn drop(&mut self) {
        self.closing.store(true, Ordering::SeqCst);
        self.terminate_child_process_tree();
        self.terminate_capture_runtime_process_tree();
        self.wait_for_capture_start_shutdown(CAPTURE_START_SHUTDOWN_TIMEOUT);
        self.terminate_capture_runtime_process_tree();
    }
}

impl BackendRuntimeInner {
    fn terminate_child_process_tree(&self) {
        if let Ok(mut child) = self.child.lock() {
            #[allow(unused_mut)]
            if let Some(mut child) = child.take() {
                let _ = child.terminate();
            }
        }
    }

    fn terminate_capture_runtime_process_tree(&self) {
        if let Ok(mut runtime) = self.capture_runtime.lock() {
            if let Some(runtime) = runtime.take() {
                runtime.terminate_child_process_tree();
            }
        }
    }

    pub(crate) fn begin_capture_start(&self) -> Result<(), String> {
        let mut active = self
            .capture_start_active
            .lock()
            .map_err(|_| "Capture Runtime start state is unavailable.".to_string())?;
        if *active {
            return Err("Capture Runtime is already starting.".into());
        }
        *active = true;
        Ok(())
    }

    pub(crate) fn finish_capture_start(&self) {
        if let Ok(mut active) = self.capture_start_active.lock() {
            *active = false;
            self.capture_start_complete.notify_all();
        }
    }

    /// Give a cancellation-aware sidecar start a short, bounded window to
    /// terminate its locally-owned child before the desktop process exits.
    fn wait_for_capture_start_shutdown(&self, timeout: Duration) -> bool {
        let Ok(active) = self.capture_start_active.lock() else {
            return false;
        };
        match self
            .capture_start_complete
            .wait_timeout_while(active, timeout, |active| *active)
        {
            Ok((active, _)) => !*active,
            Err(_) => false,
        }
    }
}

impl BackendState {
    pub(crate) fn terminate_child_process_tree(&self) {
        self.inner.closing.store(true, Ordering::SeqCst);
        self.inner.terminate_child_process_tree();
        self.inner.terminate_capture_runtime_process_tree();
        self.inner
            .wait_for_capture_start_shutdown(CAPTURE_START_SHUTDOWN_TIMEOUT);
        // A start may have completed its handoff immediately before the
        // cancellation check. Terminate the newly-managed process too.
        self.inner.terminate_capture_runtime_process_tree();
    }
}
