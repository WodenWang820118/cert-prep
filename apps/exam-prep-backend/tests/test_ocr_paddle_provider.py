from __future__ import annotations

from types import SimpleNamespace

from exam_prep_backend.domains.source_documents.adapters.paddle import PaddleOCRProvider
from exam_prep_backend.domains.source_documents.adapters.paddle_text import extract_prediction_text


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
