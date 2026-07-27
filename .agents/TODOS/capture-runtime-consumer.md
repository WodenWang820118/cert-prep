# Capture Runtime Release Consumer TODO

- [x] Implement the explicit release installer and Nx target.
  Verify: `pnpm nx run cert-prep-desktop:install-capture-runtime --skip-nx-cache`

- [x] Resolve the installed staging root from `prepare-runtime-resources` without
  introducing build-time network access.
  Verify: `pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`

- [x] Synchronize runtime version `0.3.0` across desktop, backend, fixtures, and
  durable capture-workbench documentation.
  Verify: `rg -n "capture-runtime|CAPTURE_RUNTIME|0\\.1\\.0" apps/cert-prep-desktop apps/cert-prep-backend .agents/SPECS/capture-workbench.md`

- [x] Add installer contract tests for valid, tampered, mismatched, and unsafe
  release inputs.
  Verify: `pnpm nx run cert-prep-desktop:capture-runtime-consumer-test --skip-nx-cache`

- [x] Add the local release mirror and actual-sidecar cert-prep host flow smoke.
  Verify: `pnpm nx run cert-prep-desktop:capture-runtime-consumer-smoke --skip-nx-cache`

- [ ] Run full regression and final worktree/process evidence checks. The current
  backend full test target still has three unrelated OpenAPI generator assertion
  failures; the desktop/package and backend lint checks passed.
  Verify: `pnpm nx run cert-prep-desktop:typecheck-scripts --skip-nx-cache; pnpm nx run cert-prep-desktop:cargo-test --skip-nx-cache; pnpm nx run cert-prep-backend:test --skip-nx-cache; git diff --check`
