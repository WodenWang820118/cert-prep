from __future__ import annotations

import argparse
from collections.abc import Sequence
import json
import os
from pathlib import Path

from .constants import CONVERTERS, DEFAULT_MODEL_DIR, DEFAULT_SOURCES_DIR
from .report import build_report, default_output_path


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=default_output_path())
    parser.add_argument("--sources-dir", type=Path, default=DEFAULT_SOURCES_DIR)
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    parser.add_argument(
        "--skip-download",
        action="store_true",
        help="Only use already cached official Paddle model archives.",
    )
    parser.add_argument(
        "--skip-conversion",
        action="store_true",
        help="Prepare sources and metadata but do not invoke Paddle2ONNX.",
    )
    parser.add_argument(
        "--converter",
        choices=CONVERTERS,
        default=os.environ.get("CERT_PREP_WINDOWSML_CONVERTER", "local"),
        help="Paddle2ONNX execution environment for missing or forced ONNX conversion.",
    )
    parser.add_argument(
        "--force-conversion",
        action="store_true",
        help="Run conversion even when prepared ONNX targets already exist.",
    )
    parser.add_argument(
        "--fail-if-not-ready",
        action="store_true",
        help="Exit non-zero unless det/rec ONNX models, dictionary, and pipeline are ready.",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    report = build_report(
        sources_dir=args.sources_dir,
        model_dir=args.model_dir,
        allow_download=not args.skip_download,
        allow_conversion=not args.skip_conversion,
        converter=args.converter,
        force_conversion=args.force_conversion,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))

    if args.fail_if_not_ready and report["status"]["state"] != "ready":
        raise SystemExit(1)
