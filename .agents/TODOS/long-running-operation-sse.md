# Long-Running Operation SSE TODO

- [x] Add the durable-change revision notifier to the backend database boundary.
  Verify: `pnpm nx run cert-prep-backend:test --skip-nx-cache -- tests/test_database_migrations.py`

- [x] Add snapshot SSE endpoint helpers and the six scoped backend routes.
  Verify: `pnpm nx run cert-prep-backend:test --skip-nx-cache -- tests/test_operation_sse.py`

- [x] Add the shared authenticated Angular SSE client/parser and preserve the
      existing Capture Workbench parser contract.
  Verify: `pnpm nx run cert-prep:test --skip-nx-cache -- --include='**/*sse*.spec.ts'`

- [x] Replace Source Import operation/document polling with a document SSE
      subscription; delete polling timers, retry constants, and obsolete
      reconciliation methods from the scoped lifecycle.
  Verify: `pnpm nx run cert-prep:test --skip-nx-cache -- --include='**/*source-import*.spec.ts'`

- [x] Replace draft job and manual operation polling with draft SSE
      subscriptions; delete the old polling store and retry paths.
  Verify: `pnpm nx run cert-prep:test --skip-nx-cache -- --include='**/*draft-review*.spec.ts'`

- [x] Replace HTTP runtime/model job polling with runtime SSE subscriptions;
      keep explicit refresh actions as one-shot GET snapshots only.
  Verify: `pnpm nx run cert-prep:test --skip-nx-cache -- --include='**/*runtime*.spec.ts'`

- [x] Regenerate the OpenAPI client and update backend/frontend contract tests.
  Verify: `pnpm nx run cert-prep-backend:generate-openapi-client --skip-nx-cache`

- [x] Run final targeted gates and inspect for scoped polling residue.
  Verify: `pnpm nx run cert-prep-backend:lint --skip-nx-cache`; `pnpm nx run cert-prep-backend:test --skip-nx-cache`; `pnpm nx run cert-prep:lint --skip-nx-cache`; `pnpm nx run cert-prep:test --skip-nx-cache`; `pnpm nx run cert-prep:build --skip-nx-cache`; `git diff --check`
