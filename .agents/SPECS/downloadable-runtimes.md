# Downloadable Runtimes 規格

## 現況

Packaged app 可以在 Python/backend runtime 尚未安裝時啟動 UI，並透過 runtime drawer 讓使用者明確安裝 Python backend、檢查 Ollama/model、安裝 PaddleOCR。

## 決策

- Python runtime 指 packaged backend executable zip，不是 machine-wide Python。
- Runtime 安裝到 Tauri app data directory。
- Backend HTTP calls 在 desktop runtime ready 前要被 gate。
- Ollama/model 是 reasoning enrichment 的 optional dependency，不可阻擋 OCR/manual workflow。

## QA 證據

- packaged QA 已驗證 Python backend runtime install、PaddleOCR ready、OCR/manual flow。
- `runtime/requirements`、package QA manifest tests、Tauri cargo tests 曾通過。

## 未解風險

- Python runtime 安裝完成後 UI 狀態有短暫 stale message。
- Runtime drawer 對 Ollama install/launch/model pull 的 guided journey 還不夠完整。
- Manifest parse error 需要更友善訊息，避免 QA 只能從 logs 判斷。
