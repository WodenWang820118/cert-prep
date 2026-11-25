# Cert Prep E2E levels

- `mocked-api/`: browser journeys against the checked-out application with
  a route-mocked API (`mocked-journeys.spec.ts`). The Questions page at
  `/questions` uses the project question collection and named SSE events
  `question-jobs` and `question-generation`.
- `../support/`: shared browser fixtures and route helpers; it is not a test
  suite by itself.
