from __future__ import annotations

import argparse
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
import hashlib
import importlib.util
import json
import os
import platform
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
from typing import Any
from urllib.request import urlopen

import yaml


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

SCRIPT_DIR = Path(__file__).resolve().parent
BACKEND_ROOT = SCRIPT_DIR.parents[0]
DEFAULT_OUTPUT_DIR = BACKEND_ROOT / ".benchmarks"
DEFAULT_SOURCES_DIR = DEFAULT_OUTPUT_DIR / "ocr-directml-sources"
DEFAULT_MODEL_DIR = DEFAULT_OUTPUT_DIR / "ocr-directml-models"
CONVERSION_TIMEOUT_SECONDS = 600.0
DOCKER_PADDLEX_IMAGE = (
    "ccr-2vdh3abv-pub.cnc.bj.baidubce.com/paddlex/"
    "paddlex:paddlex3.3.11-paddlepaddle3.2.0-cpu"
)
CONVERTERS = ("local", "docker")


@dataclass(frozen=True)
class SourceArtifact:
    kind: str
    model_name: str
    url: str
    filename: str
    sha256: str
    byte_size: int
    archive_root: str
    target_onnx_name: str


@dataclass(frozen=True)
class ConversionResult:
    state: str
    command: list[str]
    stdout: str
    stderr: str
    output_model: Path | None = None
    blocker: str | None = None


DownloadFn = Callable[[str, Path], None]
ConverterRunner = Callable[[SourceArtifact, Path, Path], ConversionResult]


SOURCE_ARTIFACTS = (
    SourceArtifact(
        kind="det",
        model_name="PP-OCRv5_mobile_det",
        url=(
            "https://paddle-model-ecology.bj.bcebos.com/paddlex/"
            "official_inference_model/paddle3.0.0/PP-OCRv5_mobile_det_infer.tar"
        ),
        filename="PP-OCRv5_mobile_det_infer.tar",
        sha256="50446e5d01ac2a73d5319c89513281f6578414c888c602f9af13f93feefffc58",
        byte_size=4_935_680,
        archive_root="PP-OCRv5_mobile_det_infer",
        target_onnx_name="det_model.onnx",
    ),
    SourceArtifact(
        kind="rec",
        model_name="PP-OCRv5_mobile_rec",
        url=(
            "https://paddle-model-ecology.bj.bcebos.com/paddlex/"
            "official_inference_model/paddle3.0.0/PP-OCRv5_mobile_rec_infer.tar"
        ),
        filename="PP-OCRv5_mobile_rec_infer.tar",
        sha256="566b9512b34e34a9f0db54d87b51fa5a0b9ed2cf1ab7e49728cc0b8b5a64f414",
        byte_size=16_834_560,
        archive_root="PP-OCRv5_mobile_rec_infer",
        target_onnx_name="rec_model.onnx",
    ),
)


def default_output_path() -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return DEFAULT_OUTPUT_DIR / f"ocr-directml-prepare-models-{stamp}.json"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=default_output_path())
    parser.add_argument("--sources-dir", type=Path, default=DEFAULT_SOURCES_DIR)
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    parser.add_argument(
        "--skip-download",
        action="store_true",
        help="Only use already cached official Paddle model archives.",
    )
    parser.add_argument(
        "--skip-conversion",
        action="store_true",
        help="Prepare sources and metadata but do not invoke Paddle2ONNX.",
    )
    parser.add_argument(
        "--converter",
        choices=CONVERTERS,
        default=os.environ.get("EXAM_PREP_DIRECTML_CONVERTER", "local"),
        help="Paddle2ONNX execution environment for missing or forced ONNX conversion.",
    )
    parser.add_argument(
        "--force-conversion",
        action="store_true",
        help="Run conversion even when prepared ONNX targets already exist.",
    )
    parser.add_argument(
        "--fail-if-not-ready",
        action="store_true",
        help="Exit non-zero unless det/rec ONNX models, dictionary, and pipeline are ready.",
    )
    return parser.parse_args(argv)


def build_report(
    *,
    sources_dir: Path = DEFAULT_SOURCES_DIR,
    model_dir: Path = DEFAULT_MODEL_DIR,
    allow_download: bool = True,
    allow_conversion: bool = True,
    converter: str = "local",
    force_conversion: bool = False,
    download_fn: DownloadFn | None = None,
    converter_runner: ConverterRunner | None = None,
    artifacts: Sequence[SourceArtifact] = SOURCE_ARTIFACTS,
) -> dict[str, Any]:
    download_fn = download_fn or download_file
    converter = normalize_converter(converter)
    converter_runner = converter_runner or converter_runner_for(converter)
    sources_dir.mkdir(parents=True, exist_ok=True)
    model_dir.mkdir(parents=True, exist_ok=True)

    source_reports = [
        ensure_source_artifact(
            artifact,
            sources_dir=sources_dir,
            allow_download=allow_download,
            download_fn=download_fn,
        )
        for artifact in artifacts
    ]
    extraction_reports = [
        extract_source_artifact(artifact, sources_dir=sources_dir)
        for artifact, source in zip(artifacts, source_reports, strict=True)
        if source["state"] == "present"
    ]
    metadata_report = prepare_metadata_artifacts(
        artifacts=artifacts,
        sources_dir=sources_dir,
        model_dir=model_dir,
    )
    conversion_reports = prepare_onnx_artifacts(
        artifacts=artifacts,
        sources_dir=sources_dir,
        model_dir=model_dir,
        allow_conversion=allow_conversion,
        converter=converter,
        force_conversion=force_conversion,
        converter_runner=converter_runner,
    )
    model_artifacts = inspect_prepared_model_artifacts(model_dir)
    status = classify_prepare_status(
        sources=source_reports,
        extractions=extraction_reports,
        metadata=metadata_report,
        conversions=conversion_reports,
        model_artifacts=model_artifacts,
    )
    return {
        "schema_version": 1,
        "generated_at": datetime.now(UTC).isoformat(),
        "mode": {
            "name": "ocr_directml_prepare_models",
            "goal": (
                "Prepare official PP-OCRv5 mobile assets for the DirectML OCR "
                "production gate without changing app startup behavior."
            ),
            "does_not_change_runtime_defaults": True,
            "does_not_run_ocr_inference": True,
            "download_policy": "explicit_qa_target_only",
            "converter": converter,
            "force_conversion": force_conversion,
        },
        "host": {
            "platform": platform.platform(),
            "python_version": platform.python_version(),
        },
        "conversion_tool": inspect_conversion_tool(),
        "sources": source_reports,
        "extractions": extraction_reports,
        "metadata": metadata_report,
        "conversions": conversion_reports,
        "model_artifacts": model_artifacts,
        "status": status,
    }


def normalize_converter(value: str) -> str:
    normalized = value.strip().lower()
    if normalized not in CONVERTERS:
        raise ValueError(f"unsupported converter: {value}")
    return normalized


def converter_runner_for(converter: str) -> ConverterRunner:
    if converter == "docker":
        return run_docker_paddlex_conversion
    return run_paddlex_conversion


def ensure_source_artifact(
    artifact: SourceArtifact,
    *,
    sources_dir: Path,
    allow_download: bool,
    download_fn: DownloadFn,
) -> dict[str, Any]:
    archive_path = sources_dir / artifact.filename
    if archive_path.exists() and verify_source_archive(archive_path, artifact):
        return source_artifact_report(artifact, archive_path, state="present")

    if archive_path.exists() and not allow_download:
        return source_artifact_report(
            artifact,
            archive_path,
            state="checksum_mismatch",
            blocker="source_checksum_mismatch",
        )
    if not allow_download:
        return source_artifact_report(
            artifact,
            archive_path,
            state="missing",
            blocker="source_archive_missing",
        )

    archive_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        prefix=f"{artifact.kind}-",
        suffix=".download",
        dir=archive_path.parent,
        delete=False,
    ) as temp_file:
        temp_path = Path(temp_file.name)
    try:
        download_fn(artifact.url, temp_path)
        if not verify_source_archive(temp_path, artifact):
            return source_artifact_report(
                artifact,
                temp_path,
                state="checksum_mismatch",
                blocker="source_checksum_mismatch",
            )
        temp_path.replace(archive_path)
    finally:
        if temp_path.exists():
            temp_path.unlink()

    return source_artifact_report(artifact, archive_path, state="present")


def source_artifact_report(
    artifact: SourceArtifact,
    archive_path: Path,
    *,
    state: str,
    blocker: str | None = None,
) -> dict[str, Any]:
    exists = archive_path.exists()
    return {
        "kind": artifact.kind,
        "model_name": artifact.model_name,
        "url": artifact.url,
        "path": str(archive_path),
        "state": state,
        "blocker": blocker,
        "expected_sha256": artifact.sha256,
        "actual_sha256": sha256_file(archive_path) if exists else None,
        "expected_bytes": artifact.byte_size,
        "actual_bytes": archive_path.stat().st_size if exists else 0,
    }


def verify_source_archive(path: Path, artifact: SourceArtifact) -> bool:
    return (
        path.is_file()
        and path.stat().st_size == artifact.byte_size
        and sha256_file(path).lower() == artifact.sha256
    )


def download_file(url: str, target: Path) -> None:
    with urlopen(url, timeout=60) as response, target.open("wb") as output:
        shutil.copyfileobj(response, output)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def extract_source_artifact(
    artifact: SourceArtifact,
    *,
    sources_dir: Path,
) -> dict[str, Any]:
    archive_path = sources_dir / artifact.filename
    extracted_dir = sources_dir / "extracted"
    model_source_dir = extracted_dir / artifact.archive_root
    if not verify_source_archive(archive_path, artifact):
        return {
            "kind": artifact.kind,
            "state": "skipped",
            "reason": "source_archive_not_verified",
            "source_dir": str(model_source_dir),
            "files": [],
        }

    extracted_dir.mkdir(parents=True, exist_ok=True)
    try:
        safe_extract_tar(
            archive_path=archive_path,
            destination=extracted_dir,
            expected_root=artifact.archive_root,
        )
    except Exception as exc:
        return {
            "kind": artifact.kind,
            "state": "failed",
            "reason": str(exc),
            "source_dir": str(model_source_dir),
            "files": [],
        }

    files = sorted(
        str(path.relative_to(model_source_dir))
        for path in model_source_dir.rglob("*")
        if path.is_file()
    )
    required = {"inference.yml", "inference.json", "inference.pdiparams"}
    missing = sorted(required - set(files))
    return {
        "kind": artifact.kind,
        "state": "ready" if not missing else "failed",
        "reason": None if not missing else "extracted_required_files_missing",
        "source_dir": str(model_source_dir),
        "files": files,
        "missing": missing,
    }


def safe_extract_tar(
    *,
    archive_path: Path,
    destination: Path,
    expected_root: str,
) -> None:
    destination_root = destination.resolve()
    with tarfile.open(archive_path, "r:*") as archive:
        members = archive.getmembers()
        for member in members:
            member_name = member.name.replace("\\", "/")
            if member_name.startswith("/") or ".." in Path(member_name).parts:
                raise ValueError(f"unsafe archive member path: {member.name}")
            if member.issym() or member.islnk():
                raise ValueError(f"refusing archive link member: {member.name}")
            if member_name != expected_root and not member_name.startswith(f"{expected_root}/"):
                raise ValueError(f"unexpected archive root: {member.name}")
            resolved = (destination / member_name).resolve()
            if destination_root not in (resolved, *resolved.parents):
                raise ValueError(f"archive member escapes destination: {member.name}")
        archive.extractall(destination, members=members, filter="data")


def prepare_metadata_artifacts(
    *,
    artifacts: Sequence[SourceArtifact],
    sources_dir: Path,
    model_dir: Path,
) -> dict[str, Any]:
    extracted_dir = sources_dir / "extracted"
    source_dirs = {
        artifact.kind: extracted_dir / artifact.archive_root for artifact in artifacts
    }
    missing_dirs = [
        str(path)
        for path in source_dirs.values()
        if not path.is_dir()
    ]
    if missing_dirs:
        return {
            "state": "skipped",
            "reason": "source_dirs_missing",
            "missing_dirs": missing_dirs,
        }

    try:
        det_config = load_inference_yml(source_dirs["det"] / "inference.yml")
        rec_config = load_inference_yml(source_dirs["rec"] / "inference.yml")
        chars = extract_character_dict(rec_config)
    except Exception as exc:
        return {
            "state": "failed",
            "reason": str(exc),
            "missing_dirs": [],
        }

    model_dir.mkdir(parents=True, exist_ok=True)
    char_dict_path = model_dir / "rec_char_dict.txt"
    char_dict_path.write_text("\n".join(chars) + "\n", encoding="utf-8")
    pipeline_path = model_dir / "pipeline.json"
    pipeline_path.write_text(
        json.dumps(
            build_pipeline_contract(
                artifacts=artifacts,
                det_config=det_config,
                rec_config=rec_config,
                character_count=len(chars),
            ),
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return {
        "state": "ready",
        "pipeline_json": str(pipeline_path),
        "rec_char_dict": str(char_dict_path),
        "character_count": len(chars),
    }


def load_inference_yml(path: Path) -> dict[str, Any]:
    payload = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"inference.yml is not a mapping: {path}")
    return payload


def extract_character_dict(rec_config: dict[str, Any]) -> list[str]:
    postprocess = rec_config.get("PostProcess")
    if not isinstance(postprocess, dict):
        raise ValueError("recognition PostProcess config missing")
    raw_chars = postprocess.get("character_dict")
    if not isinstance(raw_chars, list) or not raw_chars:
        raise ValueError("recognition character_dict missing")
    chars = [str(value) for value in raw_chars]
    if any(char == "" for char in chars):
        raise ValueError("recognition character_dict contains empty entries")
    return chars


def build_pipeline_contract(
    *,
    artifacts: Sequence[SourceArtifact],
    det_config: dict[str, Any],
    rec_config: dict[str, Any],
    character_count: int,
) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "model_family": "PP-OCRv5_mobile",
        "source": "PaddleX official inference models",
        "source_artifacts": [
            {
                "kind": artifact.kind,
                "model_name": artifact.model_name,
                "url": artifact.url,
                "sha256": artifact.sha256,
                "bytes": artifact.byte_size,
                "archive_root": artifact.archive_root,
            }
            for artifact in artifacts
        ],
        "runtime_contract": {
            "provider": "DmlExecutionProvider",
            "device_selection": "dxgi_adapter_index",
            "session_options": {
                "enable_mem_pattern": False,
                "execution_mode": "ORT_SEQUENTIAL",
            },
            "required_files": [
                "det_model.onnx",
                "rec_model.onnx",
                "rec_char_dict.txt",
                "pipeline.json",
            ],
        },
        "det": {
            "model_name": det_config.get("Global", {}).get("model_name"),
            "onnx_file": "det_model.onnx",
            "preprocess": det_config.get("PreProcess"),
            "postprocess": det_config.get("PostProcess"),
        },
        "rec": {
            "model_name": rec_config.get("Global", {}).get("model_name"),
            "onnx_file": "rec_model.onnx",
            "rec_char_dict_file": "rec_char_dict.txt",
            "character_count": character_count,
            "preprocess": rec_config.get("PreProcess"),
            "postprocess": sanitized_rec_postprocess(rec_config),
        },
    }


def sanitized_rec_postprocess(rec_config: dict[str, Any]) -> dict[str, Any]:
    postprocess = rec_config.get("PostProcess")
    if not isinstance(postprocess, dict):
        return {}
    return {
        key: value
        for key, value in postprocess.items()
        if key != "character_dict"
    }


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


def inspect_prepared_model_artifacts(model_dir: Path) -> dict[str, Any]:
    required_files = (
        "det_model.onnx",
        "rec_model.onnx",
        "rec_char_dict.txt",
        "pipeline.json",
    )
    required = [model_file_state(model_dir / name) for name in required_files]
    missing_required = [item["name"] for item in required if item["state"] != "present"]
    return {
        "model_dir": str(model_dir),
        "required": required,
        "missing_required": missing_required,
        "ready": len(missing_required) == 0,
    }


def model_file_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"name": path.name, "path": str(path), "state": "missing", "bytes": 0}
    if not path.is_file():
        return {"name": path.name, "path": str(path), "state": "not_file", "bytes": 0}
    size = path.stat().st_size
    return {
        "name": path.name,
        "path": str(path),
        "state": "present" if size > 0 else "empty",
        "bytes": size,
    }


def inspect_conversion_tool() -> dict[str, Any]:
    paddle2onnx_spec = importlib.util.find_spec("paddle2onnx")
    paddlex_spec = importlib.util.find_spec("paddlex")
    docker_exe = shutil.which("docker")
    return {
        "python_version": platform.python_version(),
        "paddlex_available": paddlex_spec is not None,
        "paddle2onnx_module_available": paddle2onnx_spec is not None,
        "docker_cli_available": docker_exe is not None,
        "docker_paddlex_image": DOCKER_PADDLEX_IMAGE,
        "preferred_command": [
            sys.executable,
            "-m",
            "paddlex",
            "--paddle2onnx",
            "--paddle_model_dir",
            "<source>",
            "--onnx_model_dir",
            "<output>",
            "--opset_version",
            "14",
        ],
        "note": (
            "PaddleX local high-performance/plugin docs target Python 3.8-3.12; "
            "this repo currently runs Python 3.13, so conversion may require a "
            "separate release-prep environment. The Docker converter is the "
            "reproducible Windows release-prep lane when Docker Desktop is available."
        ),
    }


def classify_prepare_status(
    *,
    sources: Sequence[dict[str, Any]],
    extractions: Sequence[dict[str, Any]],
    metadata: dict[str, Any],
    conversions: Sequence[dict[str, Any]],
    model_artifacts: dict[str, Any],
) -> dict[str, Any]:
    blockers: list[str] = []
    blockers.extend(str(item["blocker"]) for item in sources if item.get("blocker"))
    blockers.extend(
        str(item["reason"])
        for item in extractions
        if item.get("state") not in {"ready", "skipped"} and item.get("reason")
    )
    if metadata.get("state") != "ready":
        blockers.append(str(metadata.get("reason") or "metadata_not_ready"))
    blockers.extend(str(item["blocker"]) for item in conversions if item.get("blocker"))
    if not model_artifacts.get("ready"):
        blockers.append("model_artifacts_missing")

    unique_blockers = list(dict.fromkeys(blockers))
    source_ready = all(item.get("state") == "present" for item in sources)
    extraction_ready = len(extractions) > 0 and all(item.get("state") == "ready" for item in extractions)
    metadata_ready = metadata.get("state") == "ready"
    onnx_ready = all(item.get("state") == "ready" for item in conversions)
    if model_artifacts.get("ready"):
        state = "ready"
    elif not source_ready or not extraction_ready or not metadata_ready:
        state = "blocked"
    elif any(item.get("blocker") == "conversion_tool_unavailable" for item in conversions):
        state = "blocked"
    elif not onnx_ready:
        state = "ready_for_conversion"
    else:
        state = "blocked"

    return {
        "state": state,
        "source_archives_ready": source_ready,
        "source_extractions_ready": extraction_ready,
        "metadata_ready": metadata_ready,
        "onnx_models_ready": bool(model_artifacts.get("ready")),
        "blockers": unique_blockers,
        "current_safe_action": (
            "Keep DirectML OCR behind the production gate. Do not use CPU OCR as "
            "a silent fallback while ONNX assets or conversion tooling are missing."
        ),
        "recommended_next_step": recommended_next_step(state, unique_blockers),
    }


def recommended_next_step(state: str, blockers: Sequence[str]) -> str:
    if state == "ready":
        return "Run ocr-directml-session-smoke and then implement deterministic DirectML inference."
    if "conversion_tool_unavailable" in blockers:
        return (
            "Run PaddleX/Paddle2ONNX conversion in a Python 3.8-3.12 release-prep "
            "environment, then publish the ONNX assets by release URL."
        )
    if "model_artifacts_missing" in blockers:
        return "Finish conversion so det_model.onnx and rec_model.onnx exist."
    return "Inspect the prepare-models artifact and resolve the first listed blocker."


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    report = build_report(
        sources_dir=args.sources_dir,
        model_dir=args.model_dir,
        allow_download=not args.skip_download,
        allow_conversion=not args.skip_conversion,
        converter=args.converter,
        force_conversion=args.force_conversion,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))

    if args.fail_if_not_ready and report["status"]["state"] != "ready":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
