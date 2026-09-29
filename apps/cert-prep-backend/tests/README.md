# Cert Prep backend test levels

The backend test tree is split by runtime boundary:

- `unit/`: domain policies, parsers, contracts, and deterministic installers.
- `integration/`: FastAPI, persistence, Capture Runtime, provider, and SSE wiring.
- `../cert-prep-e2e/src/e2e/local-package/`: browser E2E against a route-mocked API.

Run the levels through Nx:

```text
pnpm nx run cert-prep-backend:test-unit
pnpm nx run cert-prep-backend:test-integration
pnpm nx run cert-prep-backend:test
```

The root `conftest.py` and test support modules remain shared fixtures. The
test package is on `pythonpath` so moved tests retain the existing fixture
imports without changing application behavior.
