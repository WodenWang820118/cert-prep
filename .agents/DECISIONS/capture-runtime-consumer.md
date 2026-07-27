# Capture Runtime Release Consumer Decisions

## 2026-07-23

- Use release artifacts rather than a source checkout, npm package, or Python
  wheel. This preserves the independent sidecar product boundary.
- Keep installation explicit. `prepare-runtime-resources` and Tauri build only
  consume an already verified staging directory.
- Pin cert-prep to capture-runtime `0.3.0`; API `1.0` and schema `1` remain
  unchanged. The backend currently accepts runtime major `0`, while the exact
  configured version must be synchronized.
- Use fake extraction plus cert-prep host structuring for the deterministic local
  consumer smoke. Real WindowsML/Whisper readiness remains a separate release
  prerequisite.
- The existing local release manifest contains a zero digest/one-byte WindowsML
  placeholder. The production consumer rejects it; the local smoke mirror
  creates an isolated non-placeholder test descriptor without modifying the
  tracked sibling release artifact.
- Preserve all pre-existing dirty Angular package, lockfile, UI trial, and CI
  changes in cert-prep.
