# Angular Resource Migration Spec

## Purpose

Move stable, signal-driven Angular reads from manual Promise orchestration to
Angular 22 `httpResource` state while preserving the generated Promise client
for commands and compatibility.

## Non-Goals

- No backend endpoint, OpenAPI schema, persistence, or database changes.
- No migration of uploads, mutations, Tauri calls, Blob side effects, or job
  polling/reconciliation.
- No requirement for zero Promise usage in the Angular application.

## Interfaces

- The generated API keeps `CertPrepGeneratedClient` and
  `CertPrepTransport.request()` Promise signatures.
- The generated API also exposes a typed request factory for route, method,
  body, and response-type construction.
- The Angular app adds an authenticated HTTP interceptor and a
  `CertPrepHttpResourceClient` backed by `httpResource`.
- Stable query stores expose resource value/status/loading/error signals and
  synchronous reload triggers; command methods remain asynchronous.

## Behavior Requirements

- Relative resource requests use the runtime backend configuration and bearer
  token without putting credentials in URLs.
- Signal key changes cancel obsolete requests and cannot write stale results to
  the current project or document.
- Independent health requests preserve partial success and OCR stale/failed
  state semantics.
- Successful mutations may update writable resource values and then reload for
  server reconciliation.

## Acceptance Criteria

- Project, health, document, draft, active-session, and wrong-answer reads use
  `httpResource` rather than Promise aggregation in their query path.
- Generated route encoding and existing Promise client behavior remain intact.
- Auth, config failure, abort, loading, reload, partial failure, and stale
  project-switch behavior have focused regression coverage.
- Frontend/backend tests, lint, production build, and `git diff --check` pass.
