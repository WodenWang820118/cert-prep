# Long-Running Operation SSE Spec

## Purpose

Replace browser-side polling for Cert Prep HTTP long-running operations with
authenticated Server-Sent Events (SSE). The stream transports the latest
durable operation snapshot and closes after a terminal state, while existing
REST commands and snapshot endpoints remain available for commands, initial
state, and non-streaming consumers.

## Scope

This slice covers:

- document upload/processing operations;
- automatic draft-generation jobs;
- manual draft-generation operations;
- HTTP runtime installation jobs;
- HTTP model-download jobs.

Capture Workbench's existing replayable SSE remains the owner of capture event
transport. Native Tauri-managed Python/Capture Runtime installation commands are
outside this HTTP SSE contract and are not changed in this slice.

## Non-Goals

- Do not convert ordinary CRUD reads/writes to SSE.
- Do not remove REST start, cancel, retry, or snapshot endpoints.
- Do not add an event-history table or replay every historical transition.
- Do not keep the replaced Angular polling timers, polling retry loops, or
  polling-only error state.
- Do not use browser `EventSource`; bearer authentication and abort semantics
  require the existing authenticated `fetch` boundary.

## Interfaces

### SSE endpoints

All endpoints require the same bearer authentication as the REST API, accept
`Last-Event-ID`, return `Cache-Control: no-store` and
`Content-Type: text/event-stream`, and emit JSON data frames:

| Endpoint | Event name | Data snapshot |
| --- | --- | --- |
| `GET /projects/{project_id}/document-operations/{operation_id}/events` | `document-operation` | document operation plus current document when available |
| `GET /projects/{project_id}/documents/{document_id}/document-operation/events` | `document-operation` | active document operation plus current document |
| `GET /projects/{project_id}/documents/{document_id}/draft-jobs/events` | `draft-jobs` | `{ "items": DraftGenerationJobRead[] }` |
| `GET /projects/{project_id}/documents/{document_id}/draft-operations/{operation_id}/events` | `draft-operation` | manual draft operation |
| `GET /runtime/installations/{job_id}/events` | `runtime-installation` | runtime installation snapshot |
| `GET /llm/model-downloads/{job_id}/events` | `model-download` | model download snapshot |

Each connection emits monotonically increasing stream-local SSE `id` values;
the optional `Last-Event-ID` seeds that sequence on reconnect. A newly
connected client always receives the latest snapshot; reconnects do not promise
historical event replay.

The stream emits a comment heartbeat when no database revision changes within
the heartbeat interval. It emits a terminal event for succeeded, failed, or
canceled state and then closes. Disconnecting the client must release the
database read and generator without mutating the operation.

### Frontend boundary

The shared authenticated SSE client accepts a URL path and expected event name,
creates a cold RxJS Observable, adds the bearer token and optional
`Last-Event-ID`, and aborts the fetch/reader when unsubscribed. It validates
`text/event-stream`, bounded frame sizes, event IDs, event names, and JSON
payloads.

Stores subscribe when an operation becomes active, apply snapshots to existing
signals, and unsubscribe on terminal state, context change, or reset. A stream
transport failure is surfaced as a stream error and can be retried explicitly;
there is no timer-based polling fallback.

## Key Decisions

1. Database commits are the notification source. `Database.connect()` publishes
   one revision only when a transaction changed data, avoiding scattered
   notifier calls across every domain mutation.
2. Streams are snapshot streams, not a second business-state machine. Existing
   domain managers and persisted status transitions remain authoritative.
3. Initial snapshots and terminal snapshots are always sent even when there
   was no prior live subscription. This supports late subscribers and app
   restart recovery.
4. Existing REST snapshot routes stay because they are still useful for
   reconciliation, direct navigation, and non-browser clients; the Angular
   polling orchestration that made them repeatedly necessary is deleted.

## Edge Cases and Failure Modes

- A database change unrelated to the subscribed operation wakes a stream; the
  stream must compare snapshots and emit only when its payload changed.
- A terminal operation must produce exactly one terminal data frame before the
  connection completes.
- A client unsubscribe or abort must not cancel or alter server-side work.
- Malformed or oversized SSE frames must fail closed on the client.
- Unknown operation/job/project/document IDs must retain existing 404 behavior.
- Runtime jobs may be evicted from the in-memory manager; their existing
  snapshot error semantics remain unchanged.
- A reconnect receives the current snapshot and may skip intermediate states;
  final durable state is the correctness boundary.

## Acceptance Criteria

- No production Angular code in the scoped HTTP flows uses a timer to refresh
  an operation/job/document status.
- Each scoped operation has an authenticated SSE endpoint with the documented
  event name and snapshot shape.
- A database state transition wakes the matching stream without a client timer.
- Unrelated database transitions do not produce duplicate operation snapshots.
- Terminal streams emit one terminal frame and close.
- Client unsubscribe aborts the underlying fetch/reader.
- Document, draft, runtime, and model store tests prove live snapshot handling,
  context cleanup, terminal cleanup, and stream errors.
- Existing REST command/snapshot behavior and Capture Workbench SSE behavior
  remain green.

## Test Plan

- Python unit tests for database-change notification and snapshot stream helper.
- FastAPI contract tests for every SSE endpoint, auth, initial snapshot,
  terminal close, heartbeat, and unknown-resource behavior.
- TypeScript unit tests for the shared authenticated SSE parser and abort path.
- Store tests replacing timer advancement with controlled SSE Observables.
- Nx backend/frontend lint, test, generated OpenAPI client, and build targets.
