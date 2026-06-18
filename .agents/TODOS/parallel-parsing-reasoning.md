# Parallel Parsing And Reasoning Active TODO

> Active backlog only. 已完成項目已吸收至 `.agents/SPECS/parallel-parsing-reasoning.md` 與 `.agents/SPECS/parallel-parsing-reasoning-qa.md`。

- [ ] 改善 OCR health cold-start UX
  - Reason: packaged QA 中 Runtime drawer 會暫時顯示 `OCR unknown`，Refresh button disabled；約 10 到 29 秒後才 settled。
  - Verify: packaged screenshot 顯示 loading/settling copy 清楚，不需要 QA 腳本額外等待或手動 refresh。

- [ ] 縮短 first chunk latency，改善 use-while-parsing 體感
  - Reason: worker `1` first chunk 約 43.9 秒，worker `2` 約 80.5 秒；15 秒中途截圖仍沒有 chunk。
  - Verify: packaged flow 在 parsing 開始後 15 秒內可看到至少一個 chunk，且最終 46 pages / 46 chunks 無回歸。

- [ ] 釐清 packaged app graceful close 與 process cleanup
  - Reason: QA wrapper 送 Alt+F4 後 app 未自行退出，最後用 `taskkill /T /F` fallback；雖未留下 backend process，但需要確認真實使用者關窗是否會觸發 Rust cleanup。
  - Verify: packaged QA 可透過正常 window close 結束 app，結束後沒有 `exam-prep-desktop.exe`、`exam-prep-backend.exe` 或 OCR worker process。

- [ ] 執行 live reasoning-model bakeoff
  - Reason: harness 已完成，但本機 Ollama 當下不可連線，無法比較 `qwen3:14b`、`deepseek-r1:14b`、`gemma4:12b`。
  - Verify: 固定 JLPT pages/chunks，記錄 JSON validity、citation validity、group detection、latency、manual-review burden；AI output 仍只進 draft，不自動 approve。
