# Tauri Packaging 與 Deferred Runtime 規格

## 現況

Windows x64 packaged Tauri app 使用輕量 shell，Python backend runtime、PaddleOCR runtime、Ollama/model 皆透過明確使用者同意與 runtime job 安裝或檢查。初始 installer 不包含 Ollama model 或 PaddleOCR payload。

## 決策

- Startup/health check 不得自動安裝 Ollama、model、PaddleOCR 或 Python backend。
- Runtime artifact 必須以 manifest 宣告 byte size、SHA-256、release URL，安裝前驗證。
- Ollama/model/PaddleOCR 都透過 backend runtime installation API 顯示狀態與 progress。
- package QA JSON 與 runtime manifests 必須對應同一次 build artifact。

## QA 證據

- package QA 已重建 backend/OCR runtime zip、MSI/NSIS bundle，並更新 manifest。
- packaged UI 已驗證 Python/PaddleOCR 可透過 UI ready；reasoning model download 仍需另做 consent/bakeoff 驗證。

## 未解風險

- Tauri product shutdown 仍需 process-tree cleanup，不能只 kill direct child。
- package QA helper 已比 product cleanup 更強，下一階段要把這個能力移回 product。
- 若 release URL 未發布，production QA 可只 patch built target manifest，不得修改 source manifest 假裝發布完成。
