# Capture Runtime Release Consumer TODO

- [x] Replace the backend capture contract hand mirror with generated
      `capture_contracts` imports and add fail-closed raw/document mappers.
      Verify: backend tests, Angular tests, lint, and import scan pass.

- [x] After producer publication, remove Python/Cargo path sources, regenerate
      `uv.lock`/Cargo.lock from PyPI/crates.io, and run the strict consumer
      consistency target in clean CI.
      Verify: local strict gate, PyPI probe, backend tests, and Cargo tests pass;
      no capture package path source remains and all resolved versions are
      `0.3.10`. The clean consumer CI check remains an external merge gate.

- [ ] Run real WindowsML/Whisper positive capture against the published
  engine-bearing `capture-runtime@0.3.10` release after explicit consent; keep
  that evidence separate from the embedded-text product E2E.
  Verify: run an exact-release smoke that installs the required assets and
  records successful image/audio extraction with runtime provenance.
