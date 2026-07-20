# Product And UX Domain

## Purpose

Cert Prep is a local-first Windows/Tauri certification-prep app. The core user
journey is: create/select a project, upload a source document, parse it with OCR
when needed, review editable questions, practice through Full Exam or Random
Quiz, and clear wrong-answer review state through correct attempts.

The production acceptance path is deterministic/manual first. AI reasoning is
optional enrichment and must not block OCR, manual question creation, practice,
or review flows.

## Decisions

- Use a new Cert Prep app family beside the existing starter/sample apps.
- Projects own source documents, parsed chunks, editable question records,
  practice sessions, and wrong-answer review state.
- The Angular UI keeps workflow panels for projects, source import, question
  review/editing, practice, and wrong-answer review.
- Use PrimeNG 21 with Angular 21.
- Use Tailwind CSS 4 through `@tailwindcss/postcss`.
- Integrate PrimeNG and Tailwind through `tailwindcss-primeui` CSS imports,
  keeping PrimeNG's CSS layer before Tailwind utilities.
- Keep standalone Angular components and signal stores. Import PrimeNG modules
  per component instead of centralizing every UI dependency in the root app.
- Runtime status is compact: header chips plus a Manage runtime drawer, not a
  large first-screen checklist.
- Runtime status can be healthy while practice is still blocked by missing
  playable questions. Build, Full Exam, and Random Quiz must surface the
  practice-blocking reason when streamed questions exist but are not selectable.
- Source import uses `language_hint`; `auto` remains the default, while QA uses
  `ja` for the JLPT production PDF.
- Polling is the current async parsing transport. SSE/WebSocket remains a
  future option only if polling becomes visibly expensive or laggy.
- Manual answer/rationale entry is a production fallback, not a debug-only path.
- Full Exam and Random Quiz consume playable editable questions. Older
  approval-gated draft language is superseded.
- A playable question requires approved status, question text, at least two
  nonempty choices, an answer present in the choices, rationale, and either a
  citation page or source excerpt.
- Source files, Draft Review, and Full Exam share an explicit active document
  selection. Draft Review defaults to active-document questions and shows active
  counts against the project total.
- Source import accepts PDF, PNG, JPEG/JPG, static WebP, MP3, WAV, and M4A files
  in one queue while preserving the document library. The client uses bounded
  concurrency (default 2, configurable from 1 through 4), filters unsupported
  MIME/extension hints without discarding valid selections, and leaves content
  validation authoritative to the backend. Each settled request immediately
  releases its slot to the next queued file; a slow audio upload or preflight
  must not create a batch barrier for unrelated PDF/image uploads. Users may
  append supported files while network uploads are active without replacing
  existing queued or in-flight items. Selected, queued, uploading, uploaded,
  failed, canceled, and Retry states remain per file; successful uploads are
  partial success when another file fails, and the most recent successful
  document becomes active.
- The concurrency selector describes simultaneous uploads, not batch size.
  Ambiguous transport failures retain the original operation id for status
  reconciliation, and reconciliation consumes an ordinary queue slot. Canceling
  Whisper consent or a failed/canceled model install releases the pending audio
  authorization so the user can explicitly retry; later readiness must not
  silently upload a source after that authorization was withdrawn.
- Image cropping is optional client-side preprocessing and defaults off. A
  `Crop images before upload` toggle enables a sequential crop review for each
  selected PNG, JPEG/JPG, or static WebP while PDFs keep their original bytes
  and position in the batch. The user can redraw a rectangular crop, enter
  exact pixel bounds, reset to the full image, apply the crop, or keep the
  original image. Choosing or uploading another batch stays locked only while
  that local crop review is unresolved; this lock does not apply to an active
  network upload queue after crop review is complete.
- Applying a crop creates a supported image file with a visible `-cropped`
  filename suffix and then uses the existing multipart upload flow. The bytes
  sent by the client become the persisted source and SHA-256 identity; the app
  does not retain the uncropped image, crop coordinates, or a re-edit history.
  No endpoint, DTO, database, OCR-provider, Retry, concurrency, partial-success,
  or active-document contract changes for this feature.
- Wrong-answer AI help is a per-card, single grounded explanation. Provider
  failures fall back to deterministic copy and must not block refresh, manual
  review, or clearing by a later correct attempt.
- Practice sessions persist the selected playable question fields at session
  creation. Attempts and wrong-answer review grade/read from that session-time
  snapshot, with a live-draft fallback only for older sessions.
- Wrong Answers supports focused retry paths: per-card `Retry` starts a
  `review_retry` session for that attempt, and `Start review quiz` starts a
  `review_retry` session for all current wrong answers. Both flows navigate to
  the existing practice runner and use session-time question snapshots.
- Wrong Answers shows compact weak-area metrics from the backend summary:
  current and cleared counts, last wrong date, repeated misses, and source page
  clusters. The summary remains project-scoped and distinguishes current wrong
  answers from cleared history.
- Wrong-answer responses carry `document_id` for per-source grouping. Filenames
  remain client-derived from loaded documents instead of duplicating filename
  metadata on the wrong-answer DTO.
- `Mark for review` is removed from the practice runner until there is a real
  persisted user flag. Settings, Account, and footer links remain disabled
  design-parity placeholders.

## Workbench Screen Contract

The Stitch workbench folders are separate page references, not alternative
versions of one screen:

- `design/stitch_cert_prep_workbench` maps to Build at `/build`.
- `design/stitch_cert_prep_workbench2` maps to Full Exam at `/full-exam`.
- `design/stitch_cert_prep_workbench3` maps to the Manage Runtime modal opened
  from the app topbar.
- `design/stitch_cert_prep_workbench4` maps to Wrong Answers at `/review`.
- Random Quiz has no dedicated Stitch frame. It inherits the Full Exam runner
  structure and keeps only mode-specific random-draw controls.

Shared workbench rules:

- Use Inter typography, JetBrains Mono for technical data, neutral surfaces,
  Info Blue primary actions, flat 1px outlines, 8px radius, and a 4px spacing
  rhythm.
- Keep the application as a workbench: compact controls, dense readable zones,
  no gradients, no decorative shadows, and no nested decorative card shells.
- Reserve global strips for blocking errors or active work. Routine ready or
  success states stay inside the relevant panel or are omitted.
- Preserve current product behavior and stores during UI alignment passes.

Page requirements:

- Build: show `Cert Prep`, runtime chips in the page header, the workspace
  banner, and the two-column Source files / Mock Exam Items workbench.
- Full Exam: show a source-document selector, `Start full exam`, compact
  document/question/session metrics, stable choice rows, `Submit answer`, and
  a right-side session details / question navigator rail when useful.
- Random Quiz: reuse Full Exam runner language and density, with random-draw
  question count controls.
- Manage Runtime: expose Python Backend, LLM Runtime, Reasoning Model, and OCR
  rows plus refresh, cancel, and close controls. `/runtime` remains a matching
  unguarded recovery/deep-link route.
- Review: show recorded count, refresh, question cards, page chips,
  side-by-side answer panels, rationale/source metadata, and compact footer
  guidance.

## Original Product Guardrails

- Support multiple-choice questions first.
- Save local state in SQLite owned by the Python backend.
- Store original source bytes by SHA-256 under the app data directory.
- Use OpenAPI as the backend/frontend contract source.
- Use fake LLM providers for deterministic automated tests.
- Use selectable-text extraction where available and OCR for image-only
  production flows; vision-only extraction remains outside the current release
  lane.
- No direct filesystem or SQLite access from Angular.
- No live LLM calls in deterministic tests.
- No question record should become playable without citation fields or a
  source excerpt.

## Evidence

- Saved parsed exams and runtime UX packaged QA covered Python/PaddleOCR
  readiness, PDF upload, 46 pages / 46 chunks, manual questions, restart
  persistence, Full Exam, Random Quiz, wrong-answer recording, and review
  clearing.
- Production PDF upload QA used the real JLPT PDF under `pdfs/` and confirmed
  the image-only OCR path with `paddle_ocr_gpu` on `gpu:0`.
- UX performance QA showed the app stayed usable during parsing and that manual
  editing/practice remained viable even when Ollama/model state was offline.
- Latest packaged flow smoke evidence is tracked in
  `domains/parsing-reasoning.md` because it now gates first-chunk and reasoning
  behavior.
- The 2026-06-26 packaged UI/backend/design gap audit passed mocked app e2e and
  packaged flow smoke after the smoke harness was aligned with the new
  workbench UI.
- The 2026-07-02 feature-roadmap implementation added deterministic Playwright
  coverage for completing every playable Random Quiz question, completing Full
  Exam questions for the selected PDF, excluding incomplete approved-looking
  drafts, wrong-answer AI/fallback review, two-PDF Full Exam isolation, and
  project-switch state clearing.
- Reference recordings were generated under
  `dist/.playwright/apps/cert-prep-e2e/recordings/` for
  `practice-complete`, `wrong-answer-ai`, and `multi-pdf-isolation`.
- The 2026-07-02 session-snapshot slice keeps grading and wrong-answer review
  stable even if an editable question changes after the session starts.
- The 2026-07-03 review retry slice added per-card retry, all-current-wrong
  review quiz startup, weak-area summary metrics, wrong-answer `document_id`,
  and practice runner snapshot rendering from `PracticeSessionRead.questions`.
- The 2026-07-03 UI placeholder closeout removed the disabled `Mark for
  review` affordance and added focused coverage for answer selection, clearing,
  disabled/busy submit states, navigator state, and disabled shell
  placeholders.
- The 2026-07-07 multi-PDF source-import closeout verified batch selection,
  per-file upload results, failed-file visibility, active-document handoff,
  binary multipart filename matching, selected-PDF Full Exam startup, and
  reference `multi-pdf-isolation` recordings.
- The 2026-07-17 static-image source closeout added exact PDF/PNG/JPEG/WebP
  selection hints, mixed-batch and partial-failure coverage, generic source-file
  copy, responsive long-filename handling, and real-backend one-page PNG
  terminal-state evidence while retaining the existing PDF flows. The packaged
  app also uploaded a deterministic 256 x 128 PNG and displayed its 1/1-page
  `no_text_detected` result without process residue.
- The 2026-07-17 optional-crop closeout verified the default-off toggle,
  sequential mixed PDF/image review, edge-inclusive pointer and numeric bounds,
  encoding-time input locks and focus recovery, `-cropped` multipart identity,
  and output dimensions plus quadrant-sensitive pixels across Chromium,
  Firefox, and WebKit. A real-browser run also applied and uploaded the cropped
  PNG without console or server errors.
- The 2026-07-19 source-queue closeout verified immediate rolling-slot refill,
  active-run file append, an enabled chooser during transport, delayed Whisper
  readiness, withdrawn consent, exact-operation 503/status reconciliation, and
  cancel-driven slot refill. The final matrix passed 265 Angular tests, all 388
  backend tests, production build, frontend/backend/E2E lint, and 12 Chromium
  scenarios including a held two-PDF queue that starts an appended MP3 when the
  first slot becomes free.
- The 2026-07-20 final review matrix passed 267 Angular tests, all 393 backend
  tests, production build, frontend/backend/E2E lint, and 36 mixed PDF/audio
  queue scenarios across Chromium, Firefox, and WebKit.

## Open Risks

- Large source text previews can make review/edit surfaces tall; a collapsible
  chunk preview or focus mode may be worth a later UX slice.
- Copy/i18n cleanup remains separate from current parsing/reasoning gates.
- Angular initial bundle budget warning is known and not part of the active
  parsing/reasoning TODO.
- Session/debug replay for random seeds should stay backend-testable so UI
  failures can be reproduced without fragile manual clicks.
- The packaged flow smoke currently records `MOCK ITEMS 0` after manual question
  creation. Decide whether that metric is parsed/generated-only or should also
  include manually authored draft questions.
- Bundle and component CSS warning budgets remain noisy after the feature
  roadmap slice, although the production build gate passes.
- Review retry, weak-area metrics, Mark for review policy, and wrong-answer
  document metadata were closed on 2026-07-03. Reopen a new TODO only for a
  persisted user-flag review feature or heavier analytics surface.
