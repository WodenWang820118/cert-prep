# Frontend Refactor (apps/cert-prep) TODO

## Lint & Type Errors (high priority)

- [x] Fix `async ngOnInit()` returning `Promise<void>` -> change to `void` and use `.catch()` / fire-and-forget pattern.
  Affected: `apps/cert-prep/src/app/app.ts:79`
  Verify: `pnpm nx run cert-prep:lint`

- [x] Replace `window` with `globalThis` / `globalThis.window` in:
  - `apps/cert-prep/src/app/app.ts` (lines ~146, 151)
  - `apps/cert-prep/src/app/cert-prep-api.ts` (lines ~70, 93, 98)
  Verify: `pnpm nx run cert-prep:lint`

- [x] Fix unescaped `\` in `eslint.config.mts:21` -> use `String.raw` for the regex pattern.
  Verify: `pnpm nx run cert-prep:lint`

## Component Directory Consistency

- [ ] Move flat components into dedicated directories, each with `.ts` + `.html` + `.css` + `.spec.ts`:
  - `draft-review-panel.component.ts` -> `draft-review-panel/`
  - `practice-panel.component.ts` -> `practice-panel/`
  - `project-rail.component.ts` -> `project-rail/`
  - `wrong-answer-review.component.ts` -> `wrong-answer-review/`
  Verify: `pnpm nx run cert-prep:build && pnpm nx run cert-prep:test`

## Inline Templates

- [ ] Extract inline `template:` strings from `practice-panel.component.ts` and `project-rail.component.ts` into separate `.html` files.
  Verify: `pnpm nx run cert-prep:build && pnpm nx run cert-prep:test`

## Missing Spec Coverage

- [x] Add `operation.store.spec.ts` for `apps/cert-prep/src/app/stores/operation.store.ts`.
  Verify: `pnpm nx run cert-prep:test`

- [x] Add `project.store.spec.ts` for `apps/cert-prep/src/app/stores/project.store.ts`.
  Verify: `pnpm nx run cert-prep:test`

- [x] Add `wrong-answer-review.store.spec.ts` for `apps/cert-prep/src/app/stores/wrong-answer-review.store.ts`.
  Verify: `pnpm nx run cert-prep:test`

## Empty Routes

- [x] Investigate and document why `app.routes.ts` is an empty array. If intentional, add a comment explaining the routing strategy. If not, populate with actual routes.
  Verify: `pnpm nx run cert-prep:build`

## Final Check

- [ ] Full build + lint + test gate:
  Verify: `pnpm nx run cert-prep:lint && pnpm nx run cert-prep:test && pnpm nx run cert-prep:build`
