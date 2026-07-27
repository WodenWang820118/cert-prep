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

- [x] Consume the published `@gx-capture/capture-workbench@0.3.0` package from GitHub
  Packages in CI and download the matching runtime from the public GitHub
  Release by default. The legacy sibling checkout/local archive installer was
  removed; local Verdaccio remains an explicit isolated diagnostic only.
  Verify: `pnpm install --frozen-lockfile` with GitHub Packages auth and
  `pnpm nx run cert-prep-desktop:install-capture-runtime --skip-nx-cache`

- [x] Run full regression and final worktree/diff checks. Desktop script
  typecheck, Rust contract tests, and the backend full test target passed; the
  backend emitted only the existing httpx/Starlette deprecation warning.
  Verify: `pnpm nx run cert-prep-desktop:typecheck-scripts --skip-nx-cache; pnpm nx run cert-prep-desktop:cargo-test --skip-nx-cache; pnpm nx run cert-prep-backend:test --skip-nx-cache; pnpm nx run cert-prep-desktop:process-residue-audit --skip-nx-cache; git diff --check`
