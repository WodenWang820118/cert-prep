# cert-prep


# Mocked API E2E

See `apps/cert-prep-e2e/src/e2e/mocked-api` for the executable Playwright
suite and `cert-prep-desktop:acceptance-real` for installed
desktop package journeys.


# Integration test taxonomy

Integration ownership is collected by the backend and browser E2E projects;
the frontend keeps source-colocated specs without duplicating
test ownership.


# Cert Prep frontend test levels

Angular specs remain next to their components/services so relative imports and
the Angular unit-test builder stay intact. The `tests/` directories are the
stable taxonomy for runner-owned suites:

- `cert-prep:test`: hermetic UI contract and component unit lane (`cert-prep:test`).
- Backend integration tests: browser/API integration ownership; backend wiring lives in
  `../cert-prep-backend/tests/integration`.
- `cert-prep-e2e:e2e-mocked-api`: mocked API browser E2E lives in
  `../cert-prep-e2e/src/e2e/mocked-api`.


# Unit test taxonomy

Source-colocated Angular specs are collected by the `cert-prep:test` target.
