# Exam Prep UI System Spec

## Purpose

Rebuild the exam-prep Angular UI on PrimeNG and Tailwind CSS 4 so future features can reuse consistent controls, tokens, layout utilities, and accessible component behavior.

## Non-Goals

- Do not change backend API contracts, persistence, extraction, practice, or review behavior.
- Do not add routing or new product flows in this slice.
- Do not collapse existing standalone Angular components into a single large component.

## Key Decisions

- Use PrimeNG v21 with `@primeuix/themes` and the Aura preset.
- Use Tailwind CSS v4 through PostCSS and `tailwindcss-primeui` CSS integration.
- Keep Angular components standalone and focused by workflow panel.
- Use PrimeNG for form controls, buttons, cards, tags, messages, and selection controls.
- Use Tailwind utilities for layout, spacing, responsive behavior, and project-specific composition.

## Acceptance Criteria

- The existing full loop remains available: create project, import PDF, generate drafts, approve, practice, and review wrong answers.
- `pnpm nx show projects --json` still reports only the exam-prep projects.
- Angular lint, tests, build, and Playwright e2e pass.
- The UI has a maintainable design-system baseline with no old hand-rolled button/input styling as the primary control surface.

## Test Plan

- Angular component/store tests for existing behavior.
- Playwright full-loop e2e with mocked backend.
- Production build to catch PrimeNG/Tailwind integration and bundle issues.
