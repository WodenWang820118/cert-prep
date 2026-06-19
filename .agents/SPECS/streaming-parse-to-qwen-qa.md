# Streaming Parse To Qwen QA

No implementation evidence yet. This file is reserved for artifact-backed
results once the research plan moves into a prototype or product slice.

Initial research decision on 2026-06-19:

- Do not add Kafka or another external broker for the first local-first version.
- Use a SQLite-backed local job queue/outbox and bounded qwen worker.
- Keep qwen output draft-only and approval-gated.
- Treat Ollama/model unavailability as an environment blocker.

## 2026-06-19 Prototype Evidence

Implemented a first local prototype using the no-Kafka decision:

- Backend migration `12` adds `draft_generation_jobs`.
- Page progress now enqueues one chunk-scoped draft job after a chunk is
  persisted.
- `StreamingDraftGenerationManager` runs a bounded local worker, checks provider
  health first, marks missing model/provider unavailable without blocking parse,
  and persists generated output as draft-only records.
- Draft persistence gained an append-only dedupe path so streaming generation
  does not delete in-review or approved drafts.
- Frontend draft review now polls drafts while a processing document already has
  chunks.
- Packaged runtime env enables streaming draft generation on upload for the
  production smoke path.

Verification:

- `pnpm nx run exam-prep-backend:test --skip-nx-cache` passed, 91 tests.
- `pnpm nx run exam-prep-backend:lint --skip-nx-cache` passed.
- `pnpm nx run exam-prep:test --skip-nx-cache` passed, 36 tests.
- `pnpm nx run exam-prep:lint --skip-nx-cache` passed.
- `pnpm nx run exam-prep:build --skip-nx-cache` passed with the existing initial
  bundle budget warning.
- `pnpm nx run exam-prep-desktop:typecheck-scripts --skip-nx-cache` passed.
- `pnpm nx run exam-prep-desktop:package-qa-test --skip-nx-cache` passed, 14
  tests.
- `pnpm nx run exam-prep-desktop:cargo-test --skip-nx-cache` passed, 12 tests.

At this stage the TODO remained open because this was not yet packaged timing
and draft-quality evidence for live qwen output.

## 2026-06-19 Streaming Status Instrumentation Evidence

Implemented the next prototype slice:

- Frontend draft review now polls and renders draft-job state while parsing is
  still running, with an `aria-live="polite"` summary for active, ready, and
  blocked states.
- Draft polling now tolerates temporary draft-job endpoint failure so streamed
  drafts can still refresh.
- Polling remains active while draft jobs are pending/running, even if the
  source document has already settled.
- The legacy `auto_generate_exam_on_upload` path now normalizes provider output
  into `draft` status before persistence, preserving draft-only safety outside
  the new streaming worker.
- Packaged flow smoke now captures streaming draft API evidence during parsing:
  job snapshots, draft snapshots, status counts, first status/job/draft/usable
  timings, and blocker state.
- Packaged flow smoke snapshot helpers intentionally store only counts, status
  histograms, generated counts, usable counts, and elapsed timings; question
  text, choices, auth headers, and token-like payload fields are not persisted.

Verification:

- `pnpm nx run exam-prep-backend:test --skip-nx-cache` passed, 91 tests.
- `pnpm nx run exam-prep-backend:lint --skip-nx-cache` passed.
- `pnpm nx run exam-prep:test --skip-nx-cache` passed, 39 tests.
- `pnpm nx run exam-prep:lint --skip-nx-cache` passed.
- `pnpm nx run exam-prep:build --skip-nx-cache` passed with the existing
  initial bundle budget warning.
- `pnpm nx run exam-prep-desktop:lint --skip-nx-cache` passed.
- `pnpm nx run exam-prep-desktop:typecheck-scripts --skip-nx-cache` passed.
- `pnpm nx run exam-prep-desktop:package-qa-test --skip-nx-cache` passed, 17
  script tests.
- `pnpm nx run exam-prep-desktop:cargo-test --skip-nx-cache` passed, 12 tests.
- `git diff --check` passed with only line-ending normalization warnings.

This still does not close the TODO. The remaining acceptance evidence is a live
packaged streaming run where qwen output produces usable draft questions before
parse completion, with timing and review-quality results recorded.

## 2026-06-19 Recovery And Retry Evidence

Implemented the next reliability slice for scan-to-usable flow:

- Backend startup now recovers durable streaming draft jobs by resetting
  interrupted `running` jobs to `pending` and scheduling all runnable pending
  jobs.
- Added `POST /projects/{project_id}/documents/{document_id}/draft-jobs/retry`
  to requeue retryable terminal jobs after runtime blockers clear.
- Retry only resets `failed`, `skipped_provider_unavailable`, and
  `skipped_missing_model`; `succeeded`, `pending`, and `running` jobs are left
  alone.
- Retry updates job provider/model to the current runtime, clears `last_error`,
  increments `retry_count`, and preserves draft-only append/dedupe behavior.
- Frontend draft review now shows a `Retry drafting` action when streaming jobs
  are blocked, so users can install or start the qwen runtime later and requeue
  already-scanned chunks without uploading/parsing the PDF again.

Local model availability check:

- `ollama list` showed `gemma4:12b`, `qwen3:8b`, and `qwen3-coder:30b`.
- `qwen3:14b` is still not installed locally, so the default-model packaged path
  and comparator bakeoff remained blocked without a user-provided model install.

Verification:

- `pnpm nx run exam-prep-backend:test --skip-nx-cache` passed, 93 tests.
- `pnpm nx run exam-prep-backend:lint --skip-nx-cache` passed.
- `pnpm nx run exam-prep-backend:generate-openapi-client --skip-nx-cache`
  passed.
- `pnpm nx run exam-prep:test --skip-nx-cache` passed, 41 tests.
- `pnpm nx run exam-prep:lint --skip-nx-cache` passed.
- `pnpm nx run exam-prep:build --skip-nx-cache` passed with the existing
  initial bundle budget warning.

At this stage the TODO remained open until a fresh packaged smoke captured
streaming metrics and live usable qwen draft questions before parse completion.

## 2026-06-19 Packaged Live Qwen Evidence

Implemented and verified the fast-first streaming prototype in a packaged app
run:

- No Kafka or external broker was added. The prototype keeps the local-first
  SQLite draft-job queue/outbox and a bounded qwen worker model.
- Streaming generation now starts from persisted page/chunk progress and skips
  chunks unless deterministic JLPT extraction finds a grounded candidate.
- Qwen is prewarmed only after health succeeds; missing models remain a blocker
  and no model pull is triggered automatically.
- The first streamed job uses a compact JSON completion for answer, rationale,
  and confidence before falling back to the heavier structured reasoning path.
- Packaged smoke can override the model and streaming page limit for QA without
  changing the production REST/OpenAPI contract.
- Packaged smoke uses an isolated app data directory for this flow, syncs the
  packaged backend runtime into that data dir, captures sanitized draft-job and
  draft snapshots, and records close/process cleanup evidence.

Live packaged run:

- Command:
  `pnpm nx run exam-prep-desktop:packaged-flow-smoke --skip-nx-cache --args="--ocr-page-workers 1 --ollama-model qwen3:8b --streaming-draft-page-limit 1 --skip-gpu-sampling"`.
- Artifact:
  `tmp/exam-prep-desktop/packaged-flow-smoke/2026-06-19T08-37-53-476Z/metrics.json`.
- Model: `qwen3:8b` via QA override; default packaged model remains
  `qwen3:14b`.
- First job/status visible: `1,043 ms`.
- First streamed qwen draft visible: `22,301 ms`.
- First usable question visible: `22,301 ms`.
- Parse complete visible: `25,394 ms`.
- Draft snapshots recorded `item_count=1` and `usable_count=1` before parse
  completion.
- Streaming status counts across polling snapshots:
  `running=70`, `pending=655`, `succeeded=34`.
- Close/process evidence: restart and final close both reported
  `gracefulExited=true`, `fallbackUsed=false`, `exitCode=0`, and empty
  `residualProcesses`; Node cleanup summary reported `closed_count=0`.

Direct qwen source check:

- `OllamaProvider.generate_fast_first_draft()` against the page 2 JLPT chunk
  returned an AI-inferred draft in `18.056 s`.
- The returned answer mapped numeric compact JSON output to the visible choice
  `1 ようか`, with a user-facing rationale, confidence `0.8`, and citation page
  `2`.

Verification:

- Focused streaming/LLM pytest subset passed, 10 tests.
- `pnpm nx run exam-prep-backend:test --skip-nx-cache` passed, 99 tests, one
  existing Starlette/httpx warning.
- `pnpm nx run exam-prep-backend:lint --skip-nx-cache` passed.
- `pnpm nx run exam-prep-desktop:typecheck-scripts --skip-nx-cache` passed.
- `pnpm nx run exam-prep-desktop:package-qa-test --skip-nx-cache` passed, 17
  script tests.
- `pnpm nx run exam-prep-desktop:cargo-test --skip-nx-cache` passed, 13 Rust
  tests.
- `pnpm nx run exam-prep-desktop:package-qa --skip-nx-cache --args="--ocr-page-workers 1"`
  passed before the packaged smoke run.

This closes the streaming parse-to-qwen research/prototype TODO. Remaining
product gates are tracked separately: `qwen3:14b` must still be available for
the default packaged model path if required, the three-model reasoning bakeoff
is still open, and first-chunk latency is still just outside the target gate.
