# Cert Prep Backend

FastAPI sidecar for the local cert prep desktop app.

See [Question Authoring](../../docs/domain/authoring.md) for the question
routes, generation job events, and upload settings. Background question jobs
run after extraction; only their status updates are streamed.

Useful commands:

```bash
uv run pytest
uv run ruff check .
uv run uvicorn cert_prep_backend.bootstrap.app:create_app --factory --host 127.0.0.1 --port 8765
```
