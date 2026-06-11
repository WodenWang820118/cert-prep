from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from exam_prep_backend.config import Settings
from exam_prep_backend.domains.source_documents.adapters.diagnostics import run_ocr_diagnostics


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", choices=["fake", "ollama", "paddle"], default="paddle")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--strict-lane", choices=["cpu", "gpu"])
    parser.add_argument("--fail-on-error", action="store_true")
    args = parser.parse_args()

    result = run_ocr_diagnostics(
        Settings(ocr_provider=args.provider, ocr_device=args.device, ocr_runtime_mode="inprocess"),
        strict_lane=args.strict_lane,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if args.fail_on_error and not result["ok"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
