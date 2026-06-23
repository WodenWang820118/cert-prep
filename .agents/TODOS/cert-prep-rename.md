# Cert Prep Rename TODO

- [x] Rename project roots and Nx project references.
  Verify: `pnpm nx show projects --json`

- [x] Rename Python import roots and package metadata.
  Verify: `pnpm nx run cert-prep-backend:test && pnpm nx run cert-prep-ocr-windowsml:test`

- [x] Rename frontend API symbols, files, storage keys, and visible title text.
  Verify: `pnpm nx run cert-prep:test && pnpm nx run cert-prep:build`

- [x] Rename desktop/Tauri package metadata, script paths, process names, and manifest names.
  Verify: `pnpm nx run cert-prep-desktop:typecheck-scripts && pnpm nx run cert-prep-desktop:cargo-test`

- [x] Refresh generated lock/OpenAPI artifacts and drift checks.
  Verify: `uv lock`, old-slug `rg` drift scan, and `git diff --check`
