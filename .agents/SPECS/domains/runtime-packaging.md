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
- Python backend and PaddleOCR runtime readiness are required for OCR/manual PDF
  workflows.
- Ollama and model availability are optional reasoning dependencies. They must
  never block OCR, source import, manual questions, Full Exam, Random Quiz, or
  wrong-answer review.
- Runtime install/download actions require explicit user consent.
- Package QA must verify MSI/NSIS artifacts, backend runtime zip, OCR runtime
  zip, manifests, launch env, and script-level gates through Nx targets.
- Runtime manifest hash churn should only be committed when the artifact change
  is part of the intended slice.

## Evidence

- Package QA has verified backend/OCR runtime manifests, runtime launch env, and
  Windows x64 bundle artifacts.
- Packaged flow smoke now records restart and final close summaries with
  `gracefulExited`, `fallbackUsed`, `exitCode`, and residual process lists.
- The 2026-06-21 packaged smoke completed with empty residual process lists and
  no `exam-prep` process residue after close.
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
- Generated runtime manifests may remain dirty after local packaged smoke runs;
  stage them only when the artifact bytes/hash update is intentional.
