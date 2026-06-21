# Parallel Parsing 與 Reasoning QA

## 現況

已使用同一個 packaged Tauri build 驗證 production flow。測試 PDF 為 `pdfs/【1】2025年07月N1 真题.pdf`，語言提示為 `ja`，runtime 使用已安裝的 Python backend 與 PaddleOCR，避免把下載時間混進 parsing 效能。

最新 package QA JSON：`tmp/exam-prep-desktop/package-qa/package-qa.json`，產生時間 `2026-06-18T06:49:02.451Z`。Bundle 大小：MSI `3.95 MB`，NSIS `2.76 MB`，backend runtime `43.1 MB`，OCR runtime `632.65 MB`。

## 自動化驗證

| 指令 | 結果 | 備註 |
| --- | --- | --- |
| `pnpm nx run exam-prep-backend:test` | Passed | 80 tests passed；保留 Starlette/httpx warning。 |
| `pnpm nx run exam-prep-backend:lint` | Passed | Ruff all checks passed。 |
| `pnpm nx run exam-prep:test --skip-nx-cache` | Passed | 32 frontend tests passed。 |
| `pnpm nx run exam-prep:lint` | Passed | Angular lint passed。 |
| `pnpm nx run exam-prep-e2e:e2e` | Passed | 3 Playwright tests passed。 |
| `pnpm nx run exam-prep-desktop:typecheck-scripts` | Passed | script TypeScript typecheck passed。 |
| `pnpm nx run exam-prep-desktop:package-qa-test` | Passed | package QA unit tests passed。 |
| `pnpm nx run exam-prep-desktop:cargo-test` | Passed | 12 Rust tests passed。 |
| `pnpm nx run exam-prep-desktop:package-qa --skip-nx-cache --args='--ocr-page-workers 1'` | Passed | 重新產出 release exe、MSI、NSIS、runtime manifests。 |

已知非阻斷 warning：Angular initial bundle 超出 `700 kB` budget 約 `61 kB`；Cargo PDB filename collision warning；Paddle/PyInstaller build log 仍有 console encoding mojibake。

## Production Flow Evidence

worker `1` artifact：`.agents/tmp/parallel-parsing-reasoning/2026-06-18T06-58-03-170Z/`

worker `2` artifact：`.agents/tmp/parallel-parsing-reasoning/2026-06-18T06-54-25-686Z/`

兩輪皆完成：

- Runtime drawer 進入 OCR ready 狀態。
- 建立 project，選擇 PDF 並設定 `language_hint=ja`。
- Upload 後立即看到 processing。
- Parsing 中 UI 仍可操作，且 chunk preview 會出現。
- Parsing complete 後顯示 metrics。
- 產生 deterministic draft，手動編輯 answer/rationale 後 approve。
- Full Exam 可啟動並記錄 wrong answer。
- Review panel 顯示 wrong answer。
- Random Quiz 再答對後 Review panel 清空。
- Restart persistence verified。

另有 Python runtime fresh install 證據：`.agents/tmp/parallel-parsing-reasoning/2026-06-18T06-35-08-482Z/`，包含 Python missing、install consent、runtime ready 截圖。後續效能測試保留 runtime，以免下載時間污染 parsing 數據。

## 效能比較

| Workers | Artifact | Upload visible | First chunk visible | Parse complete visible | GPU memory peak | GPU util peak | 結果 |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | `2026-06-18T06-58-03-170Z` | 660 ms | 43,870 ms | 66,941 ms | 2,350/8,188 MiB, 28.7% | 94% | 46 pages, 46 chunks, ready |
| 2 | `2026-06-18T06-54-25-686Z` | 580 ms | 80,507 ms | 100,294 ms | 4,221/8,188 MiB, 51.6% | 100% | 46 pages, 46 chunks, ready |

決策：不提升預設 worker count。`2` workers 沒有達到 wall time 改善 `>=20%`，反而在此輪較慢；GPU memory 未超過 90%，但 GPU utilization 已打滿。預設維持 `1`，`2` 只保留為後續調校選項。

## SQLite Evidence

最新 worker `1` DB：`%APPDATA%/dev.certprep.exam-prep/exam-prep.sqlite3`

- projects：1
- documents：1
- document_chunks：46
- question_drafts：1
- practice_sessions：2
- practice_attempts：2

Document sample：`status=ready`，`page_count=46`，`processed_page_count=46`，`chunk_count=46`，`extraction_method=paddle_ocr_gpu`，`ocr_device=gpu:0`，`language_hint=ja`，`ocr_worker_count=1`，`first_chunk_ms=43828`，`content_profile=mixed`。

Approved draft sample：`status=approved`，`answer_key_source=manual`，`citation_page=2`，`item_kind=vocabulary_single`，`source_question_number=1`。

Session sample：存在 `full_document` 與 `random_draw` 兩種 session，兩者皆保存 `question_ids_json` snapshot；random draw 有 seed。

worker `2` backup DB：`.agents/tmp/appdata-backup-before-worker1-valid-20260618-145755/exam-prep.sqlite3`

- `page_count=46`
- `processed_page_count=46`
- `chunk_count=46`
- `ocr_worker_count=2`
- `parse_wall_duration_ms=99551`
- `first_chunk_ms=79381`

## Reasoning Bakeoff

已建立 harness 與 backend test，並跑過 `pnpm nx run exam-prep-backend:reasoning-bakeoff`。輸出在 ignored artifact `apps/exam-prep-backend/.benchmarks/reasoning-bakeoff-20260618T053505Z.json`。

本機當下 Ollama 不可連線，所以 `qwen3:14b`、`deepseek-r1:14b`、`gemma4:12b` 都是 `ollama_unavailable / ConnectionError`。此輪只驗證 harness 不會自動下載、不會自動 approve、不保存 chain-of-thought；模型品質比較仍是 active TODO。

## 未解風險

- OCR health cold start 仍會讓 drawer 暫時顯示 OCR unknown，測試中約 10 到 29 秒後才 settled；需要更好的 loading copy 或非阻塞 health cache。
- First chunk 仍未在 15 秒內可見；雖然 backend 已支援 as-completed flush，但 use-while-parsing 體感還需要縮短。
- QA wrapper 的 Alt+F4 graceful close 未讓 packaged app 自行退出，最後用 `taskkill /T /F` 清掉 process tree；未留下殘留行程，但仍需釐清 CDP 關窗與實際使用者關窗差異。
- Reasoning model bakeoff 需要在 Ollama server 與候選模型可用時重跑。

## 2026-06-19 Execution Evidence

Commands run:

- `pnpm nx run exam-prep:test` - passed, 35 tests.
- `pnpm nx run exam-prep:lint` - passed.
- `pnpm nx run exam-prep:build` - passed with existing bundle budget warning: initial `757.02 kB` exceeds `700.00 kB` by `57.02 kB`.
- `pnpm nx run exam-prep-backend:test` - passed, 88 tests, one existing Starlette/httpx warning.
- `pnpm nx run exam-prep-backend:lint` - passed.
- `pnpm nx run exam-prep-desktop:cargo-test` - passed, 12 Rust tests.
- `pnpm nx run exam-prep-desktop:typecheck-scripts` - passed.
- `pnpm nx run exam-prep-desktop:package-qa-test` - passed, 14 script tests.
- `pnpm nx run exam-prep-desktop:package-qa --skip-nx-cache --args='--ocr-page-workers 1'` - passed.
- `pnpm nx run exam-prep-desktop:packaged-flow-smoke --skip-nx-cache --args='--ocr-page-workers 1'` - passed.
- `pnpm nx run exam-prep-backend:reasoning-bakeoff` - completed with partial live evidence only.

Latest packaged smoke:

- Artifact: `tmp/exam-prep-desktop/packaged-flow-smoke/2026-06-19T03-24-37-213Z/metrics.json`.
- Final document DB row: `46 pages / 46 chunks`, `processed_page_count=46`, `status=ready`, `ocr_worker_count=1`.
- Backend timing: `first_chunk_ms=20,713`, `parse_wall_duration_ms=48,656`, `ocr_engine_duration_ms=27,021`, `render_duration_ms=1,202`.
- UI timing: `first_chunk_visible=21,226 ms`, `parse_complete_visible=48,829 ms`.
- Close/process evidence: restart and final close both `gracefulExited=true`, `fallbackUsed=false`, `exitCode=0`, empty `residualProcesses`; `node_cleanup_summary.closed_count=0`.

Package QA:

- Artifact: `tmp/exam-prep-desktop/package-qa/package-qa.json`.
- Generated at: `2026-06-19T03:17:45.099Z`.
- Package artifacts: MSI `3.95 MB`, NSIS `2.76 MB`.
- Backend runtime artifact: `43.12 MB`.
- OCR runtime artifact: `632.66 MB`.
- Runtime launch env keeps `EXAM_PREP_OCR_PAGE_WORKERS=1`.

Reasoning bakeoff:

- Artifact: `apps/exam-prep-backend/.benchmarks/reasoning-bakeoff-20260619T020859Z.json`.
- `qwen3:14b`: `missing_model`.
- `deepseek-r1:14b`: `missing_model`.
- `gemma4:12b`: `scored`, `latency_ms=127,504`, `json_valid=true`, citation validity `2/3`, manual review ratio `1.0`.
- TODO remains open because all three comparator models did not produce scored results.

Open after this run:

- OCR health cold-start UX remains open until a packaged artifact confirms the drawer no longer shows `OCR unknown` while health is in-flight. Frontend state/test coverage now treats any health snapshot refresh as OCR checking/warming.
- First chunk latency remains open. The backend improved from about `76s` to about `20.7s`, but the packaged acceptance gate is still `<15s`.
- Streaming parse-to-qwen was still research/prototype work at this checkpoint.
  It was later closed by the packaged fast-first evidence below. The initial
  no-Kafka decision remains current: use a SQLite queue/outbox and bounded qwen
  worker for the local-first slice.
- Dead-code cleanup is complete for the 2026-06-19 audit slice.

## 2026-06-19 Dead Code Cleanup Evidence

Deleted or simplified:

- Frontend: removed unused `OperationStore.isBusy`, `OperationStore.failWithCode`, and the now-unused Angular `computed` import.
- Backend: deleted unused `mock_exams/downloads.py` and removed unused `ModelDownloadProvider`; live model-download routes remain on the runtime installation manager.
- Desktop scripts: removed unused package-QA sidecar helpers `collectSidecars`, `resolveSingleSidecar`, `targetTripleFromSidecarName`, private `isSidecarName`, `SIDECAR_PREFIX`, and the now-unused `basename` import.

Evidence:

- `rg` checks found no remaining call sites for the removed symbols.
- `pnpm exec tsc -p tsconfig.scripts.json --noUnusedLocals --noUnusedParameters` passed before the desktop cleanup.
- Backend `ruff` lint passed before cleanup and the backend worker also checked the deleted manager/protocol with `uvx vulture`.

Final verification:

- `pnpm nx run exam-prep:lint`
- `pnpm nx run exam-prep:test`
- `pnpm nx run exam-prep:build`
- `pnpm nx run exam-prep-backend:lint`
- `pnpm nx run exam-prep-backend:test`
- `pnpm nx run exam-prep-desktop:lint`
- `pnpm nx run exam-prep-desktop:typecheck-scripts`
- `pnpm nx run exam-prep-desktop:package-qa-test`
- `pnpm nx run exam-prep-desktop:cargo-test`

## 2026-06-19 Streaming Prototype And Dead-Code Follow-Up

Additional cleanup:

- Backend: removed unused `DraftGenerationJobStatus.CANCELLED` because no cancel
  writer or endpoint exists in the prototype.
- Backend: removed unused public wrappers
  `clean_exam_text`, `question_block_source_text`, and
  `looks_like_question_group_instruction`; their private implementations remain
  used internally.
- Backend: removed unused `serialize_ocr_health` and its `asdict` import from
  the external Paddle adapter.
- Desktop and frontend sub-agent audits found no safe delete-only candidates in
  their scopes.

Streaming prototype evidence:

- Added SQLite-backed `draft_generation_jobs`, chunk-scoped enqueueing, bounded
  streaming draft worker, provider-unavailable/missing-model skip states, and
  append-only draft persistence.
- Frontend draft review polls drafts while parsing continues once chunks are
  visible.
- OpenAPI client regenerated for the draft-job list endpoint.
- Runtime launch env for packaged QA now sets
  `EXAM_PREP_STREAMING_DRAFT_GENERATION_ON_UPLOAD=true`.

Verification:

- `pnpm nx run exam-prep-backend:lint --skip-nx-cache` - passed.
- `pnpm nx run exam-prep-backend:test --skip-nx-cache` - passed, 91 tests, one
  existing Starlette/httpx warning.
- `pnpm nx run exam-prep-backend:generate-openapi-client --skip-nx-cache` -
  passed.
- `pnpm nx run exam-prep:lint --skip-nx-cache` - passed.
- `pnpm nx run exam-prep:test --skip-nx-cache` - passed, 36 tests.
- `pnpm nx run exam-prep:build --skip-nx-cache` - passed with the existing
  initial bundle budget warning.
- `pnpm nx run exam-prep-desktop:lint --skip-nx-cache` - passed.
- `pnpm nx run exam-prep-desktop:typecheck-scripts --skip-nx-cache` - passed.
- `pnpm nx run exam-prep-desktop:package-qa-test --skip-nx-cache` - passed, 14
  tests.
- `pnpm nx run exam-prep-desktop:cargo-test --skip-nx-cache` - passed, 12 tests.

Node cleanup note: post-verification node processes were all `nx-mcp` service
processes, so no workspace/test-owned Node helpers were killed.

## 2026-06-19 Streaming Instrumentation Follow-Up

Additional streaming research/prototype work:

- Frontend draft review exposes draft-job summary state during parsing:
  active job counts, ready counts, model-missing/provider-unavailable blockers,
  and failure attention state.
- The draft refresh loop now keeps polling while draft jobs remain active and
  isolates draft-job endpoint failures from draft list refresh.
- Backend legacy upload auto-generation now persists provider suggestions as
  `draft` records rather than `approved`, preserving the review gate even when
  streaming generation is disabled.
- Packaged flow smoke now records streaming draft API snapshots and UI timings
  during parse, including status counts, first job/status/draft/usable timings,
  blocker state, and sanitized snapshot counts.
- Packaged smoke tests assert that streaming snapshots do not persist question
  text, choices, auth headers, or token-like payload content.

Verification:

- `pnpm nx run exam-prep-backend:test --skip-nx-cache` - passed, 91 tests, one
  existing Starlette/httpx warning.
- `pnpm nx run exam-prep-backend:lint --skip-nx-cache` - passed.
- `pnpm nx run exam-prep:test --skip-nx-cache` - passed, 39 tests.
- `pnpm nx run exam-prep:lint --skip-nx-cache` - passed.
- `pnpm nx run exam-prep:build --skip-nx-cache` - passed with the existing
  initial bundle budget warning.
- `pnpm nx run exam-prep-desktop:lint --skip-nx-cache` - passed.
- `pnpm nx run exam-prep-desktop:typecheck-scripts --skip-nx-cache` - passed.
- `pnpm nx run exam-prep-desktop:package-qa-test --skip-nx-cache` - passed, 17
  script tests.
- `pnpm nx run exam-prep-desktop:cargo-test --skip-nx-cache` - passed, 12 tests.
- `git diff --check` - passed with only line-ending normalization warnings.

Open evidence:

- Live packaged streaming timing and qwen draft-quality evidence was still
  missing at this checkpoint. It was later closed by the packaged fast-first
  evidence below.

## 2026-06-19 Streaming Recovery And Retry Follow-Up

Additional streaming reliability work:

- Backend app startup now requeues durable `pending` draft jobs and resets
  interrupted `running` draft jobs to `pending`.
- Added draft-job retry API:
  `POST /projects/{project_id}/documents/{document_id}/draft-jobs/retry`.
- Retry requeues only `failed`, `skipped_provider_unavailable`, and
  `skipped_missing_model` jobs, leaving `succeeded`, `pending`, and `running`
  jobs unchanged.
- Retry updates provider/model metadata to the current runtime, clears
  `last_error`, increments `retry_count`, and keeps generated output as
  draft-only.
- Frontend draft review now renders `Retry drafting` when jobs are blocked, so
  users can make the qwen model available later and continue from already
  parsed chunks.

Verification:

- `pnpm nx run exam-prep-backend:test --skip-nx-cache` - passed, 93 tests, one
  existing Starlette/httpx warning.
- `pnpm nx run exam-prep-backend:lint --skip-nx-cache` - passed.
- `pnpm nx run exam-prep-backend:generate-openapi-client --skip-nx-cache` -
  passed.
- `pnpm nx run exam-prep:test --skip-nx-cache` - passed, 41 tests.
- `pnpm nx run exam-prep:lint --skip-nx-cache` - passed.
- `pnpm nx run exam-prep:build --skip-nx-cache` - passed with the existing
  initial bundle budget warning.

Local live-qwen blocker:

- `ollama list` currently has `gemma4:12b`, `qwen3:8b`, and
  `qwen3-coder:30b`.
- `qwen3:14b` is not installed, so a live packaged qwen timing run still cannot
  satisfy acceptance without a user-provided model install.

## 2026-06-19 Packaged Streaming Fast-First Evidence

Streaming parse-to-qwen prototype status: complete for the research/prototype
TODO.

Artifact:

- `tmp/exam-prep-desktop/packaged-flow-smoke/2026-06-19T08-37-53-476Z/metrics.json`

Packaged smoke command:

- `pnpm nx run exam-prep-desktop:packaged-flow-smoke --skip-nx-cache --args="--ocr-page-workers 1 --ollama-model qwen3:8b --streaming-draft-page-limit 1 --skip-gpu-sampling"`

Evidence:

- Packaged app used `qwen3:8b` through a QA override; no model download was
  triggered.
- First draft job/status appeared at `1,043 ms`.
- First streamed qwen draft appeared at `22,301 ms`.
- First usable question appeared at `22,301 ms`.
- Parse completion appeared at `25,394 ms`, so a usable streamed qwen draft was
  available before the document finished parsing.
- Streaming draft snapshots reached `item_count=1` and `usable_count=1`.
- Final document state still reached `46 pages / 46 chunks`.
- Restart and final close both reported `gracefulExited=true`,
  `fallbackUsed=false`, `exitCode=0`, and empty `residualProcesses`.
- Node cleanup summary reported `closed_count=0` and no this-run helper residue.

Implementation notes:

- The prototype keeps the no-Kafka local architecture: SQLite job queue/outbox,
  bounded qwen workers, editable question persistence, and user-governed edits.
- Qwen prewarm runs only after provider health succeeds and never pulls missing
  models.
- Fast-first generation is limited to deterministic extracted candidates, so
  notice/cover pages do not consume the qwen worker window.

Still open:

- First chunk latency remains open. The latest packaged smoke recorded
  `first_chunk_visible=15,005 ms`, just over the `<15s` target.
- Reasoning bakeoff remains open because all three comparator models have not
  produced scored live results.
- The default model path still needs `qwen3:14b` availability evidence if that
  remains the selected production default.

## 2026-06-21 OCR Health And First-Chunk Gate Evidence

Implementation checkpoint:

- Frontend OCR health now uses explicit phases: `waiting`, `checking`,
  `warming`, `stale`, `ready`, and `failed`.
- Runtime drawer/model-health copy now renders active startup checks as
  checking/warming/stale states instead of `OCR unknown`.
- Source import polling now uses a faster `500 ms` cadence only while parsing is
  active and no source chunk is visible, then returns to the existing `1500 ms`
  cadence.
- Packaged smoke first-chunk timing now starts observation at parse start,
  keeps the 15s screenshot, and records `first_chunk_gate_ms` plus
  `first_chunk_under_gate`.
- Packaged smoke runtime drawer checks are scoped to the runtime dialog so
  background document text cannot satisfy OCR-ready detection.

Verification:

- `pnpm nx run exam-prep:test --skip-nx-cache` - passed, 46 tests.
- `pnpm nx run exam-prep:lint --skip-nx-cache` - passed.
- `pnpm nx run exam-prep-backend:test --skip-nx-cache` - passed, 95 tests, one
  existing Starlette/httpx deprecation warning.
- `pnpm nx run exam-prep-backend:lint --skip-nx-cache` - passed.
- `pnpm nx run exam-prep-desktop:typecheck-scripts --skip-nx-cache` - passed.
- `pnpm nx run exam-prep-desktop:package-qa-test --skip-nx-cache` - passed, 20
  script tests.
- `pnpm nx run exam-prep-desktop:packaged-flow-smoke --skip-nx-cache --args="--ocr-page-workers 1 --skip-gpu-sampling"` - passed.

Latest packaged smoke:

- Artifact:
  `tmp/exam-prep-desktop/packaged-flow-smoke/2026-06-21T05-59-55-867Z/metrics.json`.
- OCR health settled from active checking to `paddle / gpu:0`; the artifact text
  contains no `OCR unknown`, `Unknown`, `status unavailable`, or
  `PaddleOCR status unavailable` observation.
- First visible chunk: `2,612 ms`.
- First-chunk gate: `first_chunk_gate_ms=15000`,
  `first_chunk_under_gate=true`.
- Mid-parse UI evidence: `8/46 pages / 8 chunks / 15s`; source text was visible
  while parsing continued.
- Final OCR completion: `46 pages / 46 chunks`.
- Parse complete visible: `86,214 ms`.
- Restart and final close both reported `gracefulExited=true`, `fallbackUsed=false`,
  `exitCode=0`, and empty residual process lists.
- Streaming draft status remained blocked by missing `qwen3:14b`; no model
  download was triggered.

Reasoning bakeoff:

- Command: `pnpm nx run exam-prep-backend:reasoning-bakeoff --skip-nx-cache`.
- Artifact:
  `apps/exam-prep-backend/.benchmarks/reasoning-bakeoff-20260621T052159Z.json`.
- `qwen3:14b`: `missing_model`.
- `deepseek-r1:14b`: `missing_model`.
- `gemma4:12b`: `request_failed`, `json_error=ReadTimeout`.
- No candidate produced full scored comparator evidence, so the default model
  decision remains unchanged and the live bakeoff TODO stays open.
