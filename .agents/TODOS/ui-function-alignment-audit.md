# UI / Function Alignment TODO

Date: 2026-07-03

Status: Active follow-up backlog.

## Purpose

Track the remaining UI/function alignment decisions after the 2026-07-02 audit
and correction pass.

The completed audit outcome has been folded into
`.agents/SPECS/workbench-screen-alignment.md`. Completed items should not be
re-expanded here unless a regression reopens them.

## Active Follow-Up Slices

### 1. Runtime Surface Policy

Goal: make runtime management behavior explicit enough that future UI work does
not accidentally split route and modal behavior.

Decisions:

- Should `/runtime` remain a route-mode compatibility surface, or fully match
  modal controls including close/cancel affordances?
- Should standalone `ModelHealthComponent` Manage open the shell modal, or keep
  route navigation as compatibility behavior?

Likely touchpoints:

- `apps/cert-prep/src/app/pages/runtime-manager/*`
- `apps/cert-prep/src/app/components/model-health/*`
- `apps/cert-prep/src/app/app.*`

Suggested verification:

- `pnpm nx run cert-prep:test --skip-nx-cache`
- `pnpm nx run cert-prep-e2e:e2e --skip-nx-cache`

### 2. Practice And Review Coverage

Goal: add coverage for already-wired behavior that is broader than the current
assertions.

Coverage targets:

- active practice answer selection, clear action, submit disabled states, and
  navigator state;
- populated wrong-answer cards including recorded count, page chip, selected
  answer, correct answer, rationale, source excerpt, refresh disabled state,
  and footer guidance;
- Full Exam document selector and metrics if the practice runner changes again.

Likely touchpoints:

- `apps/cert-prep/src/app/components/practice-panel/*`
- `apps/cert-prep/src/app/components/wrong-answer-review/*`
- `apps/cert-prep-e2e/src/support/*`

Suggested verification:

- `pnpm nx run cert-prep:test --skip-nx-cache`
- `pnpm nx run cert-prep-e2e:e2e --skip-nx-cache`
- `pnpm nx run cert-prep:lint --skip-nx-cache`

### 3. Placeholder Policy

Goal: decide whether disabled markers stay as design parity placeholders or
become real product surfaces.

Current placeholders:

- Settings
- Account
- footer links
- Mark for review

Recommended default: keep Settings, Account, and footer links as placeholders
for now. Treat Mark for review as a product decision tied to the review-roadmap
work in `.agents/TODOS/feature-roadmap.md`.

Suggested verification:

- component tests for whichever placeholder policy is chosen;
- backend/API tests only if Mark for review becomes persisted state.

## Doc-Only Check

- `git diff --check -- .agents/SPECS .agents/TODOS`
