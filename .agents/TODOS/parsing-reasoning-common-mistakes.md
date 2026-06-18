# Parsing And Reasoning 常犯錯清單

Status: reference log. 這不是 active backlog；後續 QA 若再發生，才升格到 active TODO。

- UTF-8/mojibake：PDF 檔名、OCR text、SQLite evidence、Markdown report 都要用 UTF-8 檢查；問號替代字串或 replacement char 是 QA finding。
- OpenAPI client drift：backend schema 變更後必須重產 `exam-prep-api.generated.ts` 並跑 frontend tests。
- Package QA JSON stale：只相信與當前 artifact timestamp/bytes/hash 對得上的 JSON。
- Runtime manifest churn：manifest diff 只在對應當前 build artifact 時保留，不手改成測試通過。
- PowerShell quoting：長 JSON/argv smoke test 優先用檔案或 argv-safe escaping，不把 inline quoting 當可靠證據。
- Tauri CLI/runtime assumption：packaged QA 前確認 Nx target、runtime zip、manifest、release exe 都是 current。
- Runtime process cleanup：QA helper 可用 `taskkill /T /F` 清理已知 spawned process；product 仍要做 process-tree shutdown。
- AI draft auto-approval：reasoning output 永遠是 draft，只有人工 approval 才可進 full/random quiz。
- OCR worker stdout contamination：JSONL worker stdout 只能是 JSON；非 JSON stdout 要變成清楚 worker failure。
- Optional AI blocks OCR：Ollama/model offline 不可阻擋 OCR、manual drafts、full exam、random quiz、wrong-answer review。
- Single-page render failure：單頁 render fail 不可讓整份文件 0 chunks；應保存其他頁結果與 page-level failure。
- Source excerpt grounding：approval 所需 excerpt 必須能對回 raw chunk text，不可只存 whitespace-normalized 版本。
- Runtime state stale：Python install 後要立即 refresh backend/runtime state。
- First chunk latency：worker pool 若等全部 futures 完成才 flush，use-while-parsing 會失效。
- Progress bar mismatch：文字 `46/46` 但 bar 不滿格是 UX bug。
- Restart project selection：restart 後 parsed content 存在但 project 未選回，會讓 persistence 看似失敗。
