# Downloadable Runtimes TODO

- [x] Add backend health metadata for active Python runtime.
      Verify: `pnpm nx run exam-prep-backend:test`; `pnpm nx run exam-prep-backend:generate-openapi-client`

- [x] Add backend runtime artifact manifest generation.
      Verify: `pnpm nx run exam-prep-backend:build-backend-runtime`

- [x] Replace Tauri bundled sidecar startup with downloadable runtime status/install commands.
      Verify: `pnpm nx run exam-prep-desktop:cargo-test`

- [x] Add Angular desktop runtime store and startup checklist gating.
      Verify: `pnpm nx run exam-prep:test`

- [x] Update package scripts and QA checks for release URL manifests.
      Verify: `pnpm nx run exam-prep-desktop:package-qa-test`

- [x] Run final workspace checks.
      Verify: `pnpm nx run exam-prep-backend:lint`; `pnpm nx run exam-prep:build`; `pnpm nx run exam-prep-desktop:lint`; `pnpm nx run exam-prep-desktop:build`
