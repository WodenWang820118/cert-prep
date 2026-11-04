# Product And UX Domain

## Purpose

Cert Prep is a local-first Windows/Tauri certification-prep app. The core user
journey is: create/select a project, upload a source document, capture and
review its extracted text, review editable questions, practice through Full Exam
or Random Quiz, and clear wrong-answer review state through correct attempts.

The production acceptance path is deterministic/manual first. AI reasoning is
optional enrichment and must not block capture review, manual question creation,
practice, or review flows after a source has been captured.

## Decisions

- Projects own source documents, parsed chunks, editable question records,
  practice sessions, and wrong-answer review state.
- The Angular UI keeps workflow panels for projects, source import, question
  review/editing, practice, and wrong-answer review.
- Use spartan-ng components with Angular 22. Their styled layer is copied
  into `libs/ui` (import alias `@spartan-ng/helm/*`) and is this project's own
  code; add more with `pnpm nx g @spartan-ng/cli:ui <name>`. Do not add
  PrimeNG: its releases from version 22 need a commercial licence.
- Draw icons with Lucide through `app-icon`; `components/ui/app-icons.ts`
  lists the icons the app ships.
- Use Tailwind CSS 4 through `@tailwindcss/postcss`. The colours the spartan
  components read are set in `styles.css` from the workbench palette.
- Keep standalone Angular components and signal stores. Import UI components
  per component instead of centralizing every UI dependency in the root app.
- Use Angular `httpResource` for stable signal-driven reads. The generated
  OpenAPI client keeps its Promise contract for commands and compatibility,
  while a generated typed request factory supplies route-safe requests to the
  authenticated resource client. Resource keys own project/document scope so
  changing selection cancels obsolete reads and cannot write stale data into
  the current workbench.
- Keep non-capture uploads, mutations, Tauri calls, Blob audio, and
  reconciliation on the existing Promise command boundary. The Capture
  Workbench v2 client is the exception: its public lifecycle and progress APIs
  remain RxJS Observables, including cancellation on unsubscribe. Successful
  mutations may update a writable resource immediately and reload when server
  reconciliation is needed; query `load`/`refresh` methods are synchronous
  reload triggers.
- Runtime status is compact: header chips plus a Manage runtime drawer, not a
  large first-screen checklist.
- Runtime status can be healthy while practice is still blocked by missing
  playable questions. Build, Full Exam, and Random Quiz must surface the
  practice-blocking reason when streamed questions exist but are not selectable.
- Source import uses `language_hint`; `auto` remains the default, while QA uses
  `ja` for the JLPT production PDF.
- Capture Workbench progress uses authenticated replayable SSE with
  `Last-Event-ID`; normal capture progress never polls. Bounded polling remains
  limited to unrelated host-owned readiness and reconciliation workflows.
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
  Capture Runtime setup or a failed/canceled capture releases the
  pending source authorization so the user can explicitly retry; later readiness
  must not silently upload a source after that authorization was withdrawn.
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

The workbench screens are Build at `/build`, Full Exam at `/full-exam`,
Random Quiz at `/random-quiz`, Wrong Answers at `/review`, and the Manage
Runtime modal opened from the app topbar (`/runtime` is the matching unguarded
route). Random Quiz inherits the Full Exam runner structure and keeps only
mode-specific random-draw controls.

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
- Manage Runtime: expose Python Backend, LLM Runtime, and Reasoning Model rows
  plus refresh, cancel, and close controls. Capture Workbench owns Capture
  Runtime setup. `/runtime` remains a matching
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
- Every PDF page and image goes through Capture Runtime OCR; Cert Prep does
  not extract embedded PDF text. Vision-model extraction is out of scope.
- No direct filesystem or SQLite access from Angular.
- No live LLM calls in deterministic tests.
- No question record should become playable without citation fields or a
  source excerpt.

## Open Risks

- Large source text previews can make review/edit surfaces tall; a collapsible
  chunk preview or focus mode may be worth a later UX slice.
- Copy/i18n cleanup remains separate from current parsing/reasoning gates.
- The Angular initial bundle budget warning is known.
- Session/debug replay for random seeds should stay backend-testable so UI
  failures can be reproduced without fragile manual clicks.
- Bundle and component CSS warning budgets remain noisy, although the
  production build gate passes.
- A persisted user-flag review feature or a heavier analytics surface would
  need its own TODO.
