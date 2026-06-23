# Backend Refactor (apps/cert-prep-backend) TODO

## Module-Level Side Effect (high priority)

- [x] Remove `app = create_app()` at module level in `main.py:6`. The module-level instantiation causes side effects on import (e.g., during pytest collection or any script that imports from `cert_prep_backend`). The `main()` function already uses the factory pattern; the module-level variable should be removed.
  Affected: `apps/cert-prep-backend/src/cert_prep_backend/main.py`
  Verify: `uv run python -c "from cert_prep_backend.main import main; print('no side effect')"` (should not start a server)

## Redundant Entrypoint

- [ ] Eliminate or consolidate `sidecar.py`. It is a thin wrapper that only calls `main()`. If needed as the desktop-sidecar entrypoint, rename to a clearer name (e.g., `desktop_entrypoint.py`) or remove it entirely and use `main.py` directly.
  Affected: `apps/cert-prep-backend/src/cert_prep_backend/sidecar.py`
  Verify: `pnpm nx run cert-prep-backend:lint`

## Duplicated Constants

- [ ] Move `DEFAULT_OLLAMA_MODEL = "qwen3.5:4b"` to a single shared location. Currently duplicated in:
  - `apps/cert-prep-backend/src/cert_prep_backend/config.py`
  - `apps/cert-prep-desktop/src-tauri/src/backend_process.rs`
  Consider: expose via a backend endpoint, or generate a shared constants file at build time.
  Verify: `rg "qwen3.5:4b" apps/ packages/ --no-heading` (should find only one canonical definition)

## Large Router Extraction

- [ ] Extract async document processing thread management from `routers/documents.py` into a dedicated service module (e.g., `domains/source_documents/processing_service.py`). The `_process_document_upload` thread logic and `_prepare_document_ocr_provider` should live in the domain layer, not in the router.
  Affected: `apps/cert-prep-backend/src/cert_prep_backend/routers/documents.py`
  Verify: `pnpm nx run cert-prep-backend:test && pnpm nx run cert-prep-backend:lint`

## Database Migrations

- [x] Evaluate introducing Alembic for schema migrations. The inline SQL migration tuples in `database.py` work for now but will become unwieldy as the schema grows beyond 6+ migrations.
  Affected: `apps/cert-prep-backend/src/cert_prep_backend/database.py`
  Verify: manual review, no automated gate yet; add a note in the file about migration strategy

## Final Check

- [ ] Full test + lint gate:
  Verify: `pnpm nx run cert-prep-backend:lint && pnpm nx run cert-prep-backend:test`
