from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
import platform
from pathlib import Path
from typing import Any

from .constants import (
    DEFAULT_MODEL_DIR,
    DEFAULT_OUTPUT_DIR,
    DEFAULT_SOURCES_DIR,
    SOURCE_ARTIFACTS,
)
from .conversion import converter_runner_for, normalize_converter, prepare_onnx_artifacts
from .inspection import (
    classify_prepare_status,
    inspect_conversion_tool,
    inspect_prepared_model_artifacts,
)
from .metadata_artifacts import prepare_metadata_artifacts
from .model_types import ConverterRunner, DownloadFn, SourceArtifact
from .source_artifacts import download_file, ensure_source_artifact, extract_source_artifact


def default_output_path() -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return DEFAULT_OUTPUT_DIR / f"ocr-windowsml-prepare-models-{stamp}.json"


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
            "name": "ocr_windowsml_prepare_models",
            "goal": (
                "Prepare official PP-OCRv6 medium assets for the PaddleOCR 3.7 "
                "ONNXRuntime WindowsML production gate without changing app startup behavior."
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
