# Parsing And Reasoning 常犯錯清單

Status: reference log，不是 active backlog。active TODO 只放在 `.agents/TODOS/parallel-parsing-reasoning.md`。

- UTF-8/mojibake：PDF 檔名、日文 OCR text、SQLite evidence、Markdown report 都要用 UTF-8 讀寫；PowerShell 讀 JSON 時明確加 `-Encoding UTF8`。
- OpenAPI drift：backend schema 變更後要重產 `exam-prep-api.generated.ts`，並跑 frontend tests。
- Package QA JSON stale：每次 build/package QA 後檢查 `generated_at`、bundle bytes、runtime manifest artifact。
- Runtime manifest churn：manifest diff 可能只是 artifact hash/bytes 更新；commit 前確認是否來自本輪 build。
- PowerShell quoting：JSON、regex、argv 容易被 PowerShell 轉義影響；複雜腳本優先放進 `.mts` 或 `.cjs` helper。
- Tauri CLI/runtime assumption：packaged QA 必須走 Nx target，確認 release exe、runtime zip、manifest 都是 current artifact。
- Runtime process cleanup：QA helper 不要只 `app.kill()`；正常關窗失敗時才用 `taskkill /T /F`，並記錄是否留下 spawned process。
- AI draft auto-approval：reasoning output 永遠只能是 draft；manual approval 前不能進 Full Exam 或 Random Quiz。
- OCR worker stdout contamination：JSONL worker stdout 只能輸出 JSON；第三方 log 要隔離到 stderr，避免 protocol 解析失敗。
- Optional AI blocks OCR：Ollama/model offline 不可阻塞 OCR、manual drafts、Full Exam、Random Quiz、Wrong Answer review。
- Single-page render failure：單頁 render/OCR 失敗不能讓整份文件變成 0 chunks；需要 page-level failure 記錄與 retry 策略。
- Source excerpt grounding：approval 需要 citation/source excerpt 連回 raw chunk text，不可只依賴 whitespace-normalized text。
- Runtime state stale：Python/PaddleOCR install 後要立即 refresh backend/runtime health；requirements endpoint 失敗時不應清空已知 good health。
- First chunk latency：即使支援 as-completed flush，仍要量測 UI 可見時間；page 1 慢或 OCR worker warmup 會讓 use-while-parsing 體感變差。
- Progress bar mismatch：`46/46` 時 bar 必須滿格；ready/final status 要用 completed page count。
- Restart project selection：restart 後 parsed content 與 last/first project selection 都要自動恢復；健康檢查不可阻塞 project selection。
