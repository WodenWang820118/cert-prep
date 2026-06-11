import json
import os
import sys

import uvicorn

from exam_prep_backend.app import create_app
from exam_prep_backend.config import Settings
from exam_prep_backend.domains.source_documents.adapters.diagnostics import run_ocr_diagnostics


app = create_app()


def main() -> None:
    if "--ocr-self-test" in sys.argv:
        result = run_ocr_diagnostics(Settings(ocr_provider="paddle"))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        raise SystemExit(0 if result["ok"] else 1)

    host = os.environ.get("EXAM_PREP_HOST", "127.0.0.1")
    port = int(os.environ.get("EXAM_PREP_PORT", "8765"))
    uvicorn.run("exam_prep_backend.app:create_app", factory=True, host=host, port=port)


if __name__ == "__main__":
    main()
