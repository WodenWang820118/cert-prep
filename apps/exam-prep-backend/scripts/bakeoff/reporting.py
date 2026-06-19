from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
import json
from pathlib import Path

from exam_prep_backend.domains.mock_exams.models import SourceChunk

from bakeoff.data import group_expectation
from bakeoff.execution import run_bakeoff


def build_report(
    *,
    models: Sequence[str],
    chunks: Sequence[SourceChunk],
    host: str,
    timeout_seconds: float,
    limit: int,
) -> dict[str, object]:
    """Build the full bakeoff JSON report payload."""
    expectation = group_expectation(chunks)
    return {
        "schema_version": 1,
        "generated_at": datetime.now(UTC).isoformat(),
        "input": {
            "chunk_count": len(chunks),
            "chunk_ids": [chunk.id for chunk in chunks],
            "expected_group_keys": list(expectation.expected_group_keys),
            "expected_group_items": expectation.expected_group_items,
            "limit": limit,
        },
        "models": run_bakeoff(
            models=models,
            chunks=chunks,
            host=host,
            timeout_seconds=timeout_seconds,
            limit=limit,
        ),
    }


def default_output_path(output_dir: Path) -> Path:
    """Return the timestamped default bakeoff report path."""
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return output_dir / f"reasoning-bakeoff-{stamp}.json"


def write_json_report(report: dict[str, object], output: Path) -> None:
    """Write a newline-terminated UTF-8 JSON report."""
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
