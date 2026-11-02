//! What the user sees of the one-time runtime refresh after an app update.
//!
//! The refresh downloads nothing: it reinstalls runtimes from the bundle of
//! an app version the user already agreed to install. It still takes a few
//! seconds, so the WebView polls this state and shows a notice while the
//! slots are being replaced, then a brief success or the failure.

use serde::Serialize;

use crate::constants::{CAPTURE_RUNTIME_DIR, PYTHON_RUNTIME_KIND};

pub(crate) const BACKEND_UPDATE_KIND: &str = PYTHON_RUNTIME_KIND;
pub(crate) const CAPTURE_UPDATE_KIND: &str = CAPTURE_RUNTIME_DIR;

/// Rough copy, extract and hash throughput, used only for the estimate.
const ESTIMATE_BYTES_PER_SECOND: u64 = 50 * 1024 * 1024;

/// Snapshot returned to the WebView by `runtime_update_status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeUpdateNotice {
    /// `idle`, `applying`, `succeeded` or `failed`.
    pub phase: String,
    /// Runtime kinds being refreshed, in start order.
    pub runtimes: Vec<String>,
    pub completed: u32,
    pub total: u32,
    pub estimated_seconds: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Outcome {
    Pending,
    Succeeded,
    Failed(String),
}

#[derive(Debug, Clone)]
struct Entry {
    kind: &'static str,
    bytes: u64,
    outcome: Outcome,
}

#[derive(Debug, Default)]
pub(crate) struct RuntimeUpdates {
    entries: Vec<Entry>,
}

impl RuntimeUpdates {
    /// Records a refresh decided at startup; `bytes` is the bundled artifact
    /// size the estimate is based on.
    pub(crate) fn plan(&mut self, kind: &'static str, bytes: u64) {
        self.entries.push(Entry {
            kind,
            bytes,
            outcome: Outcome::Pending,
        });
    }

    pub(crate) fn finish(&mut self, kind: &str, result: Result<(), String>) {
        if let Some(entry) = self.entries.iter_mut().find(|entry| entry.kind == kind) {
            entry.outcome = match result {
                Ok(()) => Outcome::Succeeded,
                Err(error) => Outcome::Failed(error),
            };
        }
    }

    pub(crate) fn notice(&self) -> RuntimeUpdateNotice {
        let total = self.entries.len() as u32;
        let completed = self
            .entries
            .iter()
            .filter(|entry| entry.outcome != Outcome::Pending)
            .count() as u32;
        let errors: Vec<&str> = self
            .entries
            .iter()
            .filter_map(|entry| match &entry.outcome {
                Outcome::Failed(error) => Some(error.as_str()),
                _ => None,
            })
            .collect();
        let phase = if total == 0 {
            "idle"
        } else if completed < total {
            "applying"
        } else if errors.is_empty() {
            "succeeded"
        } else {
            "failed"
        };
        let pending_bytes: u64 = self
            .entries
            .iter()
            .filter(|entry| entry.outcome == Outcome::Pending)
            .map(|entry| entry.bytes)
            .sum();
        RuntimeUpdateNotice {
            phase: phase.into(),
            runtimes: self.entries.iter().map(|entry| entry.kind.into()).collect(),
            completed,
            total,
            estimated_seconds: (phase == "applying")
                .then(|| pending_bytes.div_ceil(ESTIMATE_BYTES_PER_SECOND).max(1)),
            error: (!errors.is_empty()).then(|| errors.join("; ")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_planned_is_idle() {
        let notice = RuntimeUpdates::default().notice();

        assert_eq!(notice.phase, "idle");
        assert_eq!((notice.completed, notice.total), (0, 0));
        assert_eq!(notice.estimated_seconds, None);
    }

    #[test]
    fn planned_refreshes_report_applying_with_progress_and_an_estimate() {
        let mut updates = RuntimeUpdates::default();
        updates.plan(BACKEND_UPDATE_KIND, 120 * 1024 * 1024);
        updates.plan(CAPTURE_UPDATE_KIND, 30 * 1024 * 1024);

        let notice = updates.notice();
        assert_eq!(notice.phase, "applying");
        assert_eq!(notice.runtimes, vec!["python_backend", "capture_runtime"]);
        assert_eq!((notice.completed, notice.total), (0, 2));
        assert_eq!(notice.estimated_seconds, Some(3));

        updates.finish(BACKEND_UPDATE_KIND, Ok(()));
        let notice = updates.notice();
        assert_eq!(notice.phase, "applying");
        assert_eq!((notice.completed, notice.total), (1, 2));
        assert_eq!(notice.estimated_seconds, Some(1));
    }

    #[test]
    fn all_refreshes_done_report_success() {
        let mut updates = RuntimeUpdates::default();
        updates.plan(CAPTURE_UPDATE_KIND, 1);
        updates.finish(CAPTURE_UPDATE_KIND, Ok(()));

        let notice = updates.notice();
        assert_eq!(notice.phase, "succeeded");
        assert_eq!(notice.error, None);
        assert_eq!(notice.estimated_seconds, None);
    }

    #[test]
    fn a_failed_refresh_reports_failure_once_all_are_done() {
        let mut updates = RuntimeUpdates::default();
        updates.plan(BACKEND_UPDATE_KIND, 1);
        updates.plan(CAPTURE_UPDATE_KIND, 1);
        updates.finish(
            CAPTURE_UPDATE_KIND,
            Err("Capture runtime SHA-256 mismatch.".into()),
        );
        assert_eq!(updates.notice().phase, "applying");

        updates.finish(BACKEND_UPDATE_KIND, Ok(()));
        let notice = updates.notice();
        assert_eq!(notice.phase, "failed");
        assert_eq!(
            notice.error.as_deref(),
            Some("Capture runtime SHA-256 mismatch.")
        );
    }

    #[test]
    fn notice_serializes_in_camel_case_for_the_webview() {
        let mut updates = RuntimeUpdates::default();
        updates.plan(CAPTURE_UPDATE_KIND, 1);

        let json = serde_json::to_value(updates.notice()).expect("notice JSON");

        assert_eq!(
            json,
            serde_json::json!({
                "phase": "applying",
                "runtimes": ["capture_runtime"],
                "completed": 0,
                "total": 1,
                "estimatedSeconds": 1,
                "error": null
            })
        );
    }
}
