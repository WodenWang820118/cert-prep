# Cert Prep PDF and Image Acceptance TODO

- [x] Bind the explicit image fixture and preserve the existing PDF options.
  Verify: `pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`

- [x] Bind the installed executable/runtime identity to the downloaded
      candidate and catalog-verified OCR worker.
  Verify: `pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`

- [x] Mask private OCR/source content in every persisted screenshot.
  Verify: `pnpm nx run cert-prep-desktop:typecheck-scripts --skip-nx-cache`

- [x] Add image OCR terminal evidence and a packaged acceptance journey.
  Verify: `pnpm nx run cert-prep-desktop:typecheck-scripts --skip-nx-cache`

- [x] Include both source results and truthful failure cleanup in the acceptance
      manifest without cross-attributing PDF failures.
  Verify: `pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`

- [x] Keep hosted CI hermetic and remove the non-provisioned real gate.
  Verify: `pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`

- [x] Fix the backend reconciliation deadline race and remove the unreachable
      OCR render-scale override.
  Verify: backend contract tests and `cert-prep-desktop:cargo-test`

- [x] Run the installed-artifact gate with supplied installed executable, PDF,
      image, and downloaded runtime inputs.
  Verify: `pnpm nx run cert-prep-desktop:acceptance-real --skip-nx-cache`
