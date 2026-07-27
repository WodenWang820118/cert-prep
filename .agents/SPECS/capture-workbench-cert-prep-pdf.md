# cert-prep 真實 capture-workbench PDF 整合規格

## Purpose

讓 cert-prep 的 `/capture-workbench-trial` 使用 registry 安裝的
`@gx-capture/capture-workbench@0.3.0`，透過 cert-prep backend 的既有 Capture Runtime
coordinator，對掃描型 PDF 執行 WindowsML OCR、host structuring，並保存成 cert-prep
source document。

## Non-Goals

- 不修改 capture-workbench public API、CaptureDocument schema 或 Capture Runtime sidecar API。
- 不把 Capture Runtime bearer token 傳入 Angular/WebView。
- 不在 build 階段自動下載 runtime 或 model。
- 不進行遠端 npm/GitHub Release publish。
- 不刪除既有的 workspace source import pipeline。

## Interfaces

- `GET /capture-runtime/ready`：cert-prep backend 以既有 `CaptureRuntimeClient.handshake()`
  驗證 sidecar，回傳 Capture Runtime v1 readiness contract。
- `CertPrepCaptureClient implements CaptureClient`：Angular adapter 使用 cert-prep
  authenticated API；`createCapture` 走既有 document upload，job status 走 document
  polling，結果由 persisted chunks 投影成 CaptureDocumentV1。
- `/capture-workbench-trial`：只允許 PDF、單檔、host structuring owner 為 backend/client。
- `cert-prep:capture-workbench-real-pdf-smoke`：local-only registry/runtime/backend/frontend/
  Playwright acceptance target。

## Key Decisions

- package 版本固定為 `@gx-capture/capture-workbench@0.3.0`，正式 consumer 使用 GitHub
  Packages；Verdaccio 僅保留給 local isolated trial。
- Capture Runtime credential ownership 維持 backend；Angular 只使用 cert-prep API token。
- cert-prep backend 既有 `/documents` coordinator 是唯一實際 parse/persist 路徑，避免同一份
  PDF 被 Web Component 與 backend 重複解析。
- UI adapter 的 CaptureDocumentV1 是從已保存 document/chunks 建立的 host projection；OCR
  provenance 的驗收以 backend persisted `extraction_method=windowsml_ocr`、`has_text`、chunks
  與非空文字為準。
- real-PDF smoke 使用現有無 embedded text 的 `jlpt-n1-page3-qa.pdf`，並使用本機已有的
  WindowsML 六檔模型 artifact 建立 temporary verified model directory/bundle。
- local smoke 的 temporary release manifest 必須使用真實 bundle bytes/SHA-256；既有
  all-zero placeholder 不得作為 real OCR 證據。

## Edge Cases and Failure Modes

- backend 未配置 runtime 或 readiness 不相容時，UI 顯示明確錯誤且不開始 upload。
- upload/document polling 取消時轉送 backend cancellation，並停止前端 task。
- backend document error、no text 或空 chunks 不得發出 completed event。
- UI task remove 不刪除 cert-prep durable document；只清除 Web Component task。
- smoke 必須清理 runtime、backend、frontend、registry/mirror、browser、temporary model 與 staging。

## Acceptance Criteria

- cert-prep 依賴由 registry 安裝，沒有 workspace、symlink 或 `file:` dependency。
- 真實 runtime executable 通過 authenticated readiness。
- 透過真實 trial 頁選取掃描 PDF 後，Capture Workbench 顯示 completed。
- cert-prep 產生 `ready` document，`extraction_method=windowsml_ocr`、`has_text=true`、
  `chunks_count > 0`，且至少一個 chunk text 非空。
- Capture Runtime token 不出現在前端 request URL/header 或 UI state。
- focused tests、既有 regression targets、real-PDF smoke 與 `git diff --check` 通過。

## Test Plan

- Angular adapter unit tests：upload/status/result/cancel/error/abort/token boundary。
- backend readiness proxy contract tests：auth、success、incompatibility、sidecar error。
- page tests：real client wiring、completed refresh、沒有 deterministic copy。
- local distribution test：registry package install、runtime artifact verification、real
  WindowsML extraction、backend persistence、Playwright UI flow、process cleanup。
