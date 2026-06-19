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

The TODO remains open because this is not yet packaged timing and draft-quality
evidence for live qwen output.

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
