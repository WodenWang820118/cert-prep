/// Exact, acceptance-only forwarding boundary for the runtime's immutable GPU
/// execution proof. The sidecar launcher clears its environment, therefore
/// these values must be explicit launch pairs rather than inherited variables.
pub(crate) fn acceptance_ocr_execution_evidence_environment(
    opt_in: Option<&str>,
    root: Option<&str>,
    runtime_sha256: Option<&str>,
) -> Vec<(&'static str, String)> {
    if opt_in.map(str::trim) != Some("1") {
        return Vec::new();
    }
    let Some(root) = root.map(str::trim).filter(|value| !value.is_empty()) else {
        return Vec::new();
    };
    let Some(runtime_sha256) = runtime_sha256
        .map(str::trim)
        .filter(|value| is_sha256(value))
    else {
        return Vec::new();
    };
    vec![
        (
            "CAPTURE_OCR_EXECUTION_EVIDENCE_OPT_IN",
            "1".to_owned(),
        ),
        (
            "CAPTURE_OCR_EXECUTION_EVIDENCE_ROOT",
            root.to_owned(),
        ),
        (
            "CAPTURE_OCR_EXECUTION_RUNTIME_SHA256",
            runtime_sha256.to_owned(),
        ),
    ]
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::acceptance_ocr_execution_evidence_environment;

    #[test]
    fn forwards_only_the_three_trimmed_opt_in_proof_variables() {
        assert_eq!(
            acceptance_ocr_execution_evidence_environment(
                Some(" 1 "),
                Some(" C:\\run\\proof "),
                Some(&"a".repeat(64)),
            ),
            vec![
                ("CAPTURE_OCR_EXECUTION_EVIDENCE_OPT_IN", "1".to_owned()),
                (
                    "CAPTURE_OCR_EXECUTION_EVIDENCE_ROOT",
                    "C:\\run\\proof".to_owned(),
                ),
                (
                    "CAPTURE_OCR_EXECUTION_RUNTIME_SHA256",
                    "a".repeat(64),
                ),
            ],
        );
    }

    #[test]
    fn non_opt_in_or_incomplete_values_forward_nothing() {
        assert!(acceptance_ocr_execution_evidence_environment(None, Some("root"), Some(&"a".repeat(64))).is_empty());
        assert!(acceptance_ocr_execution_evidence_environment(Some("0"), Some("root"), Some(&"a".repeat(64))).is_empty());
        assert!(acceptance_ocr_execution_evidence_environment(Some("1"), Some("root"), Some("not-a-sha")).is_empty());
        assert!(acceptance_ocr_execution_evidence_environment(Some("1"), Some(" "), Some(&"a".repeat(64))).is_empty());
    }
}
