# Workbench Screen Alignment Spec

Date: 2026-06-26

## Scope

Align the Cert Prep app screens to the four Stitch workbench references as
separate pages of one product, not competing design versions.

## Design Mapping

- `design/stitch_cert_prep_workbench`: Build workbench at `/build`.
- `design/stitch_cert_prep_workbench2`: Full Exam at `/full-exam`.
- `design/stitch_cert_prep_workbench3`: Manage Runtime modal opened from the
  app topbar.
- `design/stitch_cert_prep_workbench4`: Wrong Answers review at `/review`.

Random Quiz has no dedicated Stitch frame. It should reuse the Full Exam
runner language and density while keeping its random-draw controls.

## Shared Design Contract

- Use the Precision Workbench system from the Stitch `DESIGN.md` files:
  Inter typography, JetBrains Mono for technical data, neutral surfaces, Info
  Blue primary actions, flat 1px outlines, 8px radius, and 4px spacing rhythm.
- Keep the application as a workbench, not a marketing page: compact controls,
  dense but readable cards, no gradients, no decorative shadows, and no nested
  decorative card shells.
- Treat runtime status as compact chips in the Build header plus a topbar
  `Manage runtime` action.
- Do not show global success/status strips for normal navigation. Reserve
  global strips for blocking errors or active work.
- Preserve existing product behavior and stores. This is a UI alignment pass,
  not a data-model rewrite.

## Page Requirements

### Build

- Header reads as `Cert Prep` under the local workspace/workbench context.
- Runtime status chips live in the page header.
- Include the informational workspace banner.
- Keep the two-column Source PDF and Mock Exam Items workbench, collapsing
  cleanly on smaller widths.

### Full Exam

- Header reads `Full Exam`.
- Show a source-document selector and a primary `Start full exam` action.
- Show compact metrics for document count, selected-document question count,
  and session progress.
- Present active questions in a workbench card with stable choice rows and a
  primary `Submit answer` action.
- Add a right-side Session Details / Question Navigator rail when a session is
  active or enough state exists to make the rail useful.

### Random Quiz

- Reuse the Full Exam runner structure.
- Keep random-draw question count controls.
- Keep the same answer row, runner, feedback, and empty-state treatment as
  Full Exam.

### Manage Runtime

- Topbar `Manage runtime` opens a modal overlay matching
  `stitch_cert_prep_workbench3`.
- The modal contains Python Backend, LLM Runtime, Reasoning Model, and OCR
  rows, plus `Refresh all`, `Cancel`, and close controls.
- Existing install, download, and refresh actions remain available.
- The `/runtime` route may remain for compatibility, but it should present the
  same modal surface rather than a separate full-page visual system.

### Review

- Review remains aligned to `stitch_cert_prep_workbench4`: recorded count,
  refresh action, question cards, page chips, side-by-side answer panels,
  rationale/source metadata, and compact footer guidance.

## Verification

- Run `pnpm nx run cert-prep:lint --skip-nx-cache`.
- Run `pnpm nx run cert-prep:test --skip-nx-cache`.
- Run `pnpm nx run cert-prep-e2e:e2e --skip-nx-cache`.
- Capture or inspect Playwright screenshots for Build, Full Exam, Runtime
  modal, and Review before closeout.
