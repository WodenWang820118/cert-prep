# Cert Prep Specs

This folder is the durable product memory for Cert Prep. It is organized by
long-lived ownership domains, not by temporary implementation slices.

## Domain Index

- `domains/product-ux.md` - product baseline, UI system, workbench screens,
  async parsing UX, practice, review, and user-facing acceptance evidence.
- `domains/parsing-reasoning.md` - OCR runtime lanes, WindowsML package
  ownership, streaming reasoning, provider policy, runtime-node candidates,
  and parsing/reasoning acceptance gates.
- `domains/runtime-packaging.md` - Tauri packaging, downloadable runtime
  artifacts, runtime health/install UX, package QA, artifact sizes, and process
  cleanup evidence.
- `domains/backend-architecture.md` - backend domain boundaries, persistence,
  OpenAPI/generated-client ownership, DDD/SOLID refactor policy, and schema
  risks.
- `domains/workspace-governance.md` - workspace naming, package manager and Nx
  conventions, broad refactor slicing, documentation closeout rules, and
  cross-agent governance notes.

## Active Backlog

Active work belongs in `.agents/TODOS/`. Completed decisions, verification
evidence, and closed TODO content belong in the owning domain spec.

Current TODO files:

- `cross-platform-runtime-nodes.md` - deferred restart point for future
  macOS/Linux/runtime-node expansion; not release-blocking.

## Retired Sources

The former `.agents/DECISIONS/` files and root-level slice specs were folded
into the domain specs above. Keep future decision records in the relevant
domain file unless a temporary research note is explicitly needed.

Closeout rule: when a TODO or decision file is completed, merge durable content
into the owning domain spec, keep `.agents/TODOS/` active-only, and remove the
obsolete markdown file.
