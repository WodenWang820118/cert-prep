from __future__ import annotations

from typing import Any

from exam_prep_backend.app import create_app
from exam_prep_backend.config import Settings


def test_status_like_fields_are_documented_as_openapi_enums(tmp_path) -> None:
    openapi = create_app(Settings(data_dir=tmp_path, api_token="contract-token")).openapi()

    assert _enum_values(openapi, "DocumentRead", "status") == [
        "processing",
        "ready",
        "exam_failed",
        "no_text_detected",
        "ocr_failed",
    ]
    assert _enum_values(openapi, "DocumentRead", "extraction_method") == [
        "embedded",
        "mixed",
        "none",
        "ocr_failed",
        "paddle_ocr_cpu",
        "paddle_ocr_cpu_fallback",
        "paddle_ocr_gpu",
        "paddle_ocr_gpu_fallback",
        "directml_ocr",
        "amd_npu_ocr",
        "fake_ocr",
    ]
    assert _enum_values(openapi, "DocumentRead", "content_profile") == [
        "unknown",
        "jlpt_vocabulary",
        "jlpt_grouped",
        "mixed",
    ]
    assert _enum_values(openapi, "ChunkRead", "content_profile") == [
        "unknown",
        "jlpt_vocabulary",
        "jlpt_grouped",
        "mixed",
    ]
    assert _enum_values(openapi, "QuestionDraftRead", "status") == ["approved"]
    assert _enum_values(openapi, "QuestionDraftRead", "answer_key_source") == [
        "manual",
        "pdf",
        "ai_inferred",
    ]
    assert _enum_values(openapi, "QuestionDraftRead", "item_kind") == [
        "unknown",
        "vocabulary_single",
        "grouped_question",
    ]
    assert _enum_values(openapi, "DraftGenerateRequest", "strategy") == [
        "deterministic_only",
        "hybrid_reasoning",
    ]
    assert _enum_values(openapi, "PracticeSessionCreate", "mode") == [
        "random_draw",
        "full_document",
    ]
    assert _enum_values(openapi, "PracticeSessionRead", "mode") == [
        "random_draw",
        "full_document",
    ]


def _enum_values(openapi: dict[str, Any], schema_name: str, property_name: str) -> list[str]:
    schema = openapi["components"]["schemas"][schema_name]["properties"][property_name]
    if "$ref" in schema:
        schema = _resolve_ref(openapi, schema["$ref"])
    if "anyOf" in schema:
        enum_schema = next(
            item for item in schema["anyOf"] if "$ref" in item or "enum" in item
        )
        schema = _resolve_ref(openapi, enum_schema["$ref"]) if "$ref" in enum_schema else enum_schema
    return schema["enum"]


def _resolve_ref(openapi: dict[str, Any], ref: str) -> dict[str, Any]:
    schema_name = ref.rsplit("/", 1)[-1]
    return openapi["components"]["schemas"][schema_name]
