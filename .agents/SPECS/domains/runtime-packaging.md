# Runtime And Packaging Domain

## Purpose

This domain owns the packaged desktop runtime story: Tauri shell startup,
backend/OCR runtime artifacts, explicit installation/health UX, package QA,
and process cleanup.

## Decisions

- The packaged app should use downloadable release/runtime artifacts rather than
  assuming machine-wide Python or hidden global setup.
- Python runtime means the packaged PyInstaller backend executable zip, not a
  system Python installer.
- The backend build has one supported PyInstaller owner:
  `cert-prep-backend:build-backend-runtime`. CPU/GPU OCR payloads remain owned
  by the separate OCR runtime builder.
- Runtime artifacts are described by manifests with file name, byte size,
  SHA-256, target, entrypoint, and release/local URL.
- Runtime payloads are release assets addressed by manifest URLs. Release
  automation provides `CERT_PREP_RUNTIME_ASSET_BASE_URL` for distributable
  runtime manifests.
- The retired Tauri `externalBin`/sidecar sync path is unsupported; desktop
  runtime startup must not depend on `src-tauri/binaries`.
- Python backend and WindowsML OCR runtime readiness are required for packaged
  OCR/manual PDF workflows.
- Runtime management has two supported entrypoints: the app topbar opens the
  shell modal, while `/runtime` remains an unguarded recovery/deep-link route
  rendering the same runtime details without modal-only close or cancel
  controls. Standalone `ModelHealthComponent` instances keep route navigation
  for app-shell compatibility.
- Ollama and model availability are optional reasoning dependencies. They must
  never block OCR, source import, manual questions, Full Exam, Random Quiz, or
  wrong-answer review.
- Runtime install/download actions require explicit user consent.
- Health checks and app startup must not install Ollama, pull models, or
  install OCR runtimes implicitly.
- Package QA schema v2 must verify MSI/NSIS artifacts, backend runtime zip,
  WindowsML OCR runtime zip, manifests, launch env, and script-level gates
  through Nx targets. The legacy Paddle OCR runtime manifest is not a packaged
  product artifact.
- Runtime manifest hash churn should only be committed when the artifact change
  is part of the intended slice.
- Process residue handling is audit-first. The desktop process residue audit may
  classify and recommend actions for Node/Python processes, but it must not kill
  processes by default.
- Scoped cleanup is limited to processes launched and owned by the active
  package QA or packaged-flow script. Future cleanup commands require manual
  confirmation and must protect Codex, MCP, Claude, Nx, VS Code, servicehub, and
  other known tooling residents.

## Rejected Packaging Options

- Installing machine-wide Python is rejected because it affects user systems
  and complicates version support.
- Bundling Ollama model files is rejected because installer size and
  model-licensing/storage become packaging concerns.
- Keeping the backend only as a bundled `externalBin` is rejected because the
  UI cannot guide recovery when the runtime is missing.
- Bundling PaddleOCR or WindowsML OCR into the initial installer is rejected
  because every install would pay the OCR payload cost.
- CPU-only OCR runtime packaging is rejected for the Windows optional runtime
  because it does not satisfy the GPU-auto product requirement.
- Blocking pull requests or UI startup on large model/runtime downloads is
  rejected; runtime work must be explicit and progress-visible.

## Evidence

- Package QA has verified backend/WindowsML OCR runtime manifests, runtime
  launch env, and Windows x64 bundle artifacts.
- The 2026-06-26 package QA passed
  `pnpm nx run cert-prep-desktop:package-qa` and recorded MSI, NSIS, backend
  runtime, and WindowsML OCR runtime artifacts, plus expected unavailable
  runtime states in the QA data directory.
- Packaged flow smoke now records restart and final close summaries with
  `gracefulExited`, `fallbackUsed`, `exitCode`, and residual process lists.
- The 2026-06-26 packaged flow smoke passed after the harness was aligned with
  the workbench UI.
- The 2026-06-21 packaged smoke completed with empty residual process lists and
  no `cert-prep` process residue after close.
- `cert-prep-desktop:process-residue-audit` provides a read-only Windows
  process-table report with PID, parent PID, command line, working set when
  available, classification, protection status, evidence, and recommended
  action.
- Python/PaddleOCR health can settle after startup; QA runner checks are scoped
  to the runtime dialog so background document text cannot falsely satisfy OCR
  readiness.

## Size And Artifact Evidence

Historical package-size closeout for the deferred-runtime lane:

- Final QA report: `tmp/cert-prep-desktop/package-qa/package-qa.json`.
- Target: Windows x64, `x86_64-pc-windows-msvc`.
- Previous bundled baseline: MSI about 637.88 MB, NSIS about 637.01 MB,
  bundled sidecar about 636.29 MB.
- Current MSI bundle:
  `apps/cert-prep-desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/Cert Prep_0.1.0_x64_en-US.msi`,
  49,299,456 bytes / 47.02 MB.
- Current NSIS setup bundle:
  `apps/cert-prep-desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Cert Prep_0.1.0_x64-setup.exe`,
  48,254,842 bytes / 46.02 MB.
- Lite synced sidecar:
  `apps/cert-prep-desktop/src-tauri/binaries/cert-prep-backend-x86_64-pc-windows-msvc.exe`,
  45,577,793 bytes / 43.47 MB.
- Optional OCR runtime ZIP:
  `apps/cert-prep-backend/dist/ocr-runtime/cert-prep-ocr-runtime-x86_64-pc-windows-msvc.zip`,
  663,364,398 bytes / 632.63 MB.
- OCR runtime manifest:
  `apps/cert-prep-backend/dist/ocr-runtime/ocr-runtime-manifest.json`,
  SHA-256 `f1c27a61c4bd13dd10567d8b8ca712360d18ae416990c335b17a281596134f42`.
- Angular browser output: `dist/apps/cert-prep/browser`, 1,373,475 bytes /
  1.31 MB.
- Size gate passed: largest initial artifact 47.02 MB, under the 150 MB warning
  threshold and 250 MB failure threshold.
- Runtime QA passed sidecar health. OCR health reports runtime missing in
  external mode until the optional runtime is installed.
- LLM QA is read-only when Ollama is unavailable; install/model jobs remain
  confirmation-gated.

## Open Risks

- Runtime health copy must keep distinguishing checking, warming, stale, ready,
  and failed states without regressing upload availability once OCR is known.
- Release URL and local file manifest behavior should be rechecked whenever
  packaging scripts or runtime distribution changes.
- Cargo PDB filename collision warning is known and not part of the active
  parsing/reasoning gate.
- PyInstaller hidden-import warnings and ONNXRuntime provider bridge warnings
  are known from the 2026-06-26 package round; the WindowsML OCR smoke still
  returned ready.
- Generated runtime manifests may remain dirty after local packaged smoke runs;
  stage them only when the artifact bytes/hash update is intentional.
