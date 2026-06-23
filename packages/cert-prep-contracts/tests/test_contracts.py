from __future__ import annotations

from cert_prep_contracts import (
    ModelPullProgress,
    OCRHealth,
    OCRPageResult,
    RuntimeInstallationStatus,
    RuntimeInstallProgress,
    RuntimeRequirementKind,
    RuntimeRequirementSnapshot,
)


def test_runtime_contracts_are_value_types() -> None:
    requirement = RuntimeRequirementSnapshot(
        kind=RuntimeRequirementKind.WINDOWSML_OCR,
        label="WindowsML OCR runtime",
        available=False,
        detail="runtime missing",
        unavailable_reason="windowsml_runtime_missing",
        bytes=100,
    )
    progress = RuntimeInstallProgress("downloading", completed=10, total=100)

    assert requirement.kind.value == "windowsml_ocr"
    assert requirement.bytes == progress.total
    assert RuntimeInstallationStatus.RUNNING.value == "running"


def test_llm_and_ocr_contracts_keep_shared_payload_shape() -> None:
    pull_progress = ModelPullProgress(status="pulling manifest", completed=1, total=2)
    health = OCRHealth(
        provider="windowsml",
        engine="paddleocr-3.7-onnxruntime-windowsml",
        available=True,
        detail="ready",
        python_version="3.13.5",
        paddle_version=None,
        paddleocr_version="3.7.0",
        selected_device="AMD iGPU",
        cuda_available=False,
        gpu_count=0,
        model_cache_dir="C:/cert-prep/models",
        fallback_reason=None,
    )
    page = OCRPageResult(
        text="sample",
        extraction_method="windowsml_ocr",
        device="AMD iGPU",
        fallback_reason=None,
        duration_ms=12,
    )

    assert pull_progress.completed == 1
    assert health.unavailable_reason is None
    assert page.text == "sample"

