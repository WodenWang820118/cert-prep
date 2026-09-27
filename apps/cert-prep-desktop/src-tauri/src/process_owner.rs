/// The host-owned process cleanup seam for one Capture Runtime launch.
///
/// The launcher crate has changed the concrete process/session type across
/// compatible releases.  The host keeps only this narrow interface: one
/// owned, fail-closed termination closure.
pub(crate) struct RuntimeProcessOwner {
    terminate: Option<Box<dyn FnOnce() -> Result<(), String> + Send>>,
}

impl RuntimeProcessOwner {
    pub(crate) fn from_termination(
        terminate: impl FnOnce() -> Result<(), String> + Send + 'static,
    ) -> Self {
        Self {
            terminate: Some(Box::new(terminate)),
        }
    }

    pub(crate) fn terminate_once(&mut self) -> Result<(), String> {
        self.terminate.take().map_or(Ok(()), |terminate| {
            terminate().map_err(|error| sanitize_termination_error(&error))
        })
    }
}

impl Drop for RuntimeProcessOwner {
    fn drop(&mut self) {
        let _ = self.terminate_once();
    }
}

/// Converts launcher cleanup diagnostics to a fixed, privacy-safe host error.
pub(crate) fn sanitize_termination_error(_detail: &str) -> String {
    "Capture Runtime process cleanup failed.".into()
}

macro_rules! owned_runtime_process {
    ($process:expr) => {{
        #[allow(unused_mut)]
        let mut process = $process;
        $crate::process_owner::RuntimeProcessOwner::from_termination(move || {
            process.terminate().map_err(|error| {
                $crate::process_owner::sanitize_termination_error(&error.to_string())
            })
        })
    }};
}

pub(crate) use owned_runtime_process;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[test]
    fn explicit_termination_is_not_repeated_when_owner_drops() {
        let calls = Arc::new(AtomicUsize::new(0));
        let observed_calls = Arc::clone(&calls);
        let mut owner = RuntimeProcessOwner::from_termination(move || {
            observed_calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        });

        assert_eq!(owner.terminate_once(), Ok(()));
        drop(owner);

        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn dropping_owner_terminates_exactly_once() {
        let calls = Arc::new(AtomicUsize::new(0));
        let observed_calls = Arc::clone(&calls);
        let owner = RuntimeProcessOwner::from_termination(move || {
            observed_calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        });

        drop(owner);

        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn failed_termination_returns_a_sanitized_error_and_is_not_repeated() {
        let calls = Arc::new(AtomicUsize::new(0));
        let observed_calls = Arc::clone(&calls);
        let mut owner = RuntimeProcessOwner::from_termination(move || {
            observed_calls.fetch_add(1, Ordering::SeqCst);
            Err("sensitive runtime cleanup detail".into())
        });

        let error = owner.terminate_once().expect_err("cleanup must fail");
        drop(owner);

        assert_eq!(error, "Capture Runtime process cleanup failed.");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    struct FakeProcess {
        calls: Arc<AtomicUsize>,
    }

    impl FakeProcess {
        fn terminate(&mut self) -> Result<(), &'static str> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Err("sensitive runtime cleanup detail")
        }
    }

    #[test]
    fn inferred_process_cleanup_maps_launcher_errors_without_leaking_details() {
        let calls = Arc::new(AtomicUsize::new(0));
        let mut owner = owned_runtime_process!(FakeProcess {
            calls: Arc::clone(&calls),
        });

        let error = owner.terminate_once().expect_err("cleanup must fail");
        drop(owner);

        assert_eq!(error, "Capture Runtime process cleanup failed.");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
