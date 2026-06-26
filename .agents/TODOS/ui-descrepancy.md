# Packaged UI/Backend/Design Gap Audit - 2026-06-26

This audit records the current packaged-product findings from the new UI and
backend refactor. It is a TODO input for future sync work and does not, by
itself, promote or reject any runtime node.

## Evidence From This Test Round

- Passed broad lint gates for `cert-prep-ocr-windowsml`,
  `cert-prep-contracts`, `cert-prep-ollama`, `cert-prep-backend`,
  `cert-prep-api`, and `cert-prep`.
- Passed broad test gates for `cert-prep-ocr-windowsml`,
  `cert-prep-contracts`, `cert-prep-ollama`, `cert-prep-backend`,
  `cert-prep-api`, and `cert-prep`.
- Passed backend streaming CLI gate:
  `pnpm nx run cert-prep-backend:streaming-cli-test`.
- Passed desktop gates: `cert-prep-desktop:lint`,
  `cert-prep-desktop:cargo-test`, `cert-prep-desktop:typecheck-scripts`,
  and `cert-prep-desktop:package-qa-test`.
- Passed mocked app e2e gate: `pnpm nx run cert-prep-e2e:e2e`.
- Passed package QA:
  `pnpm nx run cert-prep-desktop:package-qa`. The report recorded MSI,
  NSIS, backend runtime, and WindowsML OCR runtime artifacts, plus expected
  unavailable runtime states in the QA data directory.
- Passed packaged flow smoke after aligning the smoke harness with the new UI:
  `pnpm nx run cert-prep-desktop:packaged-flow-smoke`.
- Failed packaged production streaming:
  `pnpm nx run cert-prep-desktop:packaged-streaming-production-windowsml`.
  OCR completed 46/46 pages and produced 46 chunks, one streaming job
  succeeded, and one usable question was generated, but Full Exam still showed
  zero questions for the selected document.
- Known warnings from this round: Angular initial bundle exceeded the 700 kB
  budget by about 25.60 kB, Cargo reported a desktop PDB filename collision,
  PyInstaller emitted hidden-import warnings, and ONNXRuntime logged a provider
  bridge warning even though the WindowsML OCR smoke returned ready.

## New Feature Gaps

- Streaming can generate a usable question while the packaged Full Exam view
  still reports `0 questions in selected document`. Reconcile streaming draft
  persistence, project/document selection, and the practice query path.
- The production WindowsML/FastFlowLM smoke did not prove the configured
  `qwen3.5:4b` FastFlowLM node. The report showed the FastFlowLM server
  unavailable and model-selection checks false, even though the streaming job
  reached a terminal success state.
- Production summaries can leave `selected_model` and `effective_model` empty
  while still reporting generated questions. Carry provider/model attribution
  through streaming artifacts and UI readiness checks.

## UI/Backend Sync Gaps

- Runtime UX is now available through the topbar modal and the `/runtime`
  route fallback, both using `aria-label="Runtime details"`. Keep QA and e2e
  locators tied to stable roles, labels, or test IDs.
- Main navigation items are router links, not buttons. Shared UI test helpers
  must support both links and buttons where the product presents them as
  command surfaces.
- PrimeNG button interactions in packaged WebView required DOM click handling
  for draft Edit/Save in this round. Add stable role names or test IDs for
  critical controls so smoke tests do not depend on framework internals.
- The packaged flow smoke records `MOCK ITEMS 0` after manual question
  creation. Decide whether that metric is parsed/generated-only or should
  include manually authored draft questions.
- Header/runtime status can look successful after PDF upload while Full Exam is
  still not practice-ready. Surface the blocking reason when streamed questions
  exist but are not selectable by practice modes.

## Design Alignment Closed In This Slice

- The app shell now uses the Stitch workbench typography, Info Blue primary
  action color, neutral surfaces, 1px outlined zones, compact topbar, and
  disabled settings/account/footer placeholders.
- Runtime management now opens from `Manage runtime` as a modal-oriented
  surface, with the `/runtime` route retained as a matching fallback.
- Build, Full Exam, Random Quiz, and Wrong Answers now share the workbench page
  language instead of separate card/pill-heavy visual systems.
- Review now includes the recorded count, refresh action, page chips,
  comparison panels, rationale/source metadata, and footer guidance from the
  Stitch reference.

## Remaining Product Gaps To Reconcile

- Confirm whether disabled settings/account/footer placeholders should become
  real app surfaces or remain non-interactive design parity markers.
- Reconcile packaged production streaming persistence so generated questions
  are selectable by Full Exam and Random Quiz after a WindowsML/FastFlowLM run.
- Carry provider and model attribution into production summary artifacts and
  UI readiness checks.
