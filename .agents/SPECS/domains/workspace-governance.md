# Workspace Governance Domain

## Purpose

This domain owns workspace-level choices that cut across product UX, backend,
runtime packaging, and parsing/reasoning. Keep naming, package-manager, Nx,
refactor-slicing, and documentation-governance decisions here so feature
domains stay focused on product behavior.

## Naming And Package Manager Decisions

- Use `cert-prep` as the workspace/project/package slug.
- Use `cert_prep` for Python modules and Rust library identifiers.
- Use `certPrep` for local-storage-style camelCase keys.
- Use `CertPrep` for TypeScript symbols and user-facing product title text.
- Prefer a full internal rename over compatibility shims so new work does not
  spread old slug variants.
- Preserve command entrypoints by updating root package scripts to the new Nx
  project names.
- New evidence and ignored output folders should use `tmp/cert-prep-desktop`;
  old ignored local evidence does not need migration.
- Use `pnpm@10.33.2`; do not mix npm and pnpm after migration.

## Nx And Verification Rules

- Use package-manager-prefixed Nx commands, for example `pnpm nx ...`.
- Use `pnpm nx show projects --json` for workspace orientation.
- Use `pnpm nx show project <name> --json` for resolved project metadata before
  relying on target names or inferred configuration.
- For task execution, prefer `pnpm nx run`, `pnpm nx run-many`, or
  `pnpm nx affected` over direct tool invocations.
- Do not guess unfamiliar Nx flags; check help or docs first.

## Refactor Slicing Policy

Broad refactors must be sliced by verification boundary instead of performed as
one rewrite.

Typical slices:

- Baseline plan plus low-risk hygiene for backend, frontend, and workspace.
- Frontend component directory or template extraction with build/test coverage.
- Backend document-processing extraction with focused async document tests.
- Desktop runtime environment map and duplicate-target cleanup with cargo and
  package-script tests.
- E2E support fixture/page-object extraction before expanding journeys.
- Shared library evaluation only after repeated API/store/test contracts show a
  real second consumer.

Avoid:

- New shared libraries before a concrete second consumer exists.
- Alembic migration adoption as drive-by cleanup.
- Broad component moves bundled with store behavior changes.
- Package rename or agent-file dedupe without explicit verification.
- Agent governance rewrites unless the preferred cross-agent strategy is
  explicit.

## Behavior-Preservation Gates

Use the narrowest relevant subset for the slice:

- `pnpm nx show projects --json`
- `pnpm nx run cert-prep:lint`
- `pnpm nx run cert-prep:test`
- `pnpm nx run cert-prep:build`
- `pnpm nx run cert-prep-backend:lint`
- `pnpm nx run cert-prep-backend:test`
- `pnpm nx run cert-prep-ocr-windowsml:lint`
- `pnpm nx run cert-prep-ocr-windowsml:test`
- `pnpm nx run cert-prep-desktop:typecheck-scripts`
- `pnpm nx run cert-prep-desktop:package-qa-test`
- `pnpm nx run cert-prep-desktop:cargo-test`
- `git diff --check`

## Documentation Closeout Rules

- `.agents/SPECS/` is the durable evidence store.
- `.agents/TODOS/` should contain only active work.
- Completed TODO and DECISION content should be merged into the owning domain
  spec and the obsolete markdown removed.
- Keep temporary slice files only while a slice is actively being researched or
  implemented.
- When console output shows mojibake for older markdown, preserve the clean
  domain-level meaning and avoid copying corrupted text forward.

## Deferred Governance Decisions

- `DEFAULT_OLLAMA_MODEL` needs a cross-language contract decision because it is
  reflected in backend config, desktop runtime defaults, frontend/e2e fixtures,
  and packaged smoke commands.
- `AGENTS.md` and `CLAUDE.md` dedupe touches cross-agent governance. Keep both
  intact until the preferred instruction strategy is explicit.
- `libs/` creation should wait until at least one shared contract has two
  production consumers or an e2e fixture needs the same typed surface.
