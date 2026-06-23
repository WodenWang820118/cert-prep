# WinML Package Extraction TODO

- [x] Add `packages/cert-prep-ocr-windowsml` as an Nx-tracked Python package.
  Verify: `pnpm nx show projects --json`

- [x] Move WindowsML runtime/provider/device/NPU implementation into `cert_prep_ocr_windowsml`.
  Verify: `pnpm nx run cert-prep-ocr-windowsml:test`

- [x] Move WindowsML diagnostics/model-prep implementation into the package and leave backend script shims.
  Verify: `pnpm nx run cert-prep-backend:test`

- [x] Update backend runtime build and imports to consume the package.
  Verify: `pnpm nx run cert-prep-backend:lint`

- [x] Run final graph and hygiene checks.
  Verify: `pnpm nx show projects --json && git diff --check`
