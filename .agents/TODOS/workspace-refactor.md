# Workspace-Level Refactor TODO

## Stale Configuration

- [x] Fix `pnpm-workspace.yaml`: remove `libs/**` or create the `libs/` directory. The pattern references a directory that does not exist, which is misleading.
  Affected: `pnpm-workspace.yaml`
  Verify: `ls -d libs/ 2>/dev/null && echo "exists" || echo "missing"` (decide: create or remove)

## Duplicate Agent Files

- [ ] Merge or deduplicate `AGENTS.md` and `CLAUDE.md`. Both contain identical Nx configuration guidelines. Keep one as the canonical source and have the other reference it, or remove the duplicate.
  Affected: `AGENTS.md`, `CLAUDE.md`
  Verify: `diff AGENTS.md CLAUDE.md` (should show no diff after merge, or one file should be a symlink/reference)

## Package Metadata

- [x] Rename the root `package.json` `"name"` field from `"@org/source"` to something project-appropriate (e.g., `"@cert-prep/source"` or `"cert-prep"`).
  Affected: `package.json`
  Verify: `pnpm nx show projects --json` (should still work after rename)

## Outdated TypeScript Base Config

- [x] Update `tsconfig.base.json`:
  - `moduleResolution`: `"node"` -> `"bundler"` (or keep only in child configs)
  - `target`: `"es2015"` -> `"es2022"` (match the Angular app's tsconfig)
  - Remove `emitDecoratorMetadata: true` (the Angular app sets `emitDecoratorMetadata: false` anyway)
  Affected: `tsconfig.base.json`
  Verify: `pnpm nx run cert-prep:build && pnpm nx run cert-prep-e2e:lint`

## Missing Shared Libraries

- [ ] Evaluate extracting common patterns into `libs/` shared libraries. Candidates include:
  - API client generation and error handling
  - Store patterns (OperationStore-like busy/error management)
  - Contract types shared between frontend and e2e tests
  Start by creating a `libs/shared-types` or `libs/api-client` project.
  Verify: `pnpm nx show projects --json` (should list new libs)

## Final Check

- [ ] Full workspace audit:
  Verify: `pnpm nx run-many --target=lint --all && pnpm nx run-many --target=test --all --skip-nx-cache && pnpm nx run-many --target=build --all`
