# Changelog

## 0.1.0-alpha.1 - Unreleased

- Store and return source kinds as `pdf`, `image`, and `recording`.
  Existing source records are migrated when the database opens.
- Rename `CERT_PREP_MAX_UPLOAD_BYTES` to `CERT_PREP_MAX_PAGE_SOURCE_UPLOAD_BYTES`
  and `CERT_PREP_MAX_AUDIO_UPLOAD_BYTES` to `CERT_PREP_MAX_RECORDING_UPLOAD_BYTES`.
  Update configurations that set either upload limit. The old variables are ignored.
- Renamed `CERT_PREP_RUNTIME_INSTALL_TIMEOUT_SECONDS` to
  `CERT_PREP_LLM_INSTALL_TIMEOUT_SECONDS`.

- Serve capture reviews at `/projects/{project_id}/capture-reviews`. Report missing
  Capture engines as `capture_requirement_unavailable` and failed reviews as
  `capture_review_failed` with their stored cause.
- Record extraction provenance at publication and mark historical projections
  `reconstructed`. Review ingestion IDs come from Capture when available.
- Return the Desktop runtime installation release identity as `artifact`.
- Define the public unsigned Windows alpha release contract.
- Bundle the backend runtime and move WindowsML OCR to a verified release
  download.

Pending before the public Alpha release:

- Complete local runtime/model onboarding and provider attribution evidence.
- Complete resumable sessions, cancellation, and visible polling recovery.
- Pass installer-content, fresh-install, SBOM/license, and recorded hardware
  acceptance gates.
