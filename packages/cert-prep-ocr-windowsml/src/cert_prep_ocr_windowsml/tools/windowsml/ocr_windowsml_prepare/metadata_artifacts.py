from __future__ import annotations

from collections.abc import Sequence
import json
from pathlib import Path
import shutil
from typing import Any

import yaml

from .model_types import SourceArtifact


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
    det_dir = model_dir / "det"
    rec_dir = model_dir / "rec"
    det_dir.mkdir(parents=True, exist_ok=True)
    rec_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_dirs["det"] / "inference.yml", det_dir / "inference.yml")
    shutil.copy2(source_dirs["rec"] / "inference.yml", rec_dir / "inference.yml")
    char_dict_path = model_dir / "rec_char_dict.txt"
    char_dict_path.write_text("\n".join(chars) + "\n", encoding="utf-8")
    paddleocr_char_dict_path = rec_dir / "ppocr_keys_v1.txt"
    paddleocr_char_dict_path.write_text("\n".join(chars) + "\n", encoding="utf-8")
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
        "paddleocr_rec_char_dict": str(paddleocr_char_dict_path),
        "det_inference_yml": str(det_dir / "inference.yml"),
        "rec_inference_yml": str(rec_dir / "inference.yml"),
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
        "model_family": "PP-OCRv6_medium",
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
            "provider": "windowsml",
            "provider_id": "DmlExecutionProvider",
            "device_selection": "dxgi_adapter_index",
            "ocr_engine": "PaddleOCR 3.7 engine='onnxruntime'",
            "session_options": {
                "enable_mem_pattern": False,
                "execution_mode": "ORT_SEQUENTIAL",
            },
            "required_files": [
                "det/inference.onnx",
                "det/inference.yml",
                "rec/inference.onnx",
                "rec/inference.yml",
                "rec/ppocr_keys_v1.txt",
                "pipeline.json",
            ],
        },
        "det": {
            "model_name": det_config.get("Global", {}).get("model_name"),
            "onnx_file": "det/inference.onnx",
            "preprocess": det_config.get("PreProcess"),
            "postprocess": det_config.get("PostProcess"),
        },
        "rec": {
            "model_name": rec_config.get("Global", {}).get("model_name"),
            "onnx_file": "rec/inference.onnx",
            "rec_char_dict_file": "rec/ppocr_keys_v1.txt",
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
