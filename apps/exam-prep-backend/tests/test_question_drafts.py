from fastapi.testclient import TestClient

from conftest import minimal_pdf


def test_fake_provider_generates_deterministic_cited_drafts(client: TestClient, auth_headers) -> None:
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
    assert draft["status"] == "draft"
    assert draft["citation_page"] == 1
    assert "least privilege" in draft["source_excerpt"].lower()
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


def _create_project(client: TestClient, auth_headers) -> str:
    response = client.post("/projects", headers=auth_headers, json={"name": "Cloud"})
    assert response.status_code == 201
    return response.json()["id"]


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
