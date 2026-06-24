from __future__ import annotations

from pathlib import Path
import subprocess

import pytest

from cert_prep_backend.domains.source_documents.adapters import external_paddle
from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.source_documents.adapters.external_paddle import (
    ExternalPaddleOCRProvider,
)
from cert_prep_backend.api.errors import ProviderUnavailableError

from ocr_test_support import external_provider_with_runtime, runtime_health_body


def test_external_paddle_provider_reuses_persistent_jsonl_worker(tmp_path: Path) -> None:
    provider, log_path = external_provider_with_runtime(
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


def test_external_paddle_worker_pool_close_clears_workers(tmp_path: Path) -> None:
    provider, _log_path = external_provider_with_runtime(
        tmp_path,
        worker_body="""
if args.ocr_worker:
    for line in sys.stdin:
        job = json.loads(line)
        print(json.dumps({
            'id': job.get('id'),
            'ok': True,
            'result': {
                'text': 'worker page',
                'extraction_method': 'paddle_ocr_cpu',
                'device': 'cpu',
                'fallback_reason': None,
                'duration_ms': 11,
            },
        }), flush=True)
    raise SystemExit(0)
""",
    )

    provider.prepare_for_document_ocr()
    assert provider._worker_pool is not None
    assert len(provider._worker_pool._workers) == 1

    provider.close()
    assert provider._worker_pool is None
    provider.close()


def test_external_paddle_windows_process_tree_cleanup_uses_taskkill(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = FakeProcess(pid=4321)
    calls: list[list[str]] = []

    def fake_run(command, **_kwargs):
        calls.append(command)
        process.returncode = 1
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(external_paddle.os, "name", "nt", raising=False)
    monkeypatch.setattr(external_paddle, "_taskkill_executable", lambda: "taskkill.exe")
    monkeypatch.setattr(external_paddle.subprocess, "run", fake_run)

    external_paddle._terminate_process_tree(process)

    assert calls == [["taskkill.exe", "/PID", "4321", "/T", "/F"]]
    assert process.terminate_calls == 0
    assert process.kill_calls == 0


def test_external_paddle_health_prewarms_only_primary_worker_then_expands(
    tmp_path: Path,
) -> None:
    provider, log_path = external_provider_with_runtime(
        tmp_path,
        ocr_page_workers=2,
        health_body=runtime_health_body(available=True),
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


class FakeProcess:
    def __init__(self, *, pid: int) -> None:
        self.pid = pid
        self.returncode: int | None = None
        self.terminate_calls = 0
        self.kill_calls = 0

    def poll(self) -> int | None:
        return self.returncode

    def wait(self, timeout: float | None = None) -> int:
        assert timeout is not None
        if self.returncode is None:
            raise subprocess.TimeoutExpired(["fake"], timeout)
        return self.returncode

    def terminate(self) -> None:
        self.terminate_calls += 1

    def kill(self) -> None:
        self.kill_calls += 1
        self.returncode = -9


def test_external_paddle_health_does_not_prewarm_unavailable_runtime(
    tmp_path: Path,
) -> None:
    provider, log_path = external_provider_with_runtime(
        tmp_path,
        health_body=runtime_health_body(available=False),
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
    provider, log_path = external_provider_with_runtime(
        tmp_path,
        health_body=runtime_health_body(available=True),
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
    provider, log_path = external_provider_with_runtime(
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
    provider, log_path = external_provider_with_runtime(
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
    provider, log_path = external_provider_with_runtime(
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
