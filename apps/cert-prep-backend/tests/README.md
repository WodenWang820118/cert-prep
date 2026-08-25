# Cert Prep backend test levels

The backend test tree is split by runtime boundary:

- `unit/`: domain policies, parsers, contracts, and deterministic installers.
- `integration/`: FastAPI, persistence, Capture Runtime, provider, and SSE wiring.
- `../cert-prep-e2e/src/e2e/local-package/`: real local workspace E2E.
- `../cert-prep-e2e/src/e2e/online-package/`: reserved for an explicitly pinned online package; no online case is enabled by default.

Run the levels through Nx:

```text
pnpm nx run cert-prep-backend:test-unit
pnpm nx run cert-prep-backend:test-integration
pnpm nx run cert-prep-backend:test
```

The root `conftest.py` and test support modules remain shared fixtures. The
test package is on `pythonpath` so moved tests retain the existing fixture
imports without changing application behavior.
