# Parallel Parsing 與 Reasoning 工程現況

## 現況

此 slice 已完成 saved parsed exams/runtime UX 之後的效能與 reasoning foundation。產品目前以 PaddleOCR 擷取 PDF 文字，deterministic parser 產生可人工審核的 draft；approved drafts 是 Full Exam 與 Random Quiz 的唯一可考題庫。

Root/coordinator 已完成文件整理與 baseline commit：`f1fd9dc feat: stabilize parsed exams and parsing foundation`。

## 決策

- `EXAM_PREP_OCR_PAGE_WORKERS` 預設維持 `1`。
- worker `2` 為 measured option，只有同 build QA 達到 wall time 改善 `>=20%`、page/chunk 無回歸、GPU memory < 90%、first chunk 明顯提前時才可提議升預設。
- OCR workers 不直接寫 DB；主 processing thread 負責依 page number 穩定持久化 chunks/progress。
- Deterministic/manual path 是 production acceptance path，不依賴 LLM。
- Reasoning model 是 optional enrichment，輸出只能是 draft，不可自動 approve，不保存 chain-of-thought。
- UI copy 使用 Reasoning model，不再硬編 Gemma；預設候選為 `qwen3:14b`，`deepseek-r1:14b` 與 `gemma4:12b` 作 bakeoff comparator。

## 已完成項目

- 文件整理：`.agents/SPECS` 精簡為繁中「現況、決策、QA 證據、未解風險」格式；已完成 TODO 吸收進 SPECS。
- Backend parsing：OCR futures 以完成順序回傳；主 thread 依頁碼 idempotent 寫入 chunks/progress，最終順序穩定。
- Backend tests：新增 page 2 先完成時 chunk 可提早出現且最終排序正確的測試。
- Practice/domain：full-document 與 random-draw session 已可基於 approved drafts 運作，session 保存 immutable question snapshot。
- Package QA：`package-qa.mts` 支援 `--ocr-page-workers` 與環境參數，不再 hardcode `2`。
- Runtime UX：health load 改為部分成功可落地，optional AI/runtime requirements 不會把 OCR/project startup 全部卡成 unknown。
- Startup UX：project loading/selection 不等待 OCR health；restart 時可回到既有 project list 與 persistence flow。
- Desktop cleanup：Tauri Rust 端已有 process-tree cleanup 測試，replacement/window destroy/Drop 會嘗試清 spawned backend tree。
- Reasoning bakeoff：新增 harness 與測試；模型不可用時記錄 `ollama_unavailable`，不觸發下載或 approval。

## QA 證據

主要 QA 報告：`.agents/SPECS/parallel-parsing-reasoning-qa.md`

## Streaming Page-To-Qwen Research

User-added research topic on 2026-06-19: parse each page/chunk and immediately
start qwen draft-question generation while the remaining PDF pages continue
parsing.

Research plan: `.agents/SPECS/streaming-parse-to-qwen.md`
QA placeholder: `.agents/SPECS/streaming-parse-to-qwen-qa.md`

Initial architecture decision: do not add Kafka for the first local-first slice.
Use a SQLite-backed job queue/outbox plus a bounded qwen worker, and keep Kafka or
another broker as a future option only for distributed workers, fan-out, durable
multi-consumer replay, or multi-user service deployment.

Status on 2026-06-19: research/prototype evidence is complete. Packaged smoke
`tmp/exam-prep-desktop/packaged-flow-smoke/2026-06-19T08-37-53-476Z/metrics.json`
used `qwen3:8b` as a QA override and recorded a streamed usable qwen draft at
`22,301 ms`, before parse completion at `25,394 ms`. Remaining model availability
and three-model comparison work stay under the live reasoning-model bakeoff
backlog item.

## Dead Code Cleanup

User-added backlog topic on 2026-06-19: audit all projects and remove truly
unused classes, files, functions, imports, test helpers, and script code so the
workspace stays simpler to understand.

Scope rule: this is cleanup only. Do not remove generated files, public API
contracts, intentionally reserved extension points, or code paths that are only
reachable in packaged/runtime QA without matching evidence. Each deletion slice
must be project-scoped and verified through the relevant `pnpm nx ...` tests,
lints, builds, or package checks.

Status: completed for the 2026-06-19 audit slice. Evidence is recorded in
`.agents/SPECS/parallel-parsing-reasoning-qa.md`.

同 build packaged production flow：

- worker `1`：`.agents/tmp/parallel-parsing-reasoning/2026-06-18T06-58-03-170Z/`
- worker `2`：`.agents/tmp/parallel-parsing-reasoning/2026-06-18T06-54-25-686Z/`

結論：worker `2` 沒有改善，預設不升。兩者皆完成 46 pages / 46 chunks，Full Exam、Random Quiz、Wrong Answer review 與 restart persistence 皆通過。

## 未解風險

- OCR health cold start 與 Refresh disabled 狀態仍會造成短時間 OCR unknown。
- First chunk latency 仍偏高，use-while-parsing 體感尚未達標。
- CDP/automation graceful close 未能讓 packaged app 自行退出；目前 QA wrapper 用 `taskkill /T /F` 作 fallback，需釐清真實使用者關窗情境。
- Reasoning model live bakeoff 尚未完成，因本機 Ollama 當下不可連線。
- Angular bundle initial budget warning 尚未處理。
