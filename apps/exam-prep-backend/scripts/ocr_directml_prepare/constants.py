from __future__ import annotations

from pathlib import Path

from .model_types import SourceArtifact


SCRIPT_DIR = Path(__file__).resolve().parents[1]
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
