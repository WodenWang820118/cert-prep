# Cert Prep desktop test levels

- `unit/`: hermetic Node contract/process tests under `scripts/`.
- `integration/`: package-QA, resource staging, and consumer contract tests.
- `e2e/local-package/`: real packaged smoke and acceptance targets, including
  the real OCR journey; these own process, port, app-data, and temp cleanup.
- `e2e/online-package/`: reserved for a pinned online installer/package. No
  online case is enabled in this checkout.

The existing script topology is retained because its helper imports are part
of the desktop runner contract; the directories above are the canonical level
labels used by Nx targets and review evidence.
