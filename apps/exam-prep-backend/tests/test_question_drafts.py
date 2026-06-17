from fastapi.testclient import TestClient

from conftest import minimal_pdf
from exam_prep_backend.app import create_app
from exam_prep_backend.config import Settings
from exam_prep_backend.errors import ProviderUnavailableError
from exam_prep_backend.domains.mock_exams.ports import ProviderHealth


def test_fake_provider_generates_deterministic_approved_mock_exam_items(
    client: TestClient, auth_headers
) -> None:
    project_id = _create_project(client, auth_headers)
    document_id = _upload_document(client, auth_headers, project_id)

    response = client.post(
        f"/projects/{project_id}/documents/{document_id}/drafts",
        headers=auth_headers,
        json={"limit": 1},
    )

    assert response.status_code == 201
    drafts = response.json()["items"]
    assert len(drafts) == 1
    draft = drafts[0]
    assert draft["status"] == "approved"
    assert draft["citation_page"] == 1
    assert "least privilege" in draft["source_excerpt"].lower()
    assert draft["answer_key_source"] == "ai_inferred"
    assert draft["choices"] == [
        "Apply the cited concept",
        "Ignore the cited source",
        "Choose an unrelated control",
        "Remove all safeguards",
    ]
    assert draft["answer"] == "Apply the cited concept"


def test_approval_blocks_drafts_missing_required_learning_evidence(
    client: TestClient, auth_headers
) -> None:
    project_id = _create_project(client, auth_headers)
    created = client.post(
        f"/projects/{project_id}/question-drafts",
        headers=auth_headers,
        json={
            "question": "Which control applies?",
            "choices": ["A", "B"],
            "answer": "A",
            "rationale": "Because it matches the control objective.",
        },
    )
    assert created.status_code == 201
    draft_id = created.json()["id"]

    blocked = client.post(
        f"/projects/{project_id}/question-drafts/{draft_id}/approve",
        headers=auth_headers,
    )

    assert blocked.status_code == 422
    assert blocked.json() == {
        "code": "validation_error",
        "message": "Draft cannot be approved without complete citation evidence.",
        "details": {
            "missing": ["document_id", "chunk_id", "citation_page", "source_excerpt"]
        },
    }


def test_cited_draft_can_be_approved(client: TestClient, auth_headers) -> None:
    project_id = _create_project(client, auth_headers)
    document_id = _upload_document(client, auth_headers, project_id)
    draft = client.post(
        f"/projects/{project_id}/documents/{document_id}/drafts",
        headers=auth_headers,
        json={"limit": 1},
    ).json()["items"][0]

    approved = client.post(
        f"/projects/{project_id}/question-drafts/{draft['id']}/approve",
        headers=auth_headers,
    )

    assert approved.status_code == 200
    assert approved.json()["status"] == "approved"


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


def test_draft_with_fake_source_citation_cannot_be_approved(
    client: TestClient, auth_headers
) -> None:
    project_id = _create_project(client, auth_headers)
    created = client.post(
        f"/projects/{project_id}/question-drafts",
        headers=auth_headers,
        json={
            "question": "Which control applies?",
            "choices": ["A", "B"],
            "answer": "A",
            "rationale": "Because it matches the control objective.",
            "citation_page": 1,
            "source_excerpt": "A made up citation.",
        },
    )
    assert created.status_code == 201

    blocked = client.post(
        f"/projects/{project_id}/question-drafts/{created.json()['id']}/approve",
        headers=auth_headers,
    )

    assert blocked.status_code == 422
    assert blocked.json()["details"]["missing"] == ["document_id", "chunk_id"]


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
        json={"limit": 1},
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
    model = "gemma4:12b"

    def health(self) -> ProviderHealth:
        return ProviderHealth(
            provider=self.provider,
            model=self.model,
            available=False,
            detail="provider offline",
        )

    def generate_drafts(self, _chunks, _limit):
        raise ProviderUnavailableError("provider offline")


def _upload_document(client: TestClient, auth_headers, project_id: str) -> str:
    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={
            "file": (
                "cloud.pdf",
                minimal_pdf("Least privilege limits access to required permissions."),
                "application/pdf",
            )
        },
    )
    assert response.status_code == 201
    return response.json()["id"]
