# Exam Prep 產品基線規格

## 現況

Exam Prep 是 local-first Windows/Tauri 桌面學習工具。使用者可建立 project、匯入 PDF、保存解析文字、整理選擇題草稿、核准題目、練習作答，並從錯題清單回到修正流程。

目前產品已從早期「文字 PDF + Gemma」設計演進為「OCR first + manual review + optional reasoning enrichment」：

- `apps/exam-prep`：Angular UI。
- `apps/exam-prep-backend`：FastAPI sidecar，負責 SQLite、PDF、OCR、draft、practice。
- `apps/exam-prep-desktop`：Tauri v2 wrapper，負責 packaged runtime 與 sidecar lifecycle。
- `apps/exam-prep-e2e`：Playwright e2e。

## 決策

- PDF 解析結果與題目草稿是 project 內可重開的資料，不是一次性畫面狀態。
- PaddleOCR 是 image-only PDF 的主要文字來源；Gemma/reasoning model 只作 optional enrichment。
- 可考題庫只使用 `approved` drafts；AI 或 deterministic 產生的項目預設都需要人工核准。
- Backend OpenAPI 是前端 client contract 的來源，schema 變更後要重新產生 client。
- SQLite 仍由 backend migration 管理；Angular 不直接寫 filesystem。

## QA 證據

- 早期 v1 full-loop、UI system、DDD refactor、downloadable runtime、async parsing 的完成證據已分散在對應 SPECS/QA 檔。
- packaged Tauri QA 已用真實 JLPT PDF 驗證：OCR、manual draft、approval、practice、wrong-answer cleanup、restart persistence 均可走通。
- 近期 active evidence 以 `saved-parsed-exams-runtime-ux-qa.md` 與 `parallel-parsing-reasoning-qa.md` 為準。

## 未解風險

- 46 頁 OCR PDF 的 wall time 仍偏長。
- packaged app child process cleanup 需要更強 process-tree shutdown。
- reasoning model bakeoff 尚未完成，不能把 `qwen3:14b` 視為已驗證最佳模型。
- 舊文件若仍提到「v1 不支援 OCR」或「Gemma 是必需品」，均視為被本規格 superseded。
