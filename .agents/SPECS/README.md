# Cert Prep Specs

This folder is organized by durable product/domain ownership instead of by
temporary implementation slices.

## Domains

- `domains/product-ux.md` - product baseline, UI workflow, async parsing UX,
  practice/review flows, and user-facing acceptance notes.
- `domains/runtime-packaging.md` - Tauri packaging, downloadable runtimes,
  runtime health/install UX, package QA, and process cleanup evidence.
- `domains/backend-architecture.md` - backend domain boundaries, SOLID/DDD
  refactor decisions, OpenAPI ownership, persistence rules, and schema risks.
- `domains/parsing-reasoning.md` - OCR parsing performance, direct editable
  questions, streaming qwen prototype, live bakeoff/deferred model gates, and
  closed TODO evidence.

## Active Backlog

Active work belongs in `.agents/TODOS/`. Completed evidence belongs in the
owning SPECS domain.

Current TODO files:

- `cross-platform-runtime-nodes.md` - deferred restart point for future
  macOS/Linux/runtime-node expansion; not release-blocking.
- `feature-roadmap.md` - active product backlog for review retry,
  weak-area metrics, Mark for review policy, and wrong-answer document
  metadata.
- `ui-function-alignment-audit.md` - active follow-up backlog for runtime
  surface policy, practice/review coverage, and placeholder policy.

## Retired Slice Files

The older slice-specific spec and QA files were merged into the domain specs
above and removed. Keep future evidence in the owning domain unless a temporary
research note is explicitly needed.
