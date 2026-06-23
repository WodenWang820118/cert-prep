from fastapi.testclient import TestClient

from conftest import minimal_pdf
from cert_prep_backend.app import create_app
from cert_prep_backend.config import DEFAULT_OLLAMA_MODEL, Settings
from cert_prep_backend.domains.mock_exams.models import (
    AnswerKeySource,
    DraftStatus,
    DraftSuggestion,
)
from cert_prep_backend.domains.mock_exams import repository as drafts_repository
from cert_prep_backend.errors import ProviderUnavailableError
from cert_prep_backend.domains.mock_exams.ports import ProviderHealth
from cert_prep_backend.domains.mock_exams.schemas import DraftGenerateRequest


def test_generation_defaults_to_deterministic_only_without_provider_call(
    tmp_path, auth_headers
) -> None:
    provider = RecordingExamProvider()
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            llm_provider=provider,
            document_processing_async_jobs=False,
        )
    )
    project_id = _create_project(client, auth_headers)
    document_id = _upload_document(client, auth_headers, project_id)

    assert DraftGenerateRequest().strategy.value == "deterministic_only"
    response = client.post(
        f"/projects/{project_id}/documents/{document_id}/drafts",
        headers=auth_headers,
        json={"limit": 1},
    )

    assert response.status_code == 201
    assert provider.generate_calls == 0
    drafts = response.json()["items"]
    assert drafts == []


def test_hybrid_reasoning_provider_output_is_saved_as_playable_question(
    tmp_path, auth_headers
) -> None:
    provider = RecordingExamProvider()
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            llm_provider=provider,
            document_processing_async_jobs=False,
        )
    )
    project_id = _create_project(client, auth_headers)
    document_id = _upload_document(client, auth_headers, project_id)

    response = client.post(
        f"/projects/{project_id}/documents/{document_id}/drafts",
        headers=auth_headers,
        json={"limit": 1, "strategy": "hybrid_reasoning"},
    )

    assert response.status_code == 201
    assert provider.generate_calls == 1
    draft = response.json()["items"][0]
    assert draft["status"] == "approved"
    assert draft["answer_key_source"] == "ai_inferred"
    assert draft["confidence"] == 0.73
    assert draft["rationale"] == "The cited source supports the correct answer."


def test_created_question_is_playable_and_editable(
    client: TestClient, auth_headers
) -> None:
    project_id = _create_project(client, auth_headers)
    document_id = _upload_document(client, auth_headers, project_id)
    question = client.post(
        f"/projects/{project_id}/documents/{document_id}/drafts",
        headers=auth_headers,
        json={"limit": 1, "strategy": "hybrid_reasoning"},
    ).json()["items"][0]

    assert question["status"] == "approved"

    patched = client.patch(
        f"/projects/{project_id}/question-drafts/{question['id']}",
        headers=auth_headers,
        json={"question": "Edited playable question?"},
    )

    assert patched.status_code == 200
    assert patched.json()["question"] == "Edited playable question?"
    assert patched.json()["status"] == "approved"


def test_generation_preserves_existing_approved_drafts(
    client: TestClient, auth_headers
) -> None:
    project_id = _create_project(client, auth_headers)
    document_id = _upload_document(client, auth_headers, project_id)
    chunks = client.get(
        f"/projects/{project_id}/documents/{document_id}/chunks",
        headers=auth_headers,
    ).json()["items"]
    chunk = chunks[0]
    created = client.post(
        f"/projects/{project_id}/question-drafts",
        headers=auth_headers,
        json={
            "document_id": document_id,
            "chunk_id": chunk["id"],
            "question": "Which action applies?",
            "choices": ["Apply least privilege", "Grant all access"],
            "answer": "Apply least privilege",
            "answer_key_source": "ai_inferred",
            "rationale": "The cited source limits access.",
            "citation_page": chunk["page_number"],
            "source_excerpt": chunk["source_excerpt"],
            "confidence": 0.91,
        },
    )
    assert created.status_code == 201
    assert created.json()["status"] == "approved"

    generated = client.post(
        f"/projects/{project_id}/documents/{document_id}/drafts",
        headers=auth_headers,
        json={"limit": 1},
    )

    assert generated.status_code == 201
    listed = client.get(f"/projects/{project_id}/question-drafts", headers=auth_headers)
    assert any(
        item["id"] == created.json()["id"] and item["status"] == "approved"
        for item in listed.json()["items"]
    )


def test_create_question_rejects_partial_source_reference(
    client: TestClient, auth_headers
) -> None:
    project_id = _create_project(client, auth_headers)
    document_id = _upload_document(client, auth_headers, project_id)

    response = client.post(
        f"/projects/{project_id}/question-drafts",
        headers=auth_headers,
        json={
            "document_id": document_id,
            "question": "Which action applies?",
            "choices": ["Apply least privilege", "Grant all access"],
            "answer": "Apply least privilege",
            "answer_key_source": "manual",
            "rationale": "The cited source limits access.",
        },
    )

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


def test_streaming_append_preserves_existing_drafts_and_dedupes_retries(
    client: TestClient, auth_headers
) -> None:
    project_id = _create_project(client, auth_headers)
    document_id = _upload_document(client, auth_headers, project_id)
    chunk = client.get(
        f"/projects/{project_id}/documents/{document_id}/chunks",
        headers=auth_headers,
    ).json()["items"][0]
    existing = client.post(
        f"/projects/{project_id}/question-drafts",
        headers=auth_headers,
        json={
            "document_id": document_id,
            "chunk_id": chunk["id"],
            "question": "Existing edited draft",
            "choices": ["A", "B"],
            "answer": "A",
            "answer_key_source": "manual",
            "rationale": "Edited by reviewer.",
            "citation_page": chunk["page_number"],
            "source_excerpt": chunk["source_excerpt"],
        },
    ).json()
    suggestion = DraftSuggestion(
        chunk_id=chunk["id"],
        question="Which action best applies the cited exam concept?",
        choices=["Apply the cited concept", "Ignore the cited source"],
        answer="Apply the cited concept",
        answer_key_source=AnswerKeySource.AI_INFERRED,
        rationale="The cited source supports the correct answer.",
        citation_page=chunk["page_number"],
        source_excerpt=chunk["source_excerpt"],
        source_question_number="1",
    )

    first = drafts_repository.append_generated_drafts(
        client.app.state.database,
        project_id=project_id,
        document_id=document_id,
        suggestions=[suggestion],
    )
    second = drafts_repository.append_generated_drafts(
        client.app.state.database,
        project_id=project_id,
        document_id=document_id,
        suggestions=[suggestion],
    )

    assert len(first) == 1
    assert second == []
    listed = client.get(f"/projects/{project_id}/question-drafts", headers=auth_headers)
    draft_ids = {item["id"] for item in listed.json()["items"]}
    assert existing["id"] in draft_ids
    assert first[0]["id"] in draft_ids


def test_custom_answer_key_source_remains_backward_compatible(
    client: TestClient, auth_headers
) -> None:
    project_id = _create_project(client, auth_headers)

    created = client.post(
        f"/projects/{project_id}/question-drafts",
        headers=auth_headers,
        json={
            "question": "Which source should be trusted?",
            "choices": ["A", "B"],
            "answer": "A",
            "answer_key_source": "legacy_custom",
            "rationale": "Existing databases may contain custom source labels.",
        },
    )

    assert created.status_code == 201
    draft_id = created.json()["id"]
    assert created.json()["answer_key_source"] == "legacy_custom"

    patched = client.patch(
        f"/projects/{project_id}/question-drafts/{draft_id}",
        headers=auth_headers,
        json={"answer_key_source": "legacy_custom_patch"},
    )

    assert patched.status_code == 200
    assert patched.json()["answer_key_source"] == "legacy_custom_patch"

    listed = client.get(f"/projects/{project_id}/question-drafts", headers=auth_headers)
    assert listed.status_code == 200
    assert listed.json()["items"][0]["answer_key_source"] == "legacy_custom_patch"


def test_bad_draft_source_ids_return_error_envelope(client: TestClient, auth_headers) -> None:
    project_id = _create_project(client, auth_headers)

    response = client.post(
        f"/projects/{project_id}/question-drafts",
        headers=auth_headers,
        json={
            "question": "Which control applies?",
            "choices": ["A", "B"],
            "answer": "A",
            "rationale": "Because it matches the control objective.",
            "citation_page": 1,
            "source_excerpt": "A source.",
            "document_id": "missing-document",
            "chunk_id": "missing-chunk",
        },
    )

    assert response.status_code == 404
    assert response.json() == {"code": "not_found", "message": "Document chunk not found."}


def test_explicit_generation_returns_provider_unavailable_error_envelope(
    tmp_path, auth_headers
) -> None:
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            llm_provider=UnavailableExamProvider(),
            document_processing_async_jobs=False,
        )
    )
    project_id = _create_project(client, auth_headers)
    document_id = _upload_document(client, auth_headers, project_id)
    document = client.get(
        f"/projects/{project_id}/documents/{document_id}", headers=auth_headers
    )
    assert document.status_code == 200
    assert document.json()["status"] == "ready"
    assert document.json()["exam_item_count"] == 0

    response = client.post(
        f"/projects/{project_id}/documents/{document_id}/drafts",
        headers=auth_headers,
        json={"limit": 1, "strategy": "hybrid_reasoning"},
    )

    assert response.status_code == 503
    assert response.json() == {
        "code": "provider_unavailable",
        "message": "provider offline",
    }


def _create_project(client: TestClient, auth_headers) -> str:
    response = client.post("/projects", headers=auth_headers, json={"name": "Cloud"})
    assert response.status_code == 201
    return response.json()["id"]


class UnavailableExamProvider:
    provider = "unavailable"
    model = DEFAULT_OLLAMA_MODEL

    def health(self) -> ProviderHealth:
        return ProviderHealth(
            provider=self.provider,
            model=self.model,
            available=False,
            detail="provider offline",
        )

    def generate_drafts(self, _chunks, _limit):
        raise ProviderUnavailableError("provider offline")


class RecordingExamProvider:
    provider = "recording"
    model = DEFAULT_OLLAMA_MODEL

    def __init__(self) -> None:
        self.generate_calls = 0

    def health(self) -> ProviderHealth:
        return ProviderHealth(
            provider=self.provider,
            model=self.model,
            available=True,
            detail="recording provider",
        )

    def generate_drafts(self, chunks, limit):
        self.generate_calls += 1
        chunk = chunks[0]
        excerpt = chunk.excerpt_or_text_prefix()
        return [
            DraftSuggestion(
                chunk_id=chunk.id,
                question="Which action best applies the cited exam concept?",
                choices=[
                    "Apply the cited concept",
                    "Ignore the cited source",
                    "Choose an unrelated control",
                    "Remove all safeguards",
                ],
                answer="Apply the cited concept",
                answer_key_source=AnswerKeySource.AI_INFERRED,
                rationale="The cited source supports the correct answer.",
                citation_page=chunk.page_number,
                source_excerpt=excerpt,
                status=DraftStatus.APPROVED,
                confidence=0.73,
                source_order=(chunk.page_number * 10_000) + 1,
            )
        ][:limit]


def _upload_document(
    client: TestClient,
    auth_headers,
    project_id: str,
    *,
    text: str = "Least privilege limits access to required permissions.",
) -> str:
    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={
            "file": (
                "cloud.pdf",
                minimal_pdf(text),
                "application/pdf",
            )
        },
    )
    assert response.status_code == 201
    return response.json()["id"]
