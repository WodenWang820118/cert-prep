from __future__ import annotations

import json
from pathlib import Path
import sys

from exam_prep_backend.config import Settings
from exam_prep_backend.domains.source_documents.adapters.external_paddle import (
    ExternalPaddleOCRProvider,
)
from exam_prep_backend.domains.source_documents.ocr import OCRPageResult


class RuntimeWorkerFakeProvider:
    def __init__(self) -> None:
        self.page_numbers: list[int] = []

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        assert image_png.startswith(b"\x89PNG")
        self.page_numbers.append(page_number)
        return OCRPageResult(
            text=f"worker page {page_number}",
            extraction_method="paddle_ocr_cpu",
            device="cpu",
            fallback_reason=None,
            duration_ms=7,
        )


def jsonl(*payloads: dict) -> object:
    from io import StringIO

    return StringIO("".join(json.dumps(payload) + "\n" for payload in payloads))


def external_provider_with_runtime(
    tmp_path: Path,
    *,
    worker_body: str,
    oneshot_body: str = "",
    health_body: str = "",
    ocr_page_workers: int = 1,
) -> tuple[ExternalPaddleOCRProvider, Path]:
    runtime_dir = tmp_path / "runtime"
    runtime_dir.mkdir()
    log_path = tmp_path / "runtime.log"
    script_path = runtime_dir / "runtime.py"
    script_path.write_text(
        runtime_script(
            log_path=log_path,
            worker_body=worker_body,
            oneshot_body=oneshot_body,
            health_body=health_body,
        ),
        encoding="utf-8",
    )
    entrypoint = runtime_dir / "runtime.cmd"
    entrypoint.write_text(
        f'@echo off\n"{sys.executable}" "%~dp0runtime.py" %*\n',
        encoding="utf-8",
    )
    (runtime_dir / "runtime-manifest.json").write_text(
        json.dumps(
            {
                "version": "test",
                "target": "test",
                "entrypoint": entrypoint.name,
                "artifact": {
                    "file_name": "runtime.zip",
                    "sha256": "0",
                    "bytes": 0,
                    "url": None,
                },
            }
        ),
        encoding="utf-8",
    )
    provider = ExternalPaddleOCRProvider(
        Settings(
            data_dir=tmp_path,
            api_token="test-token",
            ocr_runtime_dir=runtime_dir,
            ocr_page_workers=ocr_page_workers,
            ocr_runtime_timeout_seconds=2,
        )
    )
    return provider, log_path


def runtime_health_body(*, available: bool) -> str:
    return f"""
if args.ocr_health:
    log('health')
    print(json.dumps({{
        'provider': 'paddle',
        'engine': 'paddleocr',
        'available': {available!r},
        'detail': 'test health',
        'python_version': '3.13.test',
        'paddle_version': '3.3.0',
        'paddleocr_version': '3.6.0',
        'selected_device': 'cpu',
        'cuda_available': False,
        'gpu_count': 0,
        'model_cache_dir': 'test-cache',
        'fallback_reason': None,
        'unavailable_reason': None if {available!r} else 'paddle_runtime_unhealthy',
    }}))
    raise SystemExit(0)
"""


def runtime_script(
    *,
    log_path: Path,
    worker_body: str,
    oneshot_body: str,
    health_body: str = "",
) -> str:
    return f"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

LOG_PATH = Path({str(log_path)!r})


def log(message: str) -> None:
    with LOG_PATH.open('a', encoding='utf-8') as file:
        file.write(message + '\\n')


parser = argparse.ArgumentParser()
parser.add_argument('--ocr-worker', action='store_true')
parser.add_argument('--ocr-health', action='store_true')
parser.add_argument('--ocr-page')
parser.add_argument('--page-number', type=int, default=1)
parser.add_argument('--device', default='auto')
args = parser.parse_args()
{health_body}
{worker_body}
{oneshot_body}
raise SystemExit(3)
"""
