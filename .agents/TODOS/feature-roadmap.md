# Feature Roadmap TODO

Date: 2026-07-03

Status: Active for remaining product decisions only.

## Purpose

Track the next user-facing product slices after the 2026-07-02 feature roadmap
implementation. Completed practice, wrong-answer AI/fallback, multi-PDF, project
isolation, and session-snapshot evidence has been folded into:

- `.agents/SPECS/domains/product-ux.md`
- `.agents/SPECS/domains/backend-architecture.md`

## Active Product TODOs

### 1. Review Retry Loop

Goal: let users immediately practice missed material from Wrong Answers.

Decide and implement one or both flows:

- Retry one wrong question from its review card.
- Start a Review Quiz from all current wrong answers.

Acceptance criteria:

- Correct retry attempts clear the wrong-answer item under the existing
  clearing policy.
- Retry sessions use session-time question snapshots.
- Manual review, refresh, and AI explanation remain usable when local AI is
  unavailable.

Suggested verification:

- `pnpm nx run cert-prep-backend:test --skip-nx-cache`
- `pnpm nx run cert-prep:test --skip-nx-cache`
- `pnpm nx run cert-prep-e2e:e2e --skip-nx-cache`

### 2. Weak-Area Summary Metrics

Goal: help users identify repeated misses without creating a heavy analytics
surface.

Candidate metrics:

- repeated misses by question/source;
- last wrong date;
- source page clusters;
- cleared count.

Acceptance criteria:

- Metrics are project-scoped.
- Metrics distinguish current wrong answers from cleared history.
- Empty states remain compact and useful.

Suggested verification:

- backend regression tests for aggregation scope;
- component or e2e assertions for populated and empty review states.

### 3. Mark For Review Policy

Goal: decide whether the disabled practice action becomes real or is removed.

Decision options:

- Keep it as a disabled parity marker for now.
- Promote it to a saved user flag.
- Remove it from the practice runner until the feature is real.

If promoted, separate user-flagged items from incorrect-attempt items in Review.

Suggested verification:

- component tests for enabled/disabled policy;
- backend/API tests only if saved flags are introduced.

### 4. Wrong-Answer Document Metadata

Goal: decide whether wrong-answer responses should include document identity for
per-PDF grouping and filtering.

Decision points:

- include `document_id` only;
- include `document_id` plus filename;
- keep metadata client-derived from the session/draft snapshot.

Generated OpenAPI client updates are required for any backend route or schema
change.

Suggested verification:

- `pnpm nx run cert-prep-backend:test --skip-nx-cache`
- `pnpm nx run cert-prep-api:typecheck`
- `pnpm nx run cert-prep:test --skip-nx-cache`

## Doc-Only Check

- `git diff --check -- .agents/SPECS .agents/TODOS`
