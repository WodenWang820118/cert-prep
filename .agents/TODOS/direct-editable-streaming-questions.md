# Direct Editable Streaming Questions TODO

- [x] Backend generated/manual questions are playable immediately.
  Verify: `pnpm nx run exam-prep-backend:test --skip-nx-cache`

- [x] Approval endpoint/client/store/button code is removed without
  compatibility shims.
  Verify: `rg -n "approveQuestionDraft|approve_question_draft|approve_draft|Save & approve|Ready to approve|Draft approved" apps/exam-prep-backend apps/exam-prep/src/app apps/exam-prep-e2e/src`

- [x] Angular review/editor flow treats records as editable questions instead of
  approval-gated drafts.
  Verify: `pnpm nx run exam-prep:test --skip-nx-cache`

- [x] Packaged smoke/baseline records generated editable question timing and
  skips deterministic approval flow in streaming baseline mode.
  Verify: `pnpm nx run exam-prep-desktop:package-qa-test --skip-nx-cache`

- [x] Baseline artifact is refreshed after the behavior change.
  Verify: `pnpm nx run exam-prep-desktop:packaged-streaming-baseline --skip-nx-cache`

- [x] Dead approval-only code and stale active copy references are removed or
  retargeted to the new behavior; older research notes are superseded in place.
  Verify: `rg -n "manual approval|approval-gated|draft-only|Save & approve|Ready to approve|Draft approved" apps/exam-prep-backend apps/exam-prep/src/app apps/exam-prep-e2e/src apps/exam-prep-desktop/scripts`

- [x] Final hygiene and process cleanup pass.
  Verify: `git diff --check` and compare/close only new workspace/test-owned
  `node.exe` processes.
