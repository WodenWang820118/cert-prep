# Long-Running Operation SSE Decisions

## Decision

Use authenticated snapshot SSE for long-running HTTP operations and delete the
Angular polling orchestration it replaces. Keep REST commands and snapshot
endpoints as explicit one-shot operations.

## Considered options

1. Keep polling and only reduce intervals. Rejected: it retains duplicated
   retry/timer state and does not meet the requested transport migration.
2. Make each SSE generator poll SQLite on a timer. Rejected: it only moves the
   old polling mechanism to the server and creates needless database traffic.
3. Publish one revision from the database commit boundary and let each stream
   compare its durable snapshot. Chosen: one notification owner, no scattered
   domain callbacks, late-subscriber safety, and direct deletion of frontend
   polling.

## Delete/edit/create checkpoint

Change mode: mixed
Existing owner: `Database` for change notification; existing operation
managers/stores for lifecycle state; existing authenticated `fetch` boundary
for browser transport.
Delete candidates: scoped Angular `timer` subscriptions, polling retry
constants, polling-only error fields/methods, and polling-only store helpers.
New owner needed: yes, a shared operation SSE stream helper and backend
snapshot-stream helper, because no existing owner handles authenticated generic
SSE for these payloads.
Token posture: compact quality.
Verification floor: endpoint contract tests, parser/abort tests, store tests,
backend/frontend Nx lint/test/build, generated client, and diff check.

## Compatibility

The wire change is additive: REST routes remain available. The Angular runtime
behavior is intentionally breaking for the old polling implementation because
its timers and polling fallback are removed as requested.

## Known boundary

Native Tauri commands for Python Runtime and Capture Runtime installation do
not use the HTTP API. They remain outside this SSE slice; changing them requires
a Tauri event-channel contract rather than an HTTP SSE endpoint.
