from __future__ import annotations

from dataclasses import asdict
import argparse
import json
from pathlib import Path
import sys
from typing import Any

from exam_prep_backend.config import Settings
from exam_prep_backend.domains.source_documents.adapters.diagnostics import run_ocr_diagnostics
from exam_prep_backend.domains.source_documents.adapters.paddle import PaddleOCRProvider


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", default="auto")
    parser.add_argument("--ocr-health", action="store_true")
    parser.add_argument("--ocr-self-test", action="store_true")
    parser.add_argument("--ocr-page")
    parser.add_argument("--ocr-worker", action="store_true")
    parser.add_argument("--page-number", type=int, default=1)
    args = parser.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    if args.ocr_self_test:
        result = run_ocr_diagnostics(
            Settings(ocr_provider="paddle", ocr_device=args.device, ocr_runtime_mode="inprocess")
        )
        print(json.dumps(result, ensure_ascii=False))
        raise SystemExit(0 if result["ok"] else 1)

    provider = PaddleOCRProvider(device=args.device)
    if args.ocr_worker:
        _run_worker(provider)
        return

    if args.ocr_health:
        print(json.dumps(asdict(provider.health()), ensure_ascii=False))
        return

    if args.ocr_page:
        image_png = open(args.ocr_page, "rb").read()
        print(
            json.dumps(
                asdict(provider.extract_page_text(image_png, args.page_number)),
                ensure_ascii=False,
            )
        )
        return

    parser.error("one of --ocr-health, --ocr-self-test, --ocr-page, or --ocr-worker is required")


def _run_worker(provider: PaddleOCRProvider) -> None:
    for line in sys.stdin:
        if not line.strip():
            continue
        print(
            json.dumps(_worker_response(provider, line), ensure_ascii=False),
            flush=True,
        )


def _worker_response(provider: PaddleOCRProvider, line: str) -> dict[str, Any]:
    job_id: str | None = None
    try:
        job = json.loads(line)
        if not isinstance(job, dict):
            raise ValueError("Worker job must be a JSON object.")
        job_id = _optional_string(job.get("id"))
        image_path = Path(str(job["image_path"]))
        page_number = int(job["page_number"])
        result = provider.extract_page_text(image_path.read_bytes(), page_number)
        return {
            "id": job_id,
            "ok": True,
            "result": asdict(result),
        }
    except Exception as exc:
        return {
            "id": job_id,
            "ok": False,
            "error": str(exc),
        }


def _optional_string(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


if __name__ == "__main__":
    main()
