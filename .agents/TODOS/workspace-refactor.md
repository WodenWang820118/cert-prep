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

- [x] Extract the generated OpenAPI client/types into `libs/cert-prep-api`.
  - Keep Angular DI/HttpClient runtime config in `apps/cert-prep/src/app/cert-prep-api.ts`.
  - Use `@cert-prep/api` from both the Angular app facade and Playwright e2e mock fixtures.
  - Defer store/component pattern extraction until there is a concrete second production consumer.
  Verify:
  - `pnpm nx show projects --json` lists `cert-prep-api`
  - `pnpm nx show project cert-prep-api --json` resolves inferred `lint` / `vite:test` targets
  - `pnpm nx run cert-prep-backend:generate-openapi-client`
  - `pnpm nx run cert-prep-api:lint`
  - `pnpm nx run cert-prep-api:vite:test`
  - `pnpm nx run cert-prep-api:typecheck`
  - `pnpm nx run cert-prep:lint`
  - `pnpm nx run cert-prep:test --skip-nx-cache`
  - `pnpm nx run cert-prep:build --skip-nx-cache`
  - `pnpm nx run cert-prep-e2e:lint`
  - `pnpm nx run cert-prep-e2e:e2e`
  Note: `cert-prep-e2e` now has `scope:cert` / `type:e2e` tags so Nx module
  boundaries allow its typed dependency on `@cert-prep/api`.

## Final Check

- [ ] Full workspace audit:
  Verify: `pnpm nx run-many --target=lint --all && pnpm nx run-many --target=test --all --skip-nx-cache && pnpm nx run-many --target=build --all`
