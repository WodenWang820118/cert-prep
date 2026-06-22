from __future__ import annotations

from pathlib import Path
import sys
from typing import Any


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from ocr_directml_inference_smoke import (  # noqa: E402
    build_inference_smoke,
    classify_inference_status,
    decode_ctc_output,
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
    assert status["full_page_ocr_ready"] is False
    assert status["blockers"] == []


def test_inference_smoke_blocks_on_text_mismatch() -> None:
    session_report = {"status": {"state": "session_ready", "session_ready": True, "blockers": []}}

    smoke = build_inference_smoke(session_report, inference_runner=_mismatch_runner)
    status = classify_inference_status(session_report["status"], smoke)

    assert smoke["state"] == "failed"
    assert status["state"] == "blocked"
    assert status["inference_ready"] is False
    assert "directml_inference_text_mismatch" in status["blockers"]


def test_ctc_decode_uses_blank_zero_and_removes_duplicates() -> None:
    output = _FakeOutput(
        indexes=[0, 1, 1, 0, 2, 2, 0, 3],
        probabilities=[0.0, 0.9, 0.8, 0.0, 0.95, 0.9, 0.0, 0.85],
    )

    decoded = decode_ctc_output(output, ["A", "B", "C"])

    assert decoded["text"] == "ABC"
    assert decoded["confidence"] == (0.9 + 0.95 + 0.85) / 3


def test_directml_inference_default_output_is_benchmark_artifact() -> None:
    output = default_output_path()

    assert output.parent.name == ".benchmarks"
    assert output.name.startswith("ocr-directml-inference-smoke-")
    assert output.suffix == ".json"


def _passed_runner(_session_report: dict[str, Any]) -> dict[str, Any]:
    return {
        "state": "passed",
        "scope": "recognition_model_only",
        "device": "amd_directml",
        "expected_text": "TEST",
        "text": "TEST",
        "expected_text_matched": True,
        "full_page_ocr_ready": False,
    }


def _mismatch_runner(_session_report: dict[str, Any]) -> dict[str, Any]:
    return {
        "state": "failed",
        "reason": "directml_inference_text_mismatch",
        "scope": "recognition_model_only",
        "device": "amd_directml",
        "expected_text": "TEST",
        "text": "TEXT",
        "expected_text_matched": False,
        "full_page_ocr_ready": False,
    }


def _unexpected_runner(_session_report: dict[str, Any]) -> dict[str, Any]:
    raise AssertionError("inference runner should not be called")


class _FakeOutput:
    def __init__(self, *, indexes: list[int], probabilities: list[float]) -> None:
        self._indexes = indexes
        self._probabilities = probabilities

    def __getitem__(self, index: int) -> _FakePredictions:
        assert index == 0
        return _FakePredictions(self._indexes, self._probabilities)


class _FakePredictions:
    def __init__(self, indexes: list[int], probabilities: list[float]) -> None:
        self._indexes = indexes
        self._probabilities = probabilities

    def argmax(self, *, axis: int) -> _FakeVector:
        assert axis == 1
        return _FakeVector(self._indexes)

    def max(self, *, axis: int) -> _FakeVector:
        assert axis == 1
        return _FakeVector(self._probabilities)


class _FakeVector:
    def __init__(self, values: list[int] | list[float]) -> None:
        self._values = values

    def tolist(self) -> list[int] | list[float]:
        return self._values
