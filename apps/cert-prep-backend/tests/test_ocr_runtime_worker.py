from __future__ import annotations

import json
from pathlib import Path
import sys

from cert_prep_backend.ocr_runtime import _run_worker

from ocr_test_support import RuntimeWorkerFakeProvider, jsonl


def test_ocr_runtime_worker_protocol_processes_multiple_jsonl_jobs(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    image_1 = tmp_path / "page-1.png"
    image_2 = tmp_path / "page-2.png"
    image_1.write_bytes(b"\x89PNG page 1")
    image_2.write_bytes(b"\x89PNG page 2")
    monkeypatch.setattr(
        sys,
        "stdin",
        jsonl(
            {"id": "job-1", "image_path": str(image_1), "page_number": 1},
            {"id": "job-2", "image_path": str(image_2), "page_number": 2},
        ),
    )

    provider = RuntimeWorkerFakeProvider()
    _run_worker(provider)

    lines = capsys.readouterr().out.splitlines()
    assert [json.loads(line)["id"] for line in lines] == ["job-1", "job-2"]
    assert [json.loads(line)["result"]["text"] for line in lines] == [
        "worker page 1",
        "worker page 2",
    ]
    assert provider.page_numbers == [1, 2]
