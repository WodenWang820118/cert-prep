from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from cert_prep_backend.config import Settings
from cert_prep_backend.domains.source_documents.adapters.benchmark import benchmark_pdf_page


REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_PAGE_3_ANCHORS = ["問題2", "合併", "中山", "加筆"]


def _default_pdf_path() -> Path:
    configured = os.environ.get("CERT_PREP_OCR_BENCHMARK_PDF")
    if configured:
        return Path(configured)
    candidates = sorted((REPO_ROOT / "pdfs").glob("*N1*.pdf"))
    if candidates:
        return candidates[0]
    return REPO_ROOT / "pdfs" / "jlpt-n1.pdf"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--pdf",
        type=Path,
        default=_default_pdf_path(),
    )
    parser.add_argument("--page", type=int, default=3)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--anchor", action="append")
    parser.add_argument("--allow-fallback", action="store_true")
    parser.add_argument("--allow-missing-anchors", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    anchors = args.anchor
    if anchors is None:
        anchors = DEFAULT_PAGE_3_ANCHORS if args.page == 3 else []
    result = benchmark_pdf_page(
        Settings(ocr_provider="paddle", ocr_device=args.device),
        pdf_path=args.pdf,
        page_number=args.page,
        anchors=anchors,
    )
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text, encoding="utf-8")
    print(text)
    missing_anchors = [
        anchor for anchor, present in result["anchors_present"].items() if not present
    ]
    if missing_anchors and not args.allow_missing_anchors:
        raise SystemExit(f"Missing OCR anchors: {', '.join(missing_anchors)}")
    if _is_explicit_gpu(args.device) and not args.allow_fallback:
        result_device = str(result["device"] or "")
        if not result_device.startswith("gpu"):
            reason = result["fallback_reason"] or "unknown"
            raise SystemExit(f"GPU benchmark fell back to {result_device}: {reason}")


def _is_explicit_gpu(device: str) -> bool:
    return device.strip().lower().startswith("gpu")


if __name__ == "__main__":
    main()
