from __future__ import annotations

from pathlib import Path


from cert_prep_ocr_windowsml.tools.windowsml.ocr_windowsml_probe import (
    classify_windowsml_status,
    default_output_path,
    inspect_model_artifacts,
    select_amd_dxgi_adapter,
)


WINDOWS_VIDEO_CONTROLLERS = [
    {"Name": "AMD Radeon(TM) 880M Graphics"},
    {"Name": "NVIDIA GeForce RTX 4060 Laptop GPU"},
]
DXGI_ADAPTERS = [
    {
        "adapter_index": 0,
        "description": "AMD Radeon(TM) 880M Graphics",
        "adapter_kind": "amd_igpu",
    },
    {
        "adapter_index": 1,
        "description": "NVIDIA GeForce RTX 4060 Laptop GPU",
        "adapter_kind": "nvidia_dgpu",
    },
]
REQUIRED_MODEL_FILES = (
    "det/inference.onnx",
    "det/inference.yml",
    "rec/inference.onnx",
    "rec/inference.yml",
    "rec/ppocr_keys_v1.txt",
    "pipeline.json",
)


def test_windowsml_probe_blocks_when_provider_is_missing(tmp_path: Path) -> None:
    artifacts = inspect_model_artifacts(tmp_path / "models")

    status = classify_windowsml_status(
        providers=["CPUExecutionProvider"],
        import_error=None,
        model_artifacts=artifacts,
        windows_video_controllers=WINDOWS_VIDEO_CONTROLLERS,
        dxgi_adapters=DXGI_ADAPTERS,
    )

    assert status["state"] == "blocked"
    assert status["windowsml_provider_available"] is False
    assert "windowsml_provider_unavailable" in status["blockers"]
    assert "model_artifacts_missing" in status["blockers"]


def test_windowsml_probe_reports_ready_for_model_when_windowsml_exists(tmp_path: Path) -> None:
    artifacts = inspect_model_artifacts(tmp_path / "models")

    status = classify_windowsml_status(
        providers=["DmlExecutionProvider", "CPUExecutionProvider"],
        import_error=None,
        model_artifacts=artifacts,
        windows_video_controllers=WINDOWS_VIDEO_CONTROLLERS,
        dxgi_adapters=DXGI_ADAPTERS,
    )

    assert status["state"] == "ready_for_model"
    assert status["windowsml_provider_available"] is True
    assert status["amd_igpu_detected"] is True
    assert status["nvidia_dgpu_detected"] is True
    assert status["windowsml_device_id"] == 0
    assert status["model_artifacts_ready"] is False
    assert status["blockers"] == ["model_artifacts_missing"]


def test_windowsml_probe_reports_ready_when_required_artifacts_exist(tmp_path: Path) -> None:
    model_dir = tmp_path / "models"
    model_dir.mkdir()
    for file_name in REQUIRED_MODEL_FILES:
        _write_model_file(model_dir, file_name)

    artifacts = inspect_model_artifacts(model_dir)
    status = classify_windowsml_status(
        providers=["DmlExecutionProvider", "CPUExecutionProvider"],
        import_error=None,
        model_artifacts=artifacts,
        windows_video_controllers=WINDOWS_VIDEO_CONTROLLERS,
        dxgi_adapters=DXGI_ADAPTERS,
    )

    assert artifacts["ready"] is True
    assert artifacts["missing_required"] == []
    assert status["state"] == "ready"
    assert status["blockers"] == []


def test_windowsml_probe_blocks_without_amd_adapter(tmp_path: Path) -> None:
    model_dir = tmp_path / "models"
    model_dir.mkdir()
    for file_name in REQUIRED_MODEL_FILES:
        _write_model_file(model_dir, file_name)

    artifacts = inspect_model_artifacts(model_dir)
    status = classify_windowsml_status(
        providers=["DmlExecutionProvider", "CPUExecutionProvider"],
        import_error=None,
        model_artifacts=artifacts,
        windows_video_controllers=[{"Name": "NVIDIA GeForce RTX 4060 Laptop GPU"}],
        dxgi_adapters=[DXGI_ADAPTERS[1]],
    )

    assert status["state"] == "blocked"
    assert status["windowsml_provider_available"] is True
    assert status["amd_igpu_detected"] is False
    assert status["model_artifacts_ready"] is True
    assert status["blockers"] == ["amd_igpu_not_detected"]


def test_windowsml_probe_rejects_empty_required_model_file(tmp_path: Path) -> None:
    model_dir = tmp_path / "models"
    model_dir.mkdir()
    (model_dir / "det").mkdir(parents=True)
    (model_dir / "rec").mkdir(parents=True)
    (model_dir / "det" / "inference.onnx").write_text("stub", encoding="utf-8")
    (model_dir / "det" / "inference.yml").write_text("stub", encoding="utf-8")
    (model_dir / "rec" / "inference.onnx").write_bytes(b"")
    (model_dir / "rec" / "inference.yml").write_text("stub", encoding="utf-8")
    (model_dir / "rec" / "ppocr_keys_v1.txt").write_text("stub", encoding="utf-8")
    (model_dir / "pipeline.json").write_text("{}", encoding="utf-8")

    artifacts = inspect_model_artifacts(model_dir)

    assert artifacts["ready"] is False
    assert artifacts["missing_required"] == ["rec/inference.onnx"]


def test_windowsml_probe_requires_pipeline_contract(tmp_path: Path) -> None:
    model_dir = tmp_path / "models"
    model_dir.mkdir()
    for file_name in REQUIRED_MODEL_FILES:
        if file_name == "pipeline.json":
            continue
        _write_model_file(model_dir, file_name)

    artifacts = inspect_model_artifacts(model_dir)

    assert artifacts["ready"] is False
    assert artifacts["missing_required"] == ["pipeline.json"]


def test_windowsml_probe_selects_amd_dxgi_adapter_index() -> None:
    selected = select_amd_dxgi_adapter(DXGI_ADAPTERS)

    assert selected is not None
    assert selected["adapter_index"] == 0


def test_windowsml_probe_selects_amd_when_nvidia_is_first_adapter() -> None:
    selected = select_amd_dxgi_adapter([DXGI_ADAPTERS[1], DXGI_ADAPTERS[0] | {"adapter_index": 1}])

    assert selected is not None
    assert selected["adapter_index"] == 1


def test_windowsml_probe_default_output_is_benchmark_artifact() -> None:
    output = default_output_path()

    assert output.parent.name == ".benchmarks"
    assert output.name.startswith("ocr-windowsml-probe-")
    assert output.suffix == ".json"


def _write_model_file(model_dir: Path, file_name: str) -> None:
    path = model_dir / file_name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("stub", encoding="utf-8")
