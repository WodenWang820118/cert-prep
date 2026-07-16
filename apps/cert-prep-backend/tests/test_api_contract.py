from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings


def test_status_like_fields_are_documented_as_openapi_enums(tmp_path) -> None:
    openapi = create_app(Settings(data_dir=tmp_path, api_token="contract-token")).openapi()

    assert _enum_values(openapi, "DocumentRead", "status") == [
        "processing",
        "cancel_requested",
        "canceled",
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
        "windowsml_ocr",
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
        "review_retry",
    ]
    assert _enum_values(openapi, "PracticeSessionRead", "mode") == [
        "random_draw",
        "full_document",
        "review_retry",
    ]
    assert _enum_values(openapi, "PracticeSessionRead", "status") == [
        "active",
        "completed",
        "abandoned",
    ]
    assert _enum_values(openapi, "LLMProviderSelectionRead", "preference") == [
        "auto",
        "ollama",
        "fake",
    ]
    assert _enum_values(openapi, "LLMProviderSelectionRead", "selected_provider") == [
        "ollama",
        "fake",
    ]
    assert _enum_values(openapi, "LLMHealthRead", "execution_mode") == [
        "auto",
        "cpu",
    ]
    assert _enum_values(openapi, "RuntimeRequirementRead", "kind") == [
        "ollama",
        "ollama_model",
        "paddle_ocr",
        "windowsml_ocr",
    ]
    assert _enum_values(openapi, "DocumentOperationRead", "status") == [
        "queued",
        "running",
        "cancel_requested",
        "canceled",
        "succeeded",
        "failed",
    ]
    assert _enum_values(openapi, "DocumentOperationRead", "phase") == [
        "uploading",
        "processing",
        "canceling",
        "committing",
        "canceled",
        "completed",
        "failed",
    ]
    assert _enum_values(openapi, "DraftGenerationJobRead", "status") == [
        "pending",
        "running",
        "cancel_requested",
        "canceled",
        "succeeded",
        "skipped_provider_unavailable",
        "skipped_missing_model",
        "failed",
    ]
    assert _enum_values(openapi, "ManualDraftGenerationOperationRead", "status") == [
        "queued",
        "running",
        "cancel_requested",
        "canceled",
        "succeeded",
        "failed",
    ]
    assert _enum_values(openapi, "RuntimeInstallationRead", "status") == [
        "queued",
        "running",
        "cancel_requested",
        "canceled",
        "waiting_for_user",
        "succeeded",
        "failed",
    ]


def test_document_operation_routes_and_upload_header_are_documented(tmp_path) -> None:
    openapi = create_app(Settings(data_dir=tmp_path, api_token="contract-token")).openapi()
    operation_schema = openapi["components"]["schemas"]["DocumentOperationRead"]

    assert set(operation_schema["required"]) == {
        "id",
        "project_id",
        "document_id",
        "status",
        "phase",
        "cancellable",
        "error",
        "created_at",
        "updated_at",
    }
    for field in ("document_id", "error"):
        assert {item.get("type") for item in operation_schema["properties"][field]["anyOf"]} == {
            "string",
            "null",
        }

    assert _response_schema_name(
        openapi,
        "/projects/{project_id}/document-operations/{operation_id}",
        "get",
        200,
    ) == "DocumentOperationRead"
    assert _response_schema_name(
        openapi,
        "/projects/{project_id}/document-operations/{operation_id}",
        "delete",
        202,
    ) == "DocumentOperationRead"
    assert _response_schema_name(
        openapi,
        "/projects/{project_id}/documents/{document_id}/processing",
        "delete",
        202,
    ) == "DocumentOperationRead"
    assert _response_schema_name(
        openapi,
        "/projects/{project_id}/documents/{document_id}/retry",
        "post",
        202,
    ) == "DocumentOperationRead"
    assert _response_schema_name(
        openapi,
        "/projects/{project_id}/document-operations/{operation_id}",
        "get",
        404,
    ) == "ApiErrorRead"
    assert _response_schema_name(
        openapi,
        "/projects/{project_id}/document-operations/{operation_id}",
        "delete",
        409,
    ) == "ApiErrorRead"
    assert _response_schema_name(
        openapi,
        "/projects/{project_id}/documents",
        "post",
        503,
    ) == "ApiErrorRead"
    assert _response_schema_name(
        openapi,
        "/projects/{project_id}/documents/{document_id}/retry",
        "post",
        409,
    ) == "ApiErrorRead"
    for path, method in (
        (
            "/projects/{project_id}/document-operations/{operation_id}",
            "get",
        ),
        (
            "/projects/{project_id}/document-operations/{operation_id}",
            "delete",
        ),
        ("/projects/{project_id}/documents", "post"),
        ("/projects/{project_id}/documents/{document_id}/retry", "post"),
    ):
        assert _response_schema_name(openapi, path, method, 422) == "ApiErrorRead"

    upload = openapi["paths"]["/projects/{project_id}/documents"]["post"]
    header = next(
        parameter
        for parameter in upload["parameters"]
        if parameter["name"] == "X-Cert-Prep-Operation-Id"
    )
    header_schema = next(
        item for item in header["schema"]["anyOf"] if item.get("type") == "string"
    )
    assert header["in"] == "header"
    assert header["required"] is False
    assert header_schema["minLength"] == 1
    assert header_schema["maxLength"] == 128
    assert header_schema["pattern"] == "^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$"


def test_operation_id_validation_uses_the_documented_error_envelope(tmp_path) -> None:
    app = create_app(Settings(data_dir=tmp_path, api_token="contract-token"))
    auth_headers = {"Authorization": "Bearer contract-token"}

    with TestClient(app) as client:
        invalid_path = client.get(
            "/projects/project-id/document-operations/!invalid",
            headers=auth_headers,
        )
        invalid_header = client.post(
            "/projects/project-id/documents/document-id/retry",
            headers={
                **auth_headers,
                "X-Cert-Prep-Operation-Id": "!invalid",
            },
        )

    for response in (invalid_path, invalid_header):
        assert response.status_code == 422
        payload = response.json()
        assert payload["code"] == "validation_error"
        assert payload["message"] == "Request validation failed."
        assert payload["details"]["errors"]


def test_practice_session_conflicts_are_documented(tmp_path) -> None:
    openapi = create_app(Settings(data_dir=tmp_path, api_token="contract-token")).openapi()

    assert _response_schema_name(openapi, "/projects/{project_id}/practice-sessions", "post", 409) == (
        "ApiErrorRead"
    )
    assert _response_schema_name(
        openapi,
        "/projects/{project_id}/practice-sessions/{session_id}/abandon",
        "post",
        409,
    ) == "ApiErrorRead"
    assert _response_schema_name(
        openapi,
        "/projects/{project_id}/practice-sessions/{session_id}/attempts",
        "post",
        409,
    ) == "ApiErrorRead"


def test_draft_job_effective_attribution_is_required_and_nullable(tmp_path) -> None:
    openapi = create_app(Settings(data_dir=tmp_path, api_token="contract-token")).openapi()
    schema = openapi["components"]["schemas"]["DraftGenerationJobRead"]

    attribution_fields = {
        "effective_provider",
        "effective_model",
        "fallback_reason",
    }
    assert attribution_fields | {"provider", "model"} <= set(schema["required"])
    for field in attribution_fields:
        assert {item.get("type") for item in schema["properties"][field]["anyOf"]} == {
            "string",
            "null",
        }


def test_commit_started_at_is_optional_and_nullable_for_durable_jobs(tmp_path) -> None:
    openapi = create_app(Settings(data_dir=tmp_path, api_token="contract-token")).openapi()

    for schema_name in (
        "ManualDraftGenerationOperationRead",
        "ModelDownloadRead",
        "RuntimeInstallationRead",
    ):
        schema = openapi["components"]["schemas"][schema_name]
        assert "commit_started_at" not in schema.get("required", [])
        assert {
            item.get("type")
            for item in schema["properties"]["commit_started_at"]["anyOf"]
        } == {"string", "null"}


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


def _response_schema_name(
    openapi: dict[str, Any],
    path: str,
    method: str,
    status_code: int,
) -> str:
    schema = openapi["paths"][path][method]["responses"][str(status_code)]["content"][
        "application/json"
    ]["schema"]
    return schema["$ref"].rsplit("/", 1)[-1]
