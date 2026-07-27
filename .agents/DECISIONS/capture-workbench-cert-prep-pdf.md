# capture-workbench cert-prep PDF 整合決策

## Chosen approach

保留現有 `/capture-workbench-trial` route，將 in-memory deterministic client 替換為
`CertPrepCaptureClient`。此 adapter 不直連 Capture Runtime，而是呼叫 cert-prep backend
authenticated API；backend 的既有 `/documents` route 已包含 Capture Runtime coordinator、
host structuring 與 durable persistence。

## Rejected alternatives

- Browser 直連 Capture Runtime：會暴露 process-scoped bearer token，違反既有安全邊界。
- Web Component 再直接呼叫 sidecar、完成後另一次 `/documents` upload：會重複解析 PDF。
- 只使用 fake extraction 或 embedded-text PDF：無法證明掃描 PDF 的真實 WindowsML OCR。
- 新增 runtime npm/Python dependency：不符合 release sidecar 交付模型。

## Verification assumptions

- `jlpt-n1-page3-qa.pdf` 是 scanned/image-only fixture，沒有 embedded text。
- 本機已有 cert-prep WindowsML model artifact，可在 temporary workspace 展開成 Capture Runtime
  需要的六個模型檔案。
- placeholder release descriptor 只可留在既有 fixture；real-PDF smoke 另建真實 temporary
  descriptor，且不進行遠端發布。
