# Parsing And Reasoning Domain

## Purpose

This domain owns OCR parsing performance, use-while-parsing UX, editable
question creation, streaming qwen research, live reasoning-model bakeoff, and
artifact-backed QA evidence for those flows.

## Current Decisions

- `EXAM_PREP_OCR_PAGE_WORKERS` defaults to `1`.
- Worker count `2` is only a measured option if the same-build packaged QA run
  improves wall time by at least 20%, keeps counts stable, improves first chunk,
  and stays under GPU memory gates.
- Deterministic/manual parsing remains the production acceptance path.
- Reasoning model output is optional enrichment and must not auto-download
  models, auto-approve questions, or expose hidden chain-of-thought.
- UI copy should say `Reasoning model` rather than hardcoding a single model
  identity.
- Live bakeoff candidates are `qwen3:14b`, `deepseek-r1:14b`, and
  `gemma4:12b`.
- No Kafka or external broker is used for the first local-first streaming
  implementation. The current design uses a SQLite-backed job queue/outbox and
  bounded local workers.

## Direct Editable Questions

The approval-gated draft flow is retired. Generated/manual records are playable
editable questions immediately while preserving compatibility through the same
storage path where practical.

Closed scope:

- Backend generated/manual questions are playable immediately.
- Approval endpoint/client/store/button code was removed without compatibility
  shims.
- Angular review/editor flows treat records as editable questions.
- Packaged smoke/baseline records editable-question timing and skips old
  deterministic approval flow in streaming baseline mode.
- Approval-only code and stale active copy references were removed or retargeted.

## Streaming Qwen Prototype

The streaming parse-to-qwen research/prototype is complete for the local-first
slice.

Evidence:

- Packaged live qwen artifact:
  `tmp/exam-prep-desktop/packaged-flow-smoke/2026-06-19T08-37-53-476Z/metrics.json`.
- QA override model: `qwen3:8b`; default packaged model remained `qwen3:14b`.
- First streamed qwen draft visible: `22,301 ms`.
- First usable question visible: `22,301 ms`.
- Parse complete visible: `25,394 ms`.
- Close/process cleanup reported graceful close and empty residual processes.
- Dedicated packaged streaming baseline:
  `tmp/exam-prep-desktop/packaged-streaming-baseline/2026-06-19T13-33-48-372Z/streaming-baseline.json`.

## OCR Health And First-Chunk Evidence

Latest packaged smoke:

- Command:
  `pnpm nx run exam-prep-desktop:packaged-flow-smoke --skip-nx-cache --args="--ocr-page-workers 1 --skip-gpu-sampling"`.
- Artifact:
  `tmp/exam-prep-desktop/packaged-flow-smoke/2026-06-21T05-59-55-867Z/metrics.json`.
- OCR settled from active checking to `paddle / gpu:0`.
- Artifact text contained no `OCR unknown`, `Unknown`, `status unavailable`, or
  `PaddleOCR status unavailable` observation.
- First visible chunk: `2,612 ms`.
- First-chunk gate: `first_chunk_gate_ms=15000`,
  `first_chunk_under_gate=true`.
- Mid-parse UI showed source text while parsing continued:
  `8/46 pages / 8 chunks / 15s`.
- Final OCR completion: `46 pages / 46 chunks`.
- Parse complete visible: `86,214 ms`.
- Restart and final close reported `gracefulExited=true`,
  `fallbackUsed=false`, `exitCode=0`, and empty residual process lists.

Verification for the 2026-06-21 slice:

- `pnpm nx run exam-prep:test --skip-nx-cache` passed.
- `pnpm nx run exam-prep:lint --skip-nx-cache` passed.
- `pnpm nx run exam-prep-backend:test --skip-nx-cache` passed.
- `pnpm nx run exam-prep-backend:lint --skip-nx-cache` passed.
- `pnpm nx run exam-prep-desktop:typecheck-scripts --skip-nx-cache` passed.
- `pnpm nx run exam-prep-desktop:package-qa-test --skip-nx-cache` passed.
- Packaged flow smoke passed with worker count `1` and GPU sampling skipped.
- `git diff --check` passed with only line-ending normalization warnings.

## Reasoning Bakeoff

Latest live bakeoff artifact:

- `apps/exam-prep-backend/.benchmarks/reasoning-bakeoff-20260621T052159Z.json`.
- `qwen3:14b`: `missing_model`.
- `deepseek-r1:14b`: `missing_model`.
- `gemma4:12b`: `request_failed`, `json_error=ReadTimeout`.

No candidate produced full scored comparator evidence in the latest run. The
default model decision remains unchanged.

## Active Backlog

Active TODO:

- `.agents/TODOS/parallel-parsing-reasoning.md`

Current open gate:

- Produce scored live bakeoff evidence for all comparator models, or refresh the
  concrete model-availability/timeout blocker without pulling models
  automatically.

## Retired Risk Notes

- Regenerate the OpenAPI client whenever backend schemas/routes change.
- Do not let optional Ollama/model failures block OCR/manual workflows.
- Keep qwen output editable and user-governed.
- Track page-level OCR/render failures explicitly.
- Ground citations and source excerpts in chunk text.
- Keep project selection and restart persistence in packaged smoke.
