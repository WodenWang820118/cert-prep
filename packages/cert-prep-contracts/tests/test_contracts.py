from __future__ import annotations

from cert_prep_contracts import (
    MachineCpuSnapshot,
    MachineInventorySnapshot,
    MachineRamSnapshot,
    MachineStorageSnapshot,
    ModelPullProgress,
    OCRHealth,
    OCRPageResult,
    OllamaModelProfile,
    OllamaProfileSelection,
    OllamaProfileSupportStatus,
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


def test_machine_inventory_and_ollama_profiles_are_pure_value_types() -> None:
    inventory = MachineInventorySnapshot(
        platform="Windows",
        platform_version="11",
        architecture="AMD64",
        cpu=MachineCpuSnapshot(architecture="AMD64", logical_cores=12),
        ram=MachineRamSnapshot(total_bytes=16 * 1024 * 1024 * 1024),
        storage=MachineStorageSnapshot(
            path="C:/Users/User/AppData/Local/cert-prep-backend",
            free_bytes=128 * 1024 * 1024 * 1024,
        ),
    )
    profile = OllamaModelProfile(
        profile_id="qwen3.5-4b-study-8k",
        display_name="Qwen 3.5 4B Study 8K",
        base_model="qwen3.5:4b",
        local_model="cert-prep-qwen3.5-4b-study-8k",
        context_window=8192,
        system_prompt="Create grounded study material.",
        parameters=(("temperature", 0),),
        min_free_disk_bytes=8 * 1024 * 1024 * 1024,
    )
    selection = OllamaProfileSelection(
        profile_id=profile.profile_id,
        selected_profile=profile,
        support_status=OllamaProfileSupportStatus.SUPPORTED,
        reason="default profile selected",
        inventory=inventory,
    )

    assert selection.selected_profile.local_model == "cert-prep-qwen3.5-4b-study-8k"
    assert selection.support_status.value == "supported"
    assert selection.inventory is inventory
