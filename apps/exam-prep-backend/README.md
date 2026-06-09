# Exam Prep Backend

FastAPI sidecar for the local exam prep desktop app.

Useful commands:

```bash
uv run pytest
uv run ruff check .
uv run uvicorn exam_prep_backend.app:create_app --factory --host 127.0.0.1 --port 8765
```

