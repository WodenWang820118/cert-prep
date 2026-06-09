# Exam Prep UI System TODO

- [x] Add PrimeNG, PrimeIcons, Tailwind CSS 4, PostCSS, and PrimeUI Tailwind integration.
  Verify: `pnpm install --frozen-lockfile`

- [x] Configure PrimeNG provider and Tailwind 4 imports.
  Verify: `pnpm nx run exam-prep:build`

- [x] Rebuild standalone workflow components with PrimeNG controls and Tailwind layout classes.
  Verify: `pnpm nx run exam-prep:test`

- [x] Verify the full browser loop.
  Verify: `pnpm nx run exam-prep-e2e:e2e`

- [x] Run final quality gates and commit.
  Verify: `pnpm nx run exam-prep:lint && pnpm nx run exam-prep:build`
