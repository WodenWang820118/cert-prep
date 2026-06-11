from __future__ import annotations

from dataclasses import asdict
import argparse
import json
import sys

from exam_prep_backend.config import Settings
from exam_prep_backend.domains.source_documents.adapters.diagnostics import run_ocr_diagnostics
from exam_prep_backend.domains.source_documents.adapters.paddle import PaddleOCRProvider


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", default="auto")
    parser.add_argument("--ocr-health", action="store_true")
    parser.add_argument("--ocr-self-test", action="store_true")
    parser.add_argument("--ocr-page")
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

    parser.error("one of --ocr-health, --ocr-self-test, or --ocr-page is required")


if __name__ == "__main__":
    main()
