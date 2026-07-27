# cert-prep 真實 capture-workbench PDF 整合 TODO

- [ ] 建立 backend readiness proxy 與 OpenAPI client contract
  Verify: `pnpm nx run cert-prep-backend:test --skip-nx-cache --testPathPattern capture_runtime`

- [ ] 實作 `CertPrepCaptureClient` 與純函式 document/chunk projection
  Verify: `pnpm nx run cert-prep:test --skip-nx-cache --testPathPattern capture-workbench`

- [ ] 將 `/capture-workbench-trial` 改成 backend-backed real page
  Verify: `pnpm nx run cert-prep:test --skip-nx-cache --testPathPattern capture-workbench`

- [ ] 保持 registry install contract 並加入 real-PDF smoke Nx target
  Verify: `pnpm nx run cert-prep:install:capture-workbench:local --skip-nx-cache`

- [ ] 驗證 local real WindowsML OCR 流程與 Playwright UI
  Verify: `pnpm nx run cert-prep:capture-workbench-real-pdf-smoke --skip-nx-cache`

- [ ] 執行 focused/regression checks、cleanup、diff review
  Verify: `git diff --check`
