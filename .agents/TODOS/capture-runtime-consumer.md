# Capture Runtime Release Consumer TODO

- [ ] Run real WindowsML/Whisper positive capture against the published
      engine-bearing `capture-runtime@0.3.11` release after explicit consent; keep
      that evidence separate from the embedded-text product E2E.
      Verify: run an exact-release smoke that installs the required assets and
      records successful image/audio extraction with runtime provenance.

- [ ] Qualify the independent Cert Prep Tauri consumer with the local 0.3.11
      release directory before treating the candidate as production evidence.
      Verify: install the canonical runtime assets through
      `CERT_PREP_CAPTURE_RUNTIME_RELEASE_DIRECTORY`, then build and inspect the
      `cert-prep-desktop` Tauri bundle; do not use the Capture Workbench app as
      consumer evidence.
