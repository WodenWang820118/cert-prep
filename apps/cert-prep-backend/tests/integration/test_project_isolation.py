from fastapi.testclient import TestClient

from conftest import minimal_pdf


def test_project_scoped_records_are_invisible_to_other_projects(
    client: TestClient, auth_headers
) -> None:
    owner_project_id = _create_project(client, auth_headers, "Owner")
    other_project_id = _create_project(client, auth_headers, "Other")

    owner_document_id = _upload_document(
        client,
        auth_headers,
        owner_project_id,
        filename="owner.pdf",
        text="Least privilege keeps cloud permissions scoped.",
    )
    owner_chunk = _first_chunk(client, auth_headers, owner_project_id, owner_document_id)
    owner_question = _create_question(
        client,
        auth_headers,
        owner_project_id,
        owner_document_id,
        owner_chunk,
        question="Which access model should be applied?",
    )
    owner_session = _create_full_document_session(
        client,
        auth_headers,
        owner_project_id,
        owner_document_id,
    )
    owner_attempt = _record_attempt(
        client,
        auth_headers,
        owner_project_id,
        owner_session["id"],
        owner_question["id"],
        "Allow unrestricted access",
    )
    assert owner_attempt["is_correct"] is False

    assert _items(
        client.get(f"/projects/{other_project_id}/documents", headers=auth_headers)
    ) == []
    assert _items(
        client.get(f"/projects/{other_project_id}/question-drafts", headers=auth_headers)
    ) == []
    assert _items(
        client.get(f"/projects/{other_project_id}/wrong-answers", headers=auth_headers)
    ) == []
    assert _items(
        client.get(
            f"/projects/{other_project_id}/practice-sessions",
            headers=auth_headers,
        )
    ) == []

    _assert_not_found(
        client.get(
            f"/projects/{other_project_id}/documents/{owner_document_id}",
            headers=auth_headers,
        ),
        "Document not found.",
    )
    _assert_not_found(
        client.get(
            f"/projects/{other_project_id}/documents/{owner_document_id}/chunks",
            headers=auth_headers,
        ),
        "Document not found.",
    )
    _assert_not_found(
        client.post(
            f"/projects/{other_project_id}/documents/{owner_document_id}/drafts",
            headers=auth_headers,
            json={"limit": 1},
        ),
        "Document not found.",
    )
    _assert_not_found(
        client.post(
            f"/projects/{other_project_id}/question-drafts",
            headers=auth_headers,
            json=_question_payload(owner_document_id, owner_chunk),
        ),
        "Document chunk not found.",
    )
    _assert_not_found(
        client.patch(
            f"/projects/{other_project_id}/question-drafts/{owner_question['id']}",
            headers=auth_headers,
            json={"question": "Cross-project edit?"},
        ),
        "Question draft not found.",
    )
    _assert_not_found(
        client.post(
            f"/projects/{other_project_id}/practice-sessions",
            headers=auth_headers,
            json={"mode": "full_document", "document_id": owner_document_id},
        ),
        "Document not found.",
    )
    _assert_not_found(
        client.get(
            f"/projects/{other_project_id}/practice-sessions/{owner_session['id']}",
            headers=auth_headers,
        ),
        "Practice session not found.",
    )
    _assert_not_found(
        client.post(
            f"/projects/{other_project_id}/practice-sessions/{owner_session['id']}/attempts",
            headers=auth_headers,
            json={
                "question_id": owner_question["id"],
                "selected_answer": "Allow unrestricted access",
            },
        ),
        "Practice session not found.",
    )
    _assert_not_found(
        client.post(
            f"/projects/{other_project_id}/practice-sessions/{owner_session['id']}/abandon",
            headers=auth_headers,
        ),
        "Practice session not found.",
    )
    _assert_not_found(
        client.post(
            f"/projects/{other_project_id}/wrong-answers/{owner_attempt['id']}/explanation",
            headers=auth_headers,
        ),
        "Wrong answer not found.",
    )

    other_document_id = _upload_document(
        client,
        auth_headers,
        other_project_id,
        filename="other.pdf",
        text="Segregation of duties limits privileged action.",
    )
    other_chunk = _first_chunk(client, auth_headers, other_project_id, other_document_id)
    _create_question(
        client,
        auth_headers,
        other_project_id,
        other_document_id,
        other_chunk,
        question="Which duty model should be applied?",
    )
    other_session = _create_full_document_session(
        client,
        auth_headers,
        other_project_id,
        other_document_id,
    )

    _assert_not_found(
        client.post(
            f"/projects/{other_project_id}/practice-sessions/{other_session['id']}/attempts",
            headers=auth_headers,
            json={
                "question_id": owner_question["id"],
                "selected_answer": "Allow unrestricted access",
            },
        ),
        "Playable question not found.",
    )
    assert _items(
        client.get(f"/projects/{other_project_id}/wrong-answers", headers=auth_headers)
    ) == []


def _create_project(client: TestClient, auth_headers, name: str) -> str:
    response = client.post("/projects", headers=auth_headers, json={"name": name})
    assert response.status_code == 201
    return response.json()["id"]


def _upload_document(
    client: TestClient,
    auth_headers,
    project_id: str,
    *,
    filename: str,
    text: str,
) -> str:
    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={
            "file": (
                filename,
                minimal_pdf(text),
                "application/pdf",
            )
        },
    )
    assert response.status_code == 201
    return response.json()["id"]


def _first_chunk(
    client: TestClient,
    auth_headers,
    project_id: str,
    document_id: str,
) -> dict:
    response = client.get(
        f"/projects/{project_id}/documents/{document_id}/chunks",
        headers=auth_headers,
    )
    assert response.status_code == 200
    chunks = response.json()["items"]
    assert len(chunks) == 1
    return chunks[0]


def _create_question(
    client: TestClient,
    auth_headers,
    project_id: str,
    document_id: str,
    chunk: dict,
    *,
    question: str,
) -> dict:
    response = client.post(
        f"/projects/{project_id}/question-drafts",
        headers=auth_headers,
        json=_question_payload(document_id, chunk, question=question),
    )
    assert response.status_code == 201
    assert response.json()["status"] == "approved"
    return response.json()


def _question_payload(
    document_id: str,
    chunk: dict,
    *,
    question: str = "Which access model should be applied?",
) -> dict:
    return {
        "document_id": document_id,
        "chunk_id": chunk["id"],
        "question": question,
        "choices": ["Use least privilege", "Allow unrestricted access"],
        "answer": "Use least privilege",
        "rationale": "The cited source limits access.",
        "citation_page": chunk["page_number"],
        "source_excerpt": chunk["source_excerpt"],
        "answer_key_source": "manual",
    }


def _create_full_document_session(
    client: TestClient,
    auth_headers,
    project_id: str,
    document_id: str,
) -> dict:
    response = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"mode": "full_document", "document_id": document_id},
    )
    assert response.status_code == 201
    return response.json()


def _record_attempt(
    client: TestClient,
    auth_headers,
    project_id: str,
    session_id: str,
    question_id: str,
    selected_answer: str,
) -> dict:
    response = client.post(
        f"/projects/{project_id}/practice-sessions/{session_id}/attempts",
        headers=auth_headers,
        json={"question_id": question_id, "selected_answer": selected_answer},
    )
    assert response.status_code == 201
    return response.json()


def _assert_not_found(response, message: str) -> None:
    assert response.status_code == 404
    assert response.json() == {"code": "not_found", "message": message}


def _items(response) -> list[dict]:
    assert response.status_code == 200
    return response.json()["items"]
