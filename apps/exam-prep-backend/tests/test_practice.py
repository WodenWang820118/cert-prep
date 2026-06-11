from fastapi.testclient import TestClient

from conftest import minimal_pdf


def test_practice_session_attempts_and_wrong_answer_review(client: TestClient, auth_headers) -> None:
    project_id = _create_project(client, auth_headers)
    _upload_document(client, auth_headers, project_id)
    approved = client.get(
        f"/projects/{project_id}/question-drafts",
        headers=auth_headers,
    ).json()["items"][0]

    session_response = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"question_count": 5},
    )
    assert session_response.status_code == 201
    session = session_response.json()
    assert session["project_id"] == project_id
    assert session["question_ids"] == [approved["id"]]

    attempt = client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
        headers=auth_headers,
        json={"question_id": approved["id"], "selected_answer": "Ignore the cited source"},
    )
    assert attempt.status_code == 201
    assert attempt.json()["is_correct"] is False

    wrong_answers = client.get(f"/projects/{project_id}/wrong-answers", headers=auth_headers)
    assert wrong_answers.status_code == 200
    item = wrong_answers.json()["items"][0]
    assert item["question_id"] == approved["id"]
    assert item["selected_answer"] == "Ignore the cited source"
    assert item["correct_answer"] == "Apply the cited concept"
    assert item["citation_page"] == 1

    corrected = client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
        headers=auth_headers,
        json={"question_id": approved["id"], "selected_answer": "Apply the cited concept"},
    )
    assert corrected.status_code == 201
    assert corrected.json()["is_correct"] is True

    resolved_wrong_answers = client.get(
        f"/projects/{project_id}/wrong-answers", headers=auth_headers
    )
    assert resolved_wrong_answers.status_code == 200
    assert resolved_wrong_answers.json()["items"] == []


def test_practice_attempt_rejects_answer_outside_choices(client: TestClient, auth_headers) -> None:
    project_id = _create_project(client, auth_headers)
    _upload_document(client, auth_headers, project_id)
    approved = client.get(
        f"/projects/{project_id}/question-drafts",
        headers=auth_headers,
    ).json()["items"][0]
    session = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"question_count": 1},
    ).json()

    response = client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
        headers=auth_headers,
        json={"question_id": approved["id"], "selected_answer": "Not a listed choice"},
    )

    assert response.status_code == 422
    assert response.json() == {
        "code": "validation_error",
        "message": "Selected answer is not one of the available choices.",
    }


def test_practice_attempt_rejects_approved_question_outside_session(
    client: TestClient, auth_headers
) -> None:
    project_id = _create_project(client, auth_headers)
    document_id = _upload_document(client, auth_headers, project_id)
    second_question = _create_approved_manual_question(
        client,
        auth_headers,
        project_id,
        document_id,
    )
    approved_questions = client.get(
        f"/projects/{project_id}/question-drafts",
        headers=auth_headers,
    ).json()["items"]
    assert second_question["id"] in {question["id"] for question in approved_questions}

    session = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"question_count": 1},
    ).json()
    assert len(session["question_ids"]) == 1
    outside_question = next(
        question for question in approved_questions if question["id"] not in session["question_ids"]
    )
    assert outside_question["status"] == "approved"

    response = client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
        headers=auth_headers,
        json={
            "question_id": outside_question["id"],
            "selected_answer": outside_question["answer"],
        },
    )

    assert response.status_code == 422
    assert response.json() == {
        "code": "validation_error",
        "message": "Question is not part of this practice session.",
    }


def _create_project(client: TestClient, auth_headers) -> str:
    response = client.post("/projects", headers=auth_headers, json={"name": "Azure"})
    assert response.status_code == 201
    return response.json()["id"]


def _upload_document(client: TestClient, auth_headers, project_id: str) -> str:
    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={
            "file": (
                "azure.pdf",
                minimal_pdf("Least privilege keeps cloud permissions scoped."),
                "application/pdf",
            )
        },
    )
    assert response.status_code == 201
    return response.json()["id"]


def _create_approved_manual_question(
    client: TestClient,
    auth_headers,
    project_id: str,
    document_id: str,
) -> dict:
    chunks_response = client.get(
        f"/projects/{project_id}/documents/{document_id}/chunks",
        headers=auth_headers,
    )
    assert chunks_response.status_code == 200
    chunk = chunks_response.json()["items"][0]
    created = client.post(
        f"/projects/{project_id}/question-drafts",
        headers=auth_headers,
        json={
            "question": "Which access model should be applied?",
            "choices": ["Use least privilege", "Allow unrestricted access"],
            "answer": "Use least privilege",
            "rationale": "The document says permissions should remain scoped.",
            "document_id": document_id,
            "chunk_id": chunk["id"],
            "citation_page": chunk["page_number"],
            "source_excerpt": chunk["source_excerpt"],
        },
    )
    assert created.status_code == 201

    approved = client.post(
        f"/projects/{project_id}/question-drafts/{created.json()['id']}/approve",
        headers=auth_headers,
    )
    assert approved.status_code == 200
    assert approved.json()["status"] == "approved"
    return approved.json()
