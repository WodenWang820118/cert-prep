# Cert Prep E2E levels

- `mocked-api/`: browser journeys against the checked-out application with
  a route-mocked API (`mocked-journeys.spec.ts`). The Questions page at
  `/questions` uses the project question collection and named SSE events
  `question-jobs` and `question-generation`.
- `../support/`: shared browser fixtures and route helpers; it is not a test
  suite by itself.
- `../real-engines/`: manual dev-server journey with the published Capture
  Runtime (`cert-prep-e2e:smoke-real-engines-dev-server`). It is not part of
  `pnpm ci:local`. The pure device checks are `cert-prep-e2e:real-engines-unit-test`.
