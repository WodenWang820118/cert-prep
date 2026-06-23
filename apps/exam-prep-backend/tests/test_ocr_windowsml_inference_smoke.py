from __future__ import annotations

from pathlib import Path
import sys
from typing import Any


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from ocr_windowsml_inference_smoke import (  # noqa: E402
    build_inference_smoke,
    classify_inference_status,
    default_output_path,
)


def test_inference_smoke_skips_until_session_ready() -> None:
    session_report = {"status": {"state": "ready_for_model", "session_ready": False}}

    smoke = build_inference_smoke(session_report, inference_runner=_unexpected_runner)
    status = classify_inference_status(session_report["status"], smoke)

    assert smoke["state"] == "skipped"
    assert smoke["reason"] == "ready_for_model"
    assert status["state"] == "ready_for_model"
    assert status["inference_ready"] is False


def test_inference_smoke_reports_recognition_model_ready() -> None:
    session_report = {"status": {"state": "session_ready", "session_ready": True, "blockers": []}}

    smoke = build_inference_smoke(session_report, inference_runner=_passed_runner)
    status = classify_inference_status(session_report["status"], smoke)

    assert smoke["state"] == "passed"
    assert status["state"] == "inference_ready"
    assert status["inference_ready"] is True
    assert status["recognition_model_ready"] is True
    assert status["full_page_ocr_ready"] is True
    assert status["blockers"] == []


def test_inference_smoke_blocks_on_text_mismatch() -> None:
    session_report = {"status": {"state": "session_ready", "session_ready": True, "blockers": []}}

    smoke = build_inference_smoke(session_report, inference_runner=_mismatch_runner)
    status = classify_inference_status(session_report["status"], smoke)

    assert smoke["state"] == "failed"
    assert status["state"] == "blocked"
    assert status["inference_ready"] is False
    assert "windowsml_inference_text_mismatch" in status["blockers"]


def test_windowsml_inference_default_output_is_benchmark_artifact() -> None:
    output = default_output_path()

    assert output.parent.name == ".benchmarks"
    assert output.name.startswith("ocr-windowsml-inference-smoke-")
    assert output.suffix == ".json"


def _passed_runner(_session_report: dict[str, Any]) -> dict[str, Any]:
    return {
        "state": "passed",
        "scope": "full_page_ocr",
        "device": "amd_windowsml",
        "expected_text": "TEST",
        "text": "TEST",
        "expected_text_matched": True,
        "full_page_ocr_ready": True,
    }


def _mismatch_runner(_session_report: dict[str, Any]) -> dict[str, Any]:
    return {
        "state": "failed",
        "reason": "windowsml_inference_text_mismatch",
        "scope": "full_page_ocr",
        "device": "amd_windowsml",
        "expected_text": "TEST",
        "text": "TEXT",
        "expected_text_matched": False,
        "full_page_ocr_ready": False,
    }


def _unexpected_runner(_session_report: dict[str, Any]) -> dict[str, Any]:
    raise AssertionError("inference runner should not be called")
