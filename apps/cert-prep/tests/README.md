# Cert Prep frontend test levels

Angular specs remain next to their components/services so relative imports and
the Angular unit-test builder stay intact. The `tests/` directories are the
stable taxonomy for runner-owned suites:

- `unit/`: hermetic UI contract and component unit lane (`cert-prep:test`).
- `integration/`: browser/API integration ownership; backend wiring lives in
  `../cert-prep-backend/tests/integration`.
- `e2e/local-package/`: local browser package E2E lives in
  `../cert-prep-e2e/src/e2e/local-package`.
- `e2e/online-package/`: reserved for a pinned online package; no case is
  enabled here.
