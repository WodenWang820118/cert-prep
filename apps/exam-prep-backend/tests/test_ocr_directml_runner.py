from __future__ import annotations

from pathlib import Path
import sys


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from exam_prep_backend.domains.source_documents.adapters import directml  # noqa: E402
from exam_prep_backend.domains.source_documents.adapters.directml import (  # noqa: E402
    DirectMLRuntimeOCRProvider,
)


def test_directml_recognition_batch_width_expands_for_long_lines() -> None:
    short_crop = _FakeCrop(height=48, width=180)
    long_crop = _FakeCrop(height=32, width=900)

    width = directml._recognition_batch_width([short_crop, long_crop])

    assert width > 320
    assert width == 1350


def test_directml_recognition_batch_width_keeps_base_width_for_short_lines() -> None:
    width = directml._recognition_batch_width([_FakeCrop(height=48, width=120)])

    assert width == 320


def test_directml_ctc_decode_uses_blank_zero_and_removes_duplicates() -> None:
    output = _FakePrediction(
        indexes=[0, 1, 1, 0, 2, 2, 0, 3],
        probabilities=[0.0, 0.9, 0.8, 0.0, 0.95, 0.9, 0.0, 0.85],
    )

    decoded = directml._decode_ctc_output(output, ["A", "B", "C"])

    assert decoded["text"] == "ABC"
    assert decoded["confidence"] == (0.9 + 0.95 + 0.85) / 3


def test_directml_runtime_provider_health_requires_model_artifacts(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        directml,
        "_onnxruntime_state",
        lambda: (["DmlExecutionProvider", "CPUExecutionProvider"], "1.24.4", None),
    )
    provider = DirectMLRuntimeOCRProvider(model_dir=tmp_path, device_id=0)

    missing = provider.health()

    assert missing.available is False
    assert missing.unavailable_reason == "directml_model_artifacts_missing"

    for name in ("det_model.onnx", "rec_model.onnx", "rec_char_dict.txt", "pipeline.json"):
        (tmp_path / name).write_text("stub", encoding="utf-8")

    ready = provider.health()

    assert ready.available is True
    assert ready.unavailable_reason is None
    assert ready.selected_device == "amd_directml"


class _FakeCrop:
    def __init__(self, *, height: int, width: int) -> None:
        self.shape = (height, width, 3)


class _FakePrediction:
    def __init__(self, *, indexes: list[int], probabilities: list[float]) -> None:
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
