# cert-prep-desktop


# Packaged desktop acceptance

`acceptance-real`, packaged-flow smoke, image-upload smoke, and Capture
Workbench smoke are real packaged application journeys. They must finish with zero
owned process, listener, and app-data residue.


# Integration desktop tests

Package-QA and staged-runtime checks exercise multiple local components while
keeping package provenance local and explicit.


# Cert Prep desktop test levels

- `scripts/**/*.test.mts`: hermetic Node contract/process tests under `scripts/`.
- `package-qa-test`: package-QA, resource staging, and consumer contract tests.
- `acceptance-real` and packaged smoke targets: real packaged smoke and acceptance targets, including
  the real OCR journey; these own process, port, app-data, and temp cleanup.

The existing script topology is retained because its helper imports are part
of the desktop runner contract; the directories above are the canonical level
labels used by Nx targets and review evidence.


# Unit desktop tests

Deterministic process, artifact, and argument tests are collected by the
desktop `package-qa-test` lane without starting a packaged application.
