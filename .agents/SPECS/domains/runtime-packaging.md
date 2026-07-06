# Runtime And Packaging Domain

## Purpose

This domain owns the packaged desktop runtime story: Tauri shell startup,
backend/OCR runtime artifacts, explicit installation/health UX, package QA,
and process cleanup.

## Decisions

- The packaged app should use downloadable release/runtime artifacts rather than
  assuming machine-wide Python or hidden global setup.
- Runtime artifacts are described by manifests with file name, byte size,
  SHA-256, target, entrypoint, and release/local URL.
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
