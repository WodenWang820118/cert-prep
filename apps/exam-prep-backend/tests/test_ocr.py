from __future__ import annotations

import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

from exam_prep_backend.config import Settings
from exam_prep_backend.domains.source_documents.adapters.external_paddle import (
    ExternalPaddleOCRProvider,
)
from exam_prep_backend.domains.source_documents.adapters.paddle import PaddleOCRProvider
from exam_prep_backend.domains.source_documents.adapters.paddle_text import extract_prediction_text
from exam_prep_backend.domains.source_documents.ocr import OCRPageResult
from exam_prep_backend.errors import ProviderUnavailableError
from exam_prep_backend.ocr_runtime import _run_worker


def test_prediction_text_extracts_rec_texts_without_duplicates() -> None:
    predictions = [
        {"res": {"rec_texts": [" JLPT question 1 ", "JLPT question 1", "A correct"]}},
        {"text": "B wrong"},
    ]

    assert extract_prediction_text(predictions) == "JLPT question 1\nA correct\nB wrong"


def test_prediction_text_extracts_from_generators() -> None:
    predictions = (item for item in [{"rec_texts": ["OCR TEST"]}])

    assert extract_prediction_text(predictions) == "OCR TEST"


def test_paddle_health_reports_cpu_fallback_when_cuda_unavailable(monkeypatch) -> None:
    import exam_prep_backend.domains.source_documents.adapters.paddle as paddle_module

    monkeypatch.setattr(
        paddle_module,
        "import_paddle_stack",
        lambda: (SimpleNamespace(), lambda **_kwargs: object(), None),
    )
    monkeypatch.setattr(paddle_module, "cuda_available", lambda _paddle: False)
    monkeypatch.setattr(paddle_module, "gpu_count", lambda _paddle: 0)
    monkeypatch.setattr(
        paddle_module,
        "package_versions",
        lambda: {"paddle": "3.3.0", "paddleocr": "3.3.0", "paddlex": "3.4.0"},
    )

    health = PaddleOCRProvider(device="auto").health()

    assert health.available is True
    assert health.selected_device == "cpu"
    assert health.fallback_reason == "cuda_unavailable"


def test_paddle_gpu_failure_falls_back_to_cpu(monkeypatch) -> None:
    import exam_prep_backend.domains.source_documents.adapters.paddle as paddle_module

    created_devices: list[str] = []

    class FakePipeline:
        def __init__(self, device: str) -> None:
            self.device = device

        def predict(self, *_args, **_kwargs):
            if self.device == "gpu:0":
                raise RuntimeError("simulated GPU inference failure")
            return [{"rec_texts": ["JLPT question 1", "A correct", "B wrong"]}]

    def create_pipeline(**kwargs):
        device = kwargs["device"]
        created_devices.append(device)
        return FakePipeline(device)

    monkeypatch.setattr(
        paddle_module,
        "import_paddle_stack",
        lambda: (SimpleNamespace(), create_pipeline, None),
    )
    monkeypatch.setattr(paddle_module, "cuda_available", lambda _paddle: True)
    monkeypatch.setattr(paddle_module, "gpu_count", lambda _paddle: 1)

    result = PaddleOCRProvider(device="auto").extract_page_text(b"\x89PNG test", 1)

    assert created_devices == ["gpu:0", "cpu"]
    assert result.device == "cpu"
    assert result.extraction_method == "paddle_ocr_cpu_fallback"
    assert result.fallback_reason == "gpu:0 failed: simulated GPU inference failure"
    assert result.text == "JLPT question 1\nA correct\nB wrong"


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
        _jsonl(
            {"id": "job-1", "image_path": str(image_1), "page_number": 1},
            {"id": "job-2", "image_path": str(image_2), "page_number": 2},
        ),
    )

    provider = _RuntimeWorkerFakeProvider()
    _run_worker(provider)

    lines = capsys.readouterr().out.splitlines()
    assert [json.loads(line)["id"] for line in lines] == ["job-1", "job-2"]
    assert [json.loads(line)["result"]["text"] for line in lines] == [
        "worker page 1",
        "worker page 2",
    ]
    assert provider.page_numbers == [1, 2]


def test_external_paddle_provider_reuses_persistent_jsonl_worker(tmp_path: Path) -> None:
    provider, log_path = _external_provider_with_runtime(
        tmp_path,
        worker_body="""
if args.ocr_worker:
    log('worker_start')
    for line in sys.stdin:
        job = json.loads(line)
        log(f"worker_job:{job['page_number']}")
        print(json.dumps({
            'id': job.get('id'),
            'ok': True,
            'result': {
                'text': f"worker page {job['page_number']}",
                'extraction_method': 'paddle_ocr_cpu',
                'device': 'cpu',
                'fallback_reason': None,
                'duration_ms': 11,
            },
        }), flush=True)
    raise SystemExit(0)
""",
    )

    try:
        assert provider.extract_page_text(b"\x89PNG one", 1).text == "worker page 1"
        assert provider.extract_page_text(b"\x89PNG two", 2).text == "worker page 2"
    finally:
        provider._reset_worker_pool()

    assert log_path.read_text(encoding="utf-8").splitlines() == [
        "worker_start",
        "worker_job:1",
        "worker_job:2",
    ]


def test_external_paddle_health_prewarms_only_primary_worker_then_expands(
    tmp_path: Path,
) -> None:
    provider, log_path = _external_provider_with_runtime(
        tmp_path,
        ocr_page_workers=2,
        health_body=_runtime_health_body(available=True),
        worker_body="""
if args.ocr_worker:
    log('worker_start')
    for line in sys.stdin:
        job = json.loads(line)
        log(f"worker_job:{job['page_number']}")
        print(json.dumps({
            'id': job.get('id'),
            'ok': True,
            'result': {
                'text': f"worker page {job['page_number']}",
                'extraction_method': 'paddle_ocr_cpu',
                'device': 'cpu',
                'fallback_reason': None,
                'duration_ms': 11,
            },
        }), flush=True)
    raise SystemExit(0)
""",
    )

    try:
        health = provider.health()
        assert health.available is True
        assert log_path.read_text(encoding="utf-8").splitlines() == [
            "health",
            "worker_start",
            "worker_job:1",
        ]

        assert provider.extract_page_text(b"\x89PNG seven", 7).text == "worker page 7"
        assert provider.extract_page_text(b"\x89PNG eight", 8).text == "worker page 8"
    finally:
        provider._reset_worker_pool()

    assert log_path.read_text(encoding="utf-8").splitlines() == [
        "health",
        "worker_start",
        "worker_job:1",
        "worker_job:7",
        "worker_start",
        "worker_job:8",
    ]


def test_external_paddle_health_does_not_prewarm_unavailable_runtime(
    tmp_path: Path,
) -> None:
    provider, log_path = _external_provider_with_runtime(
        tmp_path,
        health_body=_runtime_health_body(available=False),
        worker_body="""
if args.ocr_worker:
    log('unexpected_worker_start')
    raise SystemExit(9)
""",
    )

    health = provider.health()

    assert health.available is False
    assert provider._worker_pool is None
    assert log_path.read_text(encoding="utf-8").splitlines() == ["health"]


def test_external_paddle_health_resets_pool_when_prewarm_worker_fails(
    tmp_path: Path,
) -> None:
    provider, log_path = _external_provider_with_runtime(
        tmp_path,
        health_body=_runtime_health_body(available=True),
        worker_body="""
if args.ocr_worker:
    log('worker_exit')
    raise SystemExit(7)
""",
    )

    health = provider.health()

    assert health.available is True
    assert provider._worker_pool is None
    assert log_path.read_text(encoding="utf-8").splitlines() == [
        "health",
        "worker_exit",
    ]


def test_external_paddle_prepare_for_document_ocr_prewarms_primary_worker(
    tmp_path: Path,
) -> None:
    provider, log_path = _external_provider_with_runtime(
        tmp_path,
        worker_body="""
if args.ocr_worker:
    log('worker_start')
    for line in sys.stdin:
        job = json.loads(line)
        log(f"worker_job:{job['page_number']}")
        print(json.dumps({
            'id': job.get('id'),
            'ok': True,
            'result': {
                'text': f"worker page {job['page_number']}",
                'extraction_method': 'paddle_ocr_cpu',
                'device': 'cpu',
                'fallback_reason': None,
                'duration_ms': 11,
            },
        }), flush=True)
    raise SystemExit(0)
""",
    )

    try:
        provider.prepare_for_document_ocr()
    finally:
        provider._reset_worker_pool()

    assert log_path.read_text(encoding="utf-8").splitlines() == [
        "worker_start",
        "worker_job:1",
    ]


def test_external_paddle_prepare_for_document_ocr_reports_missing_runtime(
    tmp_path: Path,
) -> None:
    provider = ExternalPaddleOCRProvider(
        Settings(
            data_dir=tmp_path,
            api_token="test-token",
            ocr_runtime_dir=tmp_path / "missing-runtime",
        )
    )

    with pytest.raises(ProviderUnavailableError, match="PaddleOCR runtime is not installed."):
        provider.prepare_for_document_ocr()


def test_external_paddle_provider_falls_back_to_oneshot_when_worker_exits(
    tmp_path: Path,
) -> None:
    provider, log_path = _external_provider_with_runtime(
        tmp_path,
        worker_body="""
if args.ocr_worker:
    log('worker_exit')
    raise SystemExit(7)
""",
        oneshot_body="""
if args.ocr_page:
    log(f"oneshot:{args.page_number}")
    print(json.dumps({
        'text': f"oneshot page {args.page_number}",
        'extraction_method': 'paddle_ocr_cpu',
        'device': 'cpu',
        'fallback_reason': None,
        'duration_ms': 9,
    }))
    raise SystemExit(0)
""",
    )

    assert provider.extract_page_text(b"\x89PNG page", 5).text == "oneshot page 5"
    assert log_path.read_text(encoding="utf-8").splitlines() == [
        "worker_exit",
        "oneshot:5",
    ]


def test_external_paddle_provider_reports_clean_failure_when_worker_and_oneshot_fail(
    tmp_path: Path,
) -> None:
    provider, log_path = _external_provider_with_runtime(
        tmp_path,
        worker_body="""
if args.ocr_worker:
    log('worker_exit')
    raise SystemExit(7)
""",
        oneshot_body="""
if args.ocr_page:
    log(f"oneshot_fail:{args.page_number}")
    print('one-shot failed', file=sys.stderr)
    raise SystemExit(9)
""",
    )

    with pytest.raises(ProviderUnavailableError, match="one-shot failed"):
        provider.extract_page_text(b"\x89PNG page", 6)

    assert log_path.read_text(encoding="utf-8").splitlines() == [
        "worker_exit",
        "oneshot_fail:6",
    ]


class _RuntimeWorkerFakeProvider:
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


def _jsonl(*payloads: dict) -> object:
    from io import StringIO

    return StringIO("".join(json.dumps(payload) + "\n" for payload in payloads))


def _external_provider_with_runtime(
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
        _runtime_script(
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


def _runtime_health_body(*, available: bool) -> str:
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


def _runtime_script(
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
