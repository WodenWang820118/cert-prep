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
        model_name="PP-OCRv6_medium_det",
        url=(
            "https://paddle-model-ecology.bj.bcebos.com/paddlex/"
            "official_inference_model/paddle3.0.0/PP-OCRv6_medium_det_infer.tar"
        ),
        filename="PP-OCRv6_medium_det_infer.tar",
        sha256="144d0621e059566e5086e228829171591c144c2deb07b2dad4962214fbabfcf7",
        byte_size=62_279_680,
        archive_root="PP-OCRv6_medium_det_infer",
        target_onnx_name="det/inference.onnx",
    ),
    SourceArtifact(
        kind="rec",
        model_name="PP-OCRv6_medium_rec",
        url=(
            "https://paddle-model-ecology.bj.bcebos.com/paddlex/"
            "official_inference_model/paddle3.0.0/PP-OCRv6_medium_rec_infer.tar"
        ),
        filename="PP-OCRv6_medium_rec_infer.tar",
        sha256="4eecc1c6a4623765042e6fc15446da0da110b7d875b6b72b2d351d2b2dbd4da6",
        byte_size=76_851_200,
        archive_root="PP-OCRv6_medium_rec_infer",
        target_onnx_name="rec/inference.onnx",
    ),
)
