# Streaming Parse To Qwen Research Plan

## Goal

Research a local-first pipeline where each parsed page/chunk can immediately
start draft-question generation through the qwen reasoning profile while the
remaining PDF pages are still parsing.

The feature is exploratory. It must not auto-install models, auto-download
models, auto-approve drafts, expose chain-of-thought, or block deterministic
parsing.

## Current Recommendation

Do not introduce Kafka or a Kafka-like broker for the first implementation.

This app is currently a single-user, local desktop workflow. A durable SQLite job
queue/outbox plus a bounded backend worker is enough for:

- page-ready events produced by the parsing pipeline;
- retryable qwen draft jobs;
- crash recovery after app restart;
- UI polling or future SSE progress;
- clear ownership of local runtime/process cleanup.

Kafka, NATS, Redis Streams, or another external broker should be reconsidered
only if the product needs multi-machine workers, cross-service fan-out,
high-throughput retention/replay, independent deployment of parsing and drafting
services, or centralized observability across many users.

## Proposed Pipeline

1. PDF/OCR parsing keeps the existing page progress path.
2. When a page chunk is persisted, the backend also writes a local
   `ParseChunkReady` job into SQLite in the same transaction or through an
   outbox.
3. A bounded qwen draft worker consumes pending jobs with one active qwen request
   by default.
4. The worker calls the existing Ollama/qwen provider with one chunk plus a small
   adjacent-page lookback window when needed.
5. Generated items are persisted as draft-only review candidates.
6. A final reconciliation pass deduplicates, handles grouped questions that need
   later pages, and marks skipped jobs with explicit provider/runtime reasons.

## Draft Job State

Recommended states:

- `pending`
- `running`
- `succeeded`
- `skipped_provider_unavailable`
- `skipped_missing_model`
- `failed`

Each job should include `project_id`, `document_id`, `chunk_id`, `page_number`,
`parse_run_id`, `content_profile`, retry count, last error, timestamps, and model
profile.

Prototype note: the first implementation omits `cancelled` until there is a
real pause/cancel API. Keeping unused states out of the enum makes the worker
state surface easier to audit.

## UI/API Shape

Start with polling. SSE can be added later if polling creates visible latency or
excess backend churn.

Candidate read endpoints:

- `GET /projects/{project_id}/documents/{document_id}/draft-jobs`
- `POST /projects/{project_id}/documents/{document_id}/draft-jobs/{job_id}/retry`

Frontend behavior:

- Show parsing and drafting as separate progress lanes.
- Refresh draft review state while parsing/drafting is active.
- Preserve user approval authority; qwen output remains editable draft material.
- Surface `ollama_unavailable`, `missing_model`, and `request_failed` as blockers
  without model download side effects.

## Open Risks

- Grouped JLPT questions may require multiple adjacent chunks, so early jobs may
  need reconciliation rather than immediate finalization.
- The current deterministic draft path deletes non-approved drafts before
  creating new drafts; streaming qwen drafts need a non-destructive persistence
  path.
- Existing `GENERATED_DRAFT_STATUS = approved` style defaults must not leak into
  qwen-generated streaming output.
- Out-of-order OCR completion must not create duplicate or stale draft jobs across
  retries/restarts.
- qwen latency may compete with OCR CPU/GPU resources; the worker should default
  to low concurrency and be independently pausable.

## Validation Plan

- Unit-test idempotent `ParseChunkReady` enqueue behavior.
- Unit-test job state transitions, retry limits, cancellation, and restart
  resume.
- Integration-test parsing continues when Ollama/qwen is unavailable.
- Integration-test qwen draft jobs persist draft-only records with citations.
- UX-test that partial drafts appear while remaining pages parse.
- Packaged smoke-test that closing the app terminates parser, qwen worker,
  backend, OCR workers, and this-run Node/Playwright helpers.
