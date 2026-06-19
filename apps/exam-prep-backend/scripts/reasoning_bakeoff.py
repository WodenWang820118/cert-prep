from __future__ import annotations

import argparse
from collections.abc import Sequence
import json
import os
from pathlib import Path
import sys


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from bakeoff.config import (  # noqa: E402
    DEFAULT_LIMIT,
    DEFAULT_MODELS,
    DEFAULT_OLLAMA_HOST,
    DEFAULT_OUTPUT_DIR,
)
from bakeoff.data import load_chunks  # noqa: E402
from bakeoff.reporting import (  # noqa: E402
    build_report,
    default_output_path as _default_output_path,
    write_json_report,
)


def default_output_path() -> Path:
    """Return the timestamped default report path used by the CLI."""
    return _default_output_path(DEFAULT_OUTPUT_DIR)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output", type=Path, default=default_output_path())
    parser.add_argument("--model", action="append", dest="models")
    parser.add_argument(
        "--host",
        default=os.environ.get("EXAM_PREP_OLLAMA_HOST", DEFAULT_OLLAMA_HOST),
    )
    parser.add_argument("--timeout-seconds", type=float, default=180.0)
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> None:
    """Run the reasoning bakeoff CLI."""
    args = parse_args(argv)
    models = tuple(args.models or DEFAULT_MODELS)
    chunks = load_chunks(args.input)
    report = build_report(
        models=models,
        chunks=chunks,
        host=args.host,
        timeout_seconds=args.timeout_seconds,
        limit=args.limit,
    )
    write_json_report(report, args.output)
    print(json.dumps({"output": str(args.output), "models": list(models)}, indent=2))


if __name__ == "__main__":
    main()
