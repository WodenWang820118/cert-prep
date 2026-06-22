from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
import shutil
import subprocess
import sys
from typing import Any

from .constants import (
    BACKEND_ROOT,
    CONVERTERS,
    CONVERSION_TIMEOUT_SECONDS,
    DOCKER_PADDLEX_IMAGE,
)
from .model_types import ConversionResult, ConverterRunner, SourceArtifact


def normalize_converter(value: str) -> str:
    normalized = value.strip().lower()
    if normalized not in CONVERTERS:
        raise ValueError(f"unsupported converter: {value}")
    return normalized


def converter_runner_for(converter: str) -> ConverterRunner:
    if converter == "docker":
        return run_docker_paddlex_conversion
    return run_paddlex_conversion


def prepare_onnx_artifacts(
    *,
    artifacts: Sequence[SourceArtifact],
    sources_dir: Path,
    model_dir: Path,
    allow_conversion: bool,
    converter: str,
    force_conversion: bool,
    converter_runner: ConverterRunner,
) -> list[dict[str, Any]]:
    extracted_dir = sources_dir / "extracted"
    conversion_root = sources_dir / ("converted-docker" if converter == "docker" else "converted")
    reports: list[dict[str, Any]] = []
    for artifact in artifacts:
        target = model_dir / artifact.target_onnx_name
        if target.is_file() and target.stat().st_size > 0 and not force_conversion:
            reports.append(
                {
                    "kind": artifact.kind,
                    "state": "ready",
                    "target": str(target),
                    "bytes": target.stat().st_size,
                    "source": "existing",
                    "converter": converter,
                }
            )
            continue
        if not allow_conversion:
            reports.append(
                {
                    "kind": artifact.kind,
                    "state": "skipped",
                    "target": str(target),
                    "blocker": "conversion_skipped",
                    "converter": converter,
                }
            )
            continue

        source_dir = extracted_dir / artifact.archive_root
        if not source_dir.is_dir():
            reports.append(
                {
                    "kind": artifact.kind,
                    "state": "skipped",
                    "target": str(target),
                    "blocker": "source_dir_missing",
                    "converter": converter,
                }
            )
            continue

        conversion_dir = conversion_root / artifact.archive_root
        conversion_dir.mkdir(parents=True, exist_ok=True)
        conversion = converter_runner(artifact, source_dir, conversion_dir)
        report = conversion_report(artifact, target, conversion)
        report["converter"] = converter
        if conversion.state == "ready" and conversion.output_model and conversion.output_model.is_file():
            shutil.copy2(conversion.output_model, target)
            report["state"] = "ready"
            report["bytes"] = target.stat().st_size
        reports.append(report)
    return reports


def conversion_report(
    artifact: SourceArtifact,
    target: Path,
    conversion: ConversionResult,
) -> dict[str, Any]:
    return {
        "kind": artifact.kind,
        "state": conversion.state,
        "target": str(target),
        "blocker": conversion.blocker,
        "command": conversion.command,
        "stdout": conversion.stdout,
        "stderr": conversion.stderr,
        "output_model": str(conversion.output_model) if conversion.output_model else None,
        "bytes": target.stat().st_size if target.is_file() else 0,
    }


def run_paddlex_conversion(
    artifact: SourceArtifact,
    source_dir: Path,
    output_dir: Path,
) -> ConversionResult:
    command = [
        sys.executable,
        "-m",
        "paddlex",
        "--paddle2onnx",
        "--paddle_model_dir",
        str(source_dir),
        "--onnx_model_dir",
        str(output_dir),
        "--opset_version",
        "14",
    ]
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=CONVERSION_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        return ConversionResult(
            state="failed",
            command=command,
            stdout=str(exc.stdout or ""),
            stderr=str(exc.stderr or ""),
            blocker="conversion_timeout",
        )

    output_model = output_dir / "inference.onnx"
    stdout = result.stdout.strip()
    stderr = result.stderr.strip()
    combined = f"{stdout}\n{stderr}"
    if result.returncode == 0 and output_model.is_file() and output_model.stat().st_size > 0:
        return ConversionResult(
            state="ready",
            command=command,
            stdout=stdout,
            stderr=stderr,
            output_model=output_model,
        )
    return ConversionResult(
        state="failed",
        command=command,
        stdout=stdout,
        stderr=stderr,
        blocker=classify_conversion_blocker(combined),
    )


def run_docker_paddlex_conversion(
    artifact: SourceArtifact,
    source_dir: Path,
    output_dir: Path,
) -> ConversionResult:
    docker_exe = shutil.which("docker")
    if docker_exe is None:
        return ConversionResult(
            state="failed",
            command=["docker"],
            stdout="",
            stderr="Docker CLI was not found on PATH.",
            blocker="docker_cli_unavailable",
        )

    try:
        docker_source_dir = docker_work_path(source_dir)
        docker_output_dir = docker_work_path(output_dir)
    except ValueError as exc:
        return ConversionResult(
            state="failed",
            command=[docker_exe],
            stdout="",
            stderr=str(exc),
            blocker="docker_path_outside_backend_root",
        )

    output_dir.mkdir(parents=True, exist_ok=True)
    command = [
        docker_exe,
        "run",
        "--rm",
        "-v",
        f"{BACKEND_ROOT.resolve()}:/work",
        "-w",
        "/work",
        "--shm-size=8g",
        "-e",
        "DISABLE_MODEL_SOURCE_CHECK=True",
        DOCKER_PADDLEX_IMAGE,
        "paddlex",
        "--paddle2onnx",
        "--paddle_model_dir",
        docker_source_dir,
        "--onnx_model_dir",
        docker_output_dir,
        "--opset_version",
        "14",
    ]
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=CONVERSION_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        return ConversionResult(
            state="failed",
            command=command,
            stdout=str(exc.stdout or ""),
            stderr=str(exc.stderr or ""),
            blocker="conversion_timeout",
        )

    output_model = output_dir / "inference.onnx"
    stdout = result.stdout.strip()
    stderr = result.stderr.strip()
    combined = f"{stdout}\n{stderr}"
    if result.returncode == 0 and output_model.is_file() and output_model.stat().st_size > 0:
        return ConversionResult(
            state="ready",
            command=command,
            stdout=stdout,
            stderr=stderr,
            output_model=output_model,
        )
    return ConversionResult(
        state="failed",
        command=command,
        stdout=stdout,
        stderr=stderr,
        blocker=classify_conversion_blocker(combined),
    )


def docker_work_path(path: Path) -> str:
    backend_root = BACKEND_ROOT.resolve()
    resolved = path.resolve()
    try:
        relative = resolved.relative_to(backend_root)
    except ValueError as exc:
        raise ValueError(f"Docker conversion path must be under {backend_root}: {resolved}") from exc
    return f"/work/{relative.as_posix()}"


def classify_conversion_blocker(output: str) -> str:
    normalized = output.lower()
    if "docker" in normalized and "daemon" in normalized:
        return "docker_daemon_unavailable"
    if "install the paddle2onnx plugin" in normalized:
        return "conversion_tool_unavailable"
    if "no module named" in normalized and "paddle2onnx" in normalized:
        return "conversion_tool_unavailable"
    if "paddle2onnx_cpp2py_export" in normalized or "dll load failed" in normalized:
        return "conversion_tool_unavailable"
    return "conversion_failed"
