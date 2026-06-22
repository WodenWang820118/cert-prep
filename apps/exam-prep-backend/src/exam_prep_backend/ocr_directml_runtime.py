from __future__ import annotations

from dataclasses import asdict
import argparse
import json
from pathlib import Path
import sys
import traceback
from typing import Any

from exam_prep_backend.domains.source_documents.adapters.directml import (
    DirectMLRuntimeOCRProvider,
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", choices=["directml"], default="directml")
    parser.add_argument("--directml-device-id", type=int, default=-1)
    parser.add_argument("--model-dir", type=Path)
    parser.add_argument("--ocr-health", action="store_true")
    parser.add_argument("--ocr-self-test", action="store_true")
    parser.add_argument("--ocr-page")
    parser.add_argument("--ocr-worker", action="store_true")
    parser.add_argument("--page-number", type=int, default=1)
    args = parser.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    if args.ocr_self_test:
        result = _self_test(args)
        print(json.dumps(result, ensure_ascii=False))
        raise SystemExit(0 if result["ok"] else 1)

    provider = _provider_from_args(args)
    if args.ocr_worker:
        _run_worker(provider)
        return

    if args.ocr_health:
        print(json.dumps(asdict(provider.health()), ensure_ascii=False))
        return

    if args.ocr_page:
        image_png = Path(args.ocr_page).read_bytes()
        print(
            json.dumps(
                asdict(provider.extract_page_text(image_png, args.page_number)),
                ensure_ascii=False,
            )
        )
        return

    parser.error("one of --ocr-health, --ocr-self-test, --ocr-page, or --ocr-worker is required")


def _provider_from_args(args: argparse.Namespace) -> DirectMLRuntimeOCRProvider:
    return DirectMLRuntimeOCRProvider(
        model_dir=args.model_dir or _default_model_dir(),
        device_id=args.directml_device_id,
    )


def _self_test(args: argparse.Namespace) -> dict[str, Any]:
    provider = _provider_from_args(args)
    try:
        result = provider.extract_page_text(_self_test_png(), 1)
    except Exception as exc:
        return {
            "ok": False,
            "provider": "directml",
            "error_type": type(exc).__name__,
            "error": str(exc),
            "cause": str(exc.__cause__) if exc.__cause__ is not None else None,
            "context": str(exc.__context__) if exc.__context__ is not None else None,
            "traceback_tail": traceback.format_exc()[-3000:],
        }
    normalized = result.text.replace(" ", "").replace("\n", "")
    return {
        "ok": "OCR" in normalized and "TEST" in normalized,
        "provider": "directml",
        "result": asdict(result),
    }


def _default_model_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[2] / ".benchmarks" / "ocr-directml-models"


def _run_worker(provider: DirectMLRuntimeOCRProvider) -> None:
    for line in sys.stdin:
        if not line.strip():
            continue
        print(
            json.dumps(_worker_response(provider, line), ensure_ascii=False),
            flush=True,
        )


def _worker_response(provider: DirectMLRuntimeOCRProvider, line: str) -> dict[str, Any]:
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


def _self_test_png() -> bytes:
    from io import BytesIO

    from PIL import Image, ImageDraw

    image = Image.new("RGB", (160, 56), "white")
    draw = ImageDraw.Draw(image)
    draw.text((8, 16), "OCR TEST", fill="black")
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


if __name__ == "__main__":
    main()
