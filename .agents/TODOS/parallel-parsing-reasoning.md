# Parallel Parsing And Reasoning Active TODO

> Active backlog only. 已完成項目已吸收至 `.agents/SPECS/parallel-parsing-reasoning.md` 與 `.agents/SPECS/parallel-parsing-reasoning-qa.md`。

- [ ] 改善 OCR health cold-start UX
  - Reason: packaged QA 中 Runtime drawer 會暫時顯示 `OCR unknown`，Refresh button disabled；約 10 到 29 秒後才 settled。
  - Verify: packaged screenshot 顯示 loading/settling copy 清楚，不需要 QA 腳本額外等待或手動 refresh。
  - 2026-06-19 progress: frontend health now treats any snapshot refresh as OCR checking/warming, but the latest packaged smoke was captured before that final tweak and still recorded an OCR-unknown observation. Keep open until packaged evidence confirms the drawer no longer shows unknown during settling.

- [ ] 縮短 first chunk latency，改善 use-while-parsing 體感
  - Reason: worker `1` first chunk 約 43.9 秒，worker `2` 約 80.5 秒；15 秒中途截圖仍沒有 chunk。
  - Verify: packaged flow 在 parsing 開始後 15 秒內可看到至少一個 chunk，且最終 46 pages / 46 chunks 無回歸。
  - 2026-06-19 progress: backend now prewarms a primary external Paddle worker and flushes OCR pages as they complete; latest packaged evidence improved from about 76s to `20,713 ms` backend first chunk, but still misses the 15s gate. Keep open.

- [x] 釐清 packaged app graceful close 與 process cleanup
  - Reason: QA wrapper 送 Alt+F4 後 app 未自行退出，最後用 `taskkill /T /F` fallback；雖未留下 backend process，但需要確認真實使用者關窗是否會觸發 Rust cleanup。
  - Verify: packaged QA 可透過正常 window close 結束 app，結束後沒有 `exam-prep-desktop.exe`、`exam-prep-backend.exe` 或 OCR worker process。
  - 2026-06-19 evidence: `tmp/exam-prep-desktop/packaged-flow-smoke/2026-06-19T03-24-37-213Z/metrics.json` reports `gracefulExited=true`, `fallbackUsed=false`, `exitCode=0`, empty `residualProcesses`, and no this-run Node helpers left to close.

- [ ] 執行 live reasoning-model bakeoff
  - Reason: harness 已完成，但本機 Ollama 當下不可連線，無法比較 `qwen3:14b`、`deepseek-r1:14b`、`gemma4:12b`。
  - Verify: 固定 JLPT pages/chunks，記錄 JSON validity、citation validity、group detection、latency、manual-review burden；AI output 仍只進 draft，不自動 approve。
- [ ] streaming parse-to-qwen research/prototype
  - Reason: user wants to explore parsing one page/chunk and immediately sending it to qwen for formal draft-question generation while the remaining PDF pages continue parsing.
  - Verify: `.agents/SPECS/streaming-parse-to-qwen.md` defines the local queue/outbox design, no-Kafka-first decision, draft-only safety rules, and prototype validation plan; close only after a prototype has artifact-backed timing and draft-quality evidence.
  - 2026-06-19 progress: implemented the first SQLite-backed streaming draft job prototype with bounded worker, draft-only append persistence, missing-model/provider skip states, frontend draft polling, and generated client updates. Keep open until packaged timing and live qwen draft-quality evidence exist.

- [x] Remove unused code across projects
  - Reason: keep every project easier to understand by removing truly unused classes, files, functions, imports, test helpers, and script code without widening behavior.
  - Verify: repo-wide dead-code audit with project-scoped deletions, matching Nx tests/lints/builds for affected projects, and no removal of public contracts, generated files, or extension points that are still intentionally reserved.
  - 2026-06-19 evidence: removed unused frontend `OperationStore` members, retired the unused backend mock-exam model-download manager/protocol, and deleted unused desktop package-QA sidecar helpers. Verified with affected Nx lint/test/build/typecheck/package-QA/cargo lanes.
  - 2026-06-19 follow-up evidence: removed unused backend streaming prototype leftovers (`DraftGenerationJobStatus.CANCELLED`), unused exam-content public wrappers, and unused external Paddle OCR health serialization helper. Frontend and desktop sub-agent audits found no additional safe delete-only candidates.
