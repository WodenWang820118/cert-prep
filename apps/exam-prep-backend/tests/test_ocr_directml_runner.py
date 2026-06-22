from __future__ import annotations

from pathlib import Path
import sys


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from exam_prep_backend.domains.source_documents.adapters import directml_device  # noqa: E402
from exam_prep_backend.domains.source_documents.adapters import directml  # noqa: E402
from exam_prep_backend.domains.source_documents.adapters.directml import (  # noqa: E402
    DirectMLRuntimeOCRProvider,
)


def test_directml_runtime_provider_health_requires_model_artifacts(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        directml,
        "_onnxruntime_state",
        lambda: (["DmlExecutionProvider", "CPUExecutionProvider"], "1.24.4", None),
    )
    monkeypatch.setattr(directml, "_paddleocr_state", lambda: ("3.7.0", None))
    provider = DirectMLRuntimeOCRProvider(
        model_dir=tmp_path,
        device_id=0,
    )

    missing = provider.health()

    assert missing.available is False
    assert missing.unavailable_reason == "directml_model_artifacts_missing"

    _write_paddleocr37_model_files(tmp_path)

    ready = provider.health()

    assert ready.available is True
    assert ready.unavailable_reason is None
    assert ready.selected_device == "amd_directml:0"
    assert ready.fallback_reason is None


def test_directml_runtime_provider_health_resolves_auto_amd_igpu(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        directml,
        "_onnxruntime_state",
        lambda: (["DmlExecutionProvider", "CPUExecutionProvider"], "1.24.6", None),
    )
    monkeypatch.setattr(directml, "_paddleocr_state", lambda: ("3.7.0", None))
    monkeypatch.setattr(directml, "resolve_directml_device_id", lambda _device_id: 1)
    _write_paddleocr37_model_files(tmp_path)
    provider = DirectMLRuntimeOCRProvider(model_dir=tmp_path)

    health = provider.health()

    assert health.available is True
    assert health.selected_device == "amd_directml:1"
    assert health.fallback_reason is None


def test_directml_auto_device_selects_amd_after_nvidia(monkeypatch) -> None:
    monkeypatch.setattr(
        directml_device,
        "dxgi_adapter_snapshot",
        lambda: [
            {
                "adapter_index": 0,
                "description": "NVIDIA GeForce RTX 4060 Laptop GPU",
                "adapter_kind": "nvidia_dgpu",
            },
            {
                "adapter_index": 1,
                "description": "AMD Radeon(TM) 880M Graphics",
                "adapter_kind": "amd_igpu",
            },
        ],
    )

    assert directml_device.resolve_directml_device_id(-1) == 1


def test_directml_provider_options_resolve_auto_device(monkeypatch) -> None:
    monkeypatch.setattr(directml, "resolve_directml_device_id", lambda _device_id: 1)

    providers = directml._directml_providers(-1)

    assert providers == [
        ("DmlExecutionProvider", {"device_id": "1"}),
        "CPUExecutionProvider",
    ]


def _write_paddleocr37_model_files(model_dir: Path) -> None:
    for name in directml.PADDLEOCR37_REQUIRED_MODEL_FILES:
        path = model_dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("stub", encoding="utf-8")
