# Backend Architecture Domain

## Purpose

This domain owns backend module boundaries, persistence contracts, generated
client ownership, and behavior-preserving refactor decisions across FastAPI,
SQLite, Capture Runtime integration, runtime installation, question generation,
and practice.

## Decisions

- Backend code is split into bounded contexts directly under
  `cert_prep_backend/` (`projects`, `source_library`, `capture_integration`,
  `authoring`, `practice`, `ai_providers`, `runtime_provisioning`), each with
  `domain`, `application`, `infrastructure` and `api` layers, plus `platform`
  (settings, errors, database and migrations, SSE, background work) and
  `bootstrap` (app assembly). The plan, rules and decisions are in
  [`.agents/PLANS/ddd-refactor/`](../../PLANS/ddd-refactor/README.md); each
  context is described in [`docs/domain/`](../../../docs/domain/README.md).
  import-linter contracts in `apps/cert-prep-backend/pyproject.toml` enforce the
  direction.
- Public DTOs are owned by their context's `api` layer. OpenAPI client generation must
  be rerun after route/schema changes.
- Primitive JSON Schema `const` values emitted by public DTOs remain literal
  types in the generated TypeScript client. This is required for named
  discriminated unions such as `CaptureOcrProvenanceRead` to narrow exhaustively;
  generated output is never edited by hand.
- The pinned Capture Runtime SDK is the sole wire authority for Capture Runtime
  discovery, transport, retries, SSE decoding, wire DTOs, v2 ingestion/capture,
  and typed pull sessions. Cert Prep adapters may add product-facing
  validation, but must not duplicate runtime wire behavior.
- Endpoint paths and JSON field names stay stable unless a spec explicitly
  authorizes a contract change.
- Status-like fields may receive OpenAPI enum polish while preserving existing
  serialized string values.
- Historically string-backed fields can use enum-or-string DTO annotations so
  OpenAPI documents known values without rejecting legacy/custom strings.
- SQLite remains backend-owned; Angular must not read or write local files
  directly.
- Capture Runtime workers never write directly to SQLite. The backend processing
  thread owns idempotent chunk/progress persistence after host validation.
- Capture Runtime mapping, review, and persistence are consumer-local: Cert Prep
  owns the `CaptureDocument` mapping, review overrides, and SQLite writes after
  host confirmation. Typed pull-session batching, prompt/schema projection,
  semantic validation, and provenance reconstruction remain runtime-owned.
- Generated/AI questions must stay editable and user-governed. Older
  approval-only promotion behavior is retired.
- Behavior-preserving refactors should keep external Tauri command, REST, and
  generated client contracts stable unless the spec explicitly says otherwise.
- Practice session selection and attempt lookup share the backend playable
  predicate: approved question text, at least two nonempty choices, answer in
  choices, rationale, and source evidence from citation page or source excerpt.
- Practice sessions persist selected question snapshots when the session is
  created. Attempt grading and wrong-answer review prefer the immutable
  snapshot and fall back to the live draft only for sessions created before the
  snapshot table exists.
- Wrong-answer explanation API is
  `POST /projects/{project_id}/wrong-answers/{attempt_id}/explanation`.
  It must re-resolve the attempt as a current wrong answer in the same project
  before returning grounded fields, provider/model metadata, and fallback state.
- Practice sessions support `review_retry` mode. `PracticeSessionCreate` accepts
  optional `wrong_attempt_ids`; omitted means all current wrong answers for the
  project, while a provided list narrows retry to those current wrong-answer
  attempts.
- `PracticeSessionRead` includes `questions`, a session snapshot DTO with
  question text, choices, answer, rationale, citation page, source excerpt, and
  nullable `document_id`. `question_ids` remains for compatibility.
- `WrongAnswerRead` includes nullable `document_id`, and the project-scoped
  wrong-answer summary endpoint is
  `GET /projects/{project_id}/wrong-answers/summary`.
- Mixed PDF/static-image upload remains a client-side batch workflow over the
  existing single-document boundary. Backend v1 keeps
  `POST /projects/{project_id}/documents` as the only upload endpoint; its
  multipart field, operation header, status codes, response DTOs, and error
  envelope remain unchanged. PNG, JPEG/JPG, and static WebP are additive
  accepted inputs, with no database migration, `DocumentRead.media_type`, or
  image-specific endpoint/service. Chunks, generated drafts, practice
  selection, attempts, and wrong-answer review stay scoped by `document_id`.
- `source_preparation.py` owns trusted content detection and normalized input
  validation; extraction belongs to Capture Runtime. Source storage/repository helpers use source-file terminology, retain
  original bytes and SHA-256, choose private suffixes from detected content,
  and revalidate stored content on Retry. Legacy `.pdf` paths remain readable.
- Rolling back this additive input support does not require database or chunk
  cleanup, but an older backend cannot retry image documents created by the
  newer version.

## Refactor Policy

Accepted:

- Bounded contexts and layers as described in the DDD plan; no layer-only
  top-level packages.
- Keep generated mock exam drafts as `approved` when that is the current tested
  behavior.
- Remove schema and non-schema compatibility facades after callers move to
  domain modules.
- Use `pnpm nx ...` for verification.
- Require a second-opinion implementation review before closing broad backend
  refactor slices when requested by the active plan.

Deferred:

- ORM adoption.
- SQLite schema redesign.
- Frontend UX changes bundled into backend refactors.
- Broad TypeScript generated-client inline-enum polish. Primitive `const`
  preservation required by an explicitly approved discriminated contract is
  not part of this deferral.
- Cross-platform Capture Runtime nodes beyond the published Windows x64 contract.

Guardrails:

- No catch-all `utils.py` or god service.
- No large unrelated cleanup.
- No direct Angular filesystem or SQLite access.
- No live provider calls in deterministic tests.
- Every behavior move must be covered by characterization tests or existing API
  tests.
- Behavior-preserving refactors must keep REST/OpenAPI, Tauri command, and
  package QA JSON contracts stable unless the owning spec says otherwise.

## Open Risks

- Backend schema changes require generated client updates and frontend tests.
- Page-level render/OCR failures should stay explicit; do not collapse a
  partial page failure into a misleading zero-chunk document.
- Source excerpts must remain grounded in normalized raw chunk text.
- UTF-8 handling remains important for PDF names, OCR text, SQLite evidence,
  Markdown reports, subprocess stderr, and PowerShell JSON reads.
- Keep the Capture Runtime sidecar protocol and authenticated error envelope
  clean; third-party logs belong on stderr.
