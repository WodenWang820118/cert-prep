# Packaged Capture Workbench Smoke Decision

## 2026-08-25

- The embedded-text fast path is superseded. The harness now installs
  `windowsml-ocr`, submits a caller-supplied raster/scanned PDF, and requires
  `windowsml-ocr` provenance from the real sidecar for every page. It rejects
  embedded text operators and never generates a born-digital PDF fixture.
- The harness accepts no sibling-checkout fallback. A missing truth fixture is
  an intentional gate failure, not permission to substitute a local or fake
  source.
- Unit/package-QA tests validate harness contracts only. Real OCR proof remains
  in an explicit real-runtime E2E/acceptance target.

## 2026-08-02

- Reuse the packaged-flow lifecycle and process-residue primitives instead of
  copying process ownership or normal-close logic.
- The harness accepts only a caller-supplied installed executable and requires
  previously absent output and app-data directories. It never builds, installs,
  or launches a loose development binary.
- `CERT_PREP_LLM_PROVIDER=fake` is permitted only for deterministic host
  structuring; fake extraction settings are rejected and the raw Capture
  document must prove canonical PaddleOCR provenance on every page.
- Fresh app-data must preserve the product's visible runtime sequence. The
  harness does not set `CERT_PREP_PACKAGE_QA_AUTO_INSTALL_BUNDLED_BACKEND`: it
  first proves the shell and `/runtime` work with no owned backend or Capture
  Runtime, then installs the Python backend through the existing consent UI.
- Capture Runtime installation and startup are separate acceptance phases.
  Install must end at installed-but-stopped without changing the backend
  process identity. Start must create an owned sidecar listener, restart the
  owned backend with a new process identity/configuration, and invalidate the
  prior backend access credential.
- Evidence is written only below the supplied output directory. API URLs,
  bearer credentials, raw response bodies, and process command lines are never
  persisted. Raw metadata is reduced to source id/digest, extractor engine and
  device, and durable document state.
- Closeout first requests a normal app close, then uses the established owned
  PID/creation/image-path residue check. The app is relaunched against the
  same isolated app-data directory and must remain installed-but-stopped until
  a second explicit Start before final closeout.
