# Async Parsing UX Flow TODO

- [x] Add async document parsing repository/API support.
  Verify: `pnpm nx run exam-prep-backend:test`

- [x] Add frontend polling, language hint, scoped busy, and chunk preview UX.
  Verify: `pnpm nx run exam-prep:test`

- [x] Add inline draft editing, save, save-and-approve, and blocker messages.
  Verify: `pnpm nx run exam-prep:test`

- [x] Run desktop and package script checks.
  Verify: `pnpm nx run exam-prep-desktop:cargo-test` and `pnpm nx run exam-prep-desktop:package-qa-test`

- [x] Build packaged Tauri app and run clean production PDF journey.
  Verify: screenshots and `.agents/SPECS/ux-performance-production-flow-qa.md`
