# Exam Prep Specs

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
  questions, streaming qwen prototype, live bakeoff blockers, and active TODO
  pointers.

## Active Backlog

Active work belongs in `.agents/TODOS/`. At this checkpoint the only active
backlog is `.agents/TODOS/parallel-parsing-reasoning.md`.

## Retired Slice Files

The older slice-specific spec and QA files were merged into the domain specs
above and removed. Keep future evidence in the owning domain unless a temporary
research note is explicitly needed.
