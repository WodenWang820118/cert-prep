from __future__ import annotations

from .cli import main, parse_args
from .constants import (
    BACKEND_ROOT,
    CONVERTERS,
    CONVERSION_TIMEOUT_SECONDS,
    DEFAULT_MODEL_DIR,
    DEFAULT_OUTPUT_DIR,
    DEFAULT_SOURCES_DIR,
    DOCKER_PADDLEX_IMAGE,
    SCRIPT_DIR,
    SOURCE_ARTIFACTS,
)
from .conversion import (
    classify_conversion_blocker,
    conversion_report,
    converter_runner_for,
    docker_work_path,
    normalize_converter,
    prepare_onnx_artifacts,
    run_docker_paddlex_conversion,
    run_paddlex_conversion,
)
from .inspection import (
    classify_prepare_status,
    inspect_conversion_tool,
    inspect_prepared_model_artifacts,
    model_file_state,
    recommended_next_step,
)
from .metadata_artifacts import (
    build_pipeline_contract,
    extract_character_dict,
    load_inference_yml,
    prepare_metadata_artifacts,
    sanitized_rec_postprocess,
)
from .model_types import ConversionResult, ConverterRunner, DownloadFn, SourceArtifact
from .report import build_report, default_output_path
from .source_artifacts import (
    download_file,
    ensure_source_artifact,
    extract_source_artifact,
    safe_extract_tar,
    sha256_file,
    source_artifact_report,
    verify_source_archive,
)


__all__ = [
    "BACKEND_ROOT",
    "CONVERTERS",
    "CONVERSION_TIMEOUT_SECONDS",
    "ConverterRunner",
    "ConversionResult",
    "DEFAULT_MODEL_DIR",
    "DEFAULT_OUTPUT_DIR",
    "DEFAULT_SOURCES_DIR",
    "DOCKER_PADDLEX_IMAGE",
    "DownloadFn",
    "SCRIPT_DIR",
    "SOURCE_ARTIFACTS",
    "SourceArtifact",
    "build_pipeline_contract",
    "build_report",
    "classify_conversion_blocker",
    "classify_prepare_status",
    "conversion_report",
    "converter_runner_for",
    "default_output_path",
    "docker_work_path",
    "download_file",
    "ensure_source_artifact",
    "extract_character_dict",
    "extract_source_artifact",
    "inspect_conversion_tool",
    "inspect_prepared_model_artifacts",
    "load_inference_yml",
    "main",
    "model_file_state",
    "normalize_converter",
    "parse_args",
    "prepare_metadata_artifacts",
    "prepare_onnx_artifacts",
    "recommended_next_step",
    "run_docker_paddlex_conversion",
    "run_paddlex_conversion",
    "safe_extract_tar",
    "sanitized_rec_postprocess",
    "sha256_file",
    "source_artifact_report",
    "verify_source_archive",
]
