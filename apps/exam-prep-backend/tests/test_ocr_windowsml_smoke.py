from __future__ import annotations

from pathlib import Path
import json
import sys
from typing import Any


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from runtime.windowsml.ocr_windowsml_smoke import (  # noqa: E402
    summarize_provider_mix,
    build_session_smoke,
    classify_smoke_status,
    default_output_path,
)


REQUIRED_MODEL_FILES = (
    "det/inference.onnx",
    "det/inference.yml",
    "rec/inference.onnx",
    "rec/inference.yml",
    "rec/ppocr_keys_v1.txt",
    "pipeline.json",
)
SESSION_MODEL_FILES = ("det/inference.onnx", "rec/inference.onnx")


def test_session_smoke_skips_until_models_exist() -> None:
    probe = _probe_report(model_ready=False)

    smoke = build_session_smoke(probe, session_runner=_unexpected_session_runner)
    status = classify_smoke_status(probe["status"], smoke)

    assert smoke["state"] == "skipped"
    assert smoke["reason"] == "model_artifacts_missing"
    assert status["state"] == "ready_for_model"
    assert status["session_ready"] is False


def test_session_smoke_runs_required_models_when_ready(tmp_path: Path) -> None:
    probe = _probe_report(model_ready=True, model_dir=tmp_path)
    seen_models: list[str] = []

    def session_runner(model_files: dict[str, Path], device_id: int | None) -> dict[str, Any]:
        assert device_id == 0
        seen_models.extend(model_files)
        return {
            "state": "session_ready",
            "providers_requested": [
                ("DmlExecutionProvider", {"device_id": "0"}),
                "CPUExecutionProvider",
            ],
            "sessions": [{"model": name, "providers": ["DmlExecutionProvider"]} for name in model_files],
            "errors": [],
        }

    smoke = build_session_smoke(probe, session_runner=session_runner)
    status = classify_smoke_status(probe["status"], smoke)

    assert seen_models == list(SESSION_MODEL_FILES)
    assert smoke["state"] == "session_ready"
    assert status["state"] == "session_ready"
    assert status["blockers"] == []


def test_summarize_provider_mix_from_mock_profile(tmp_path: Path) -> None:
    profile_path = tmp_path / "profile.json"
    profile_path.write_text(
        json.dumps(
            [
                {"cat": "Kernel", "args": {"provider": "DmlExecutionProvider"}},
                {"cat": "Kernel", "args": {"provider": "CPUExecutionProvider"}},
                {"cat": "Kernel", "args": {"provider": "CPUExecutionProvider"}},
                {"cat": "Kernel", "args": {"provider": "DmlExecutionProvider"}},
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    mix = summarize_provider_mix(profile_path)

    assert mix["profile_file"] == str(profile_path)
    assert mix["providers_seen"] == ["DmlExecutionProvider", "CPUExecutionProvider"]
    assert mix["provider_counts"] == {
        "DmlExecutionProvider": 2,
        "CPUExecutionProvider": 2,
    }
    assert mix["mixed_execution_detected"] is True
    assert mix["profile_file"].endswith("profile.json")


def test_session_smoke_reports_session_failure(tmp_path: Path) -> None:
    probe = _probe_report(model_ready=True, model_dir=tmp_path)

    smoke = build_session_smoke(probe, session_runner=_failed_session_runner)
    status = classify_smoke_status(probe["status"], smoke)

    assert smoke["state"] == "session_failed"
    assert status["state"] == "session_failed"
    assert "windowsml_session_failed" in status["blockers"]


def test_session_smoke_blocks_when_windowsml_probe_is_blocked(tmp_path: Path) -> None:
    probe = _probe_report(model_ready=True, model_dir=tmp_path)
    probe["status"]["windowsml_provider_available"] = False
    probe["status"]["blockers"] = ["windowsml_provider_unavailable"]

    smoke = build_session_smoke(probe, session_runner=_unexpected_session_runner)
    status = classify_smoke_status(probe["status"], smoke)

    assert smoke["state"] == "skipped"
    assert smoke["reason"] == "windowsml_provider_unavailable"
    assert status["state"] == "blocked"
    assert status["blockers"] == ["windowsml_provider_unavailable"]


def test_windowsml_smoke_default_output_is_benchmark_artifact() -> None:
    output = default_output_path()

    assert output.parent.name == ".benchmarks"
    assert output.name.startswith("ocr-windowsml-smoke-")
    assert output.suffix == ".json"


def _probe_report(*, model_ready: bool, model_dir: Path | None = None) -> dict[str, Any]:
    artifacts = _model_artifacts(model_ready=model_ready, model_dir=model_dir)
    return {
        "status": {
            "state": "ready" if model_ready else "ready_for_model",
            "windowsml_provider_available": True,
            "amd_igpu_detected": True,
            "windowsml_device_id": 0,
            "model_artifacts_ready": model_ready,
            "blockers": [] if model_ready else ["model_artifacts_missing"],
        },
        "model_artifacts": artifacts,
    }


def _model_artifacts(*, model_ready: bool, model_dir: Path | None) -> dict[str, Any]:
    model_dir = model_dir or Path("missing-models")
    required = []
    for name in REQUIRED_MODEL_FILES:
        path = model_dir / name
        if model_ready:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("stub", encoding="utf-8")
        required.append(
            {
                "name": name,
                "path": str(path),
                "state": "present" if model_ready else "missing",
                "bytes": 4 if model_ready else 0,
            }
        )
    return {"ready": model_ready, "required": required}


def _failed_session_runner(
    _model_files: dict[str, Path],
    _device_id: int | None,
) -> dict[str, Any]:
    return {
        "state": "session_failed",
        "providers_requested": ["DmlExecutionProvider", "CPUExecutionProvider"],
        "sessions": [],
        "errors": [{"model": "det/inference.onnx", "error": "invalid onnx"}],
    }


def _unexpected_session_runner(
    _model_files: dict[str, Path],
    _device_id: int | None,
) -> dict[str, Any]:
    raise AssertionError("session runner should not be called")
