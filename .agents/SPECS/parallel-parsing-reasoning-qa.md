# Parallel Parsing 與 Reasoning QA 摘要

## 現況

Production packaged flow 已驗證 deterministic/manual acceptance path，但保留 performance/UX follow-ups。測試使用 release executable：

`apps/exam-prep-desktop/src-tauri/target/x86_64-pc-windows-msvc/release/exam-prep-desktop.exe`

PDF：`pdfs/【1】2025年07月N1 真题.pdf`。

## Automated Verification

| Command | Result | Notes |
| --- | --- | --- |
| `pnpm nx run exam-prep-backend:test` | Passed | 75 passed，1 Starlette/httpx warning。 |
| `pnpm nx run exam-prep-backend:lint` | Passed | Ruff all checks passed。 |
| `pnpm nx run exam-prep:test --skip-nx-cache` | Passed | 24 passed。 |
| `pnpm nx run exam-prep-e2e:e2e` | Passed | 3 Playwright tests。 |
| `pnpm nx run exam-prep-desktop:typecheck-scripts` | Passed | `tsc -p tsconfig.scripts.json`。 |
| `pnpm nx run exam-prep-desktop:package-qa-test` | Passed | 6 node tests。 |
| `pnpm nx run exam-prep-desktop:cargo-test` | Passed | 11 Rust tests。 |
| `pnpm nx run exam-prep-desktop:package-qa --skip-nx-cache` | Passed | Rebuilt runtimes and bundles。 |

Package QA JSON：`tmp/exam-prep-desktop/package-qa/package-qa.json`，generated `2026-06-18T04:06:03.165Z`。

## OCR Performance

| Run | Workers | Wall | First chunk | Render | OCR engine | GPU | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| Packaged production | 2 | 58,068 ms | 57,587 ms | 2,459 ms | 38,788 ms | max 100%, avg 21.8%, memory peak 53.1% | ready, 46 pages, 46 chunks |
| Same-build baseline | 1 | 未跑 | 未跑 | 未跑 | 未跑 | 未跑 | 必須補跑 |

決策：預設 worker count 維持 `1`，因為尚無 same-build `1` vs `2` 對照，且 first chunk visibility 沒有達到 use-while-parsing 期待。

## Production Flow Evidence

Artifact folder：`.agents/tmp/parallel-parsing-reasoning/2026-06-18T04-06-30-521Z/`

- Runtime missing → Python install consent → runtime ready。
- PDF selected with `language_hint=ja`。
- Parsing started and workspace remained usable。
- Parsing complete with 46 chunks and metrics。
- Manual draft edit and approval。
- Full Exam mode available。
- Wrong answer recorded and Review populated。
- Random Quiz correct answer clears Review。
- Restart persistence verified after manual project selection。

## SQLite Evidence

- Document：status `ready`、46 pages、46 processed pages、46 chunks、`paddle_ocr_gpu`、`gpu:0`、worker count `2`、language hint `ja`。
- Approved draft：status `approved`、answer source `manual`、citation page `2`、item kind `vocabulary_single`。
- Sessions：`full_document` 與 `random_draw`。
- Wrong answers：由 attempts projection 產生；wrong attempt 後出現，後續 correct attempt 清空。

## Reasoning Bakeoff

| Model | Status |
| --- | --- |
| deterministic_only | Production flow verified。 |
| `qwen3:14b` | 尚未跑；需 explicit model download consent。 |
| `deepseek-r1:14b` | 尚未跑。 |
| `gemma4:12b` | 尚未跑；compat fallback。 |

## 未解風險

- First chunk 幾乎等於 full parse completion，需 ordered as-completed flush。
- Runtime install 後狀態 refresh 有 stale message。
- Complete progress bar 視覺偏低。
- Restart 後未 auto-select project。
- Packaged app shutdown 曾留下 backend/OCR child processes。
- 1-worker baseline 與 model bakeoff 是 active TODO。
