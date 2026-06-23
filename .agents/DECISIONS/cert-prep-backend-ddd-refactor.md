# Cert Prep Backend DDD Refactor Decisions

## Accepted

- Use `cert_prep_backend/domains/<domain>/` instead of layer-only package names.
- Keep shared platform modules in place for this phase.
- Keep endpoint paths and JSON field names stable.
- Allow OpenAPI enum polish for status-like fields while preserving serialized string values.
- Use enum-or-string DTO annotations for historically string-backed fields so OpenAPI documents known values without rejecting legacy/custom strings.
- Keep generated mock exam drafts as `approved` because that is current tested behavior.
- Remove schema and non-schema compatibility facades after migrating callers to domain modules.
- Use `pnpm nx ...` for all verification.
- Require a `grill-me` Codex implementation review before closeout.

## Deferred

- ORM adoption.
- SQLite schema redesign.
- Frontend UX changes.
- TypeScript generated-client literal-union support.
- Live LLM/OCR smoke checks as required automated gates.

## Guardrails

- No catch-all `utils.py` or god service.
- No large unrelated cleanup.
- No direct Angular filesystem or SQLite access.
- No live provider calls in deterministic tests.
- Every behavior move must be covered by characterization tests or existing API tests.
