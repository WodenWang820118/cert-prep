from fastapi.testclient import TestClient

from conftest import minimal_pdf


def test_practice_session_attempts_and_wrong_answer_review(client: TestClient, auth_headers) -> None:
    project_id = _create_project(client, auth_headers)
    document_id = _upload_document(client, auth_headers, project_id)
    question = _generate_playable_question(client, auth_headers, project_id, document_id)

    session_response = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"question_count": 5},
    )
    assert session_response.status_code == 201
    session = session_response.json()
    assert session["project_id"] == project_id
    assert session["question_ids"] == [question["id"]]
    assert session["mode"] == "random_draw"
    assert session["document_id"] is None
    assert session["question_count"] == 5
    assert isinstance(session["random_seed"], int)

    attempt = client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
        headers=auth_headers,
        json={"question_id": question["id"], "selected_answer": "Ignore the cited source"},
    )
    assert attempt.status_code == 201
    assert attempt.json()["is_correct"] is False

    wrong_answers = client.get(f"/projects/{project_id}/wrong-answers", headers=auth_headers)
    assert wrong_answers.status_code == 200
    item = wrong_answers.json()["items"][0]
    assert item["question_id"] == question["id"]
    assert item["selected_answer"] == "Ignore the cited source"
    assert item["correct_answer"] == "Apply the cited concept"
    assert item["citation_page"] == 1

    corrected = client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
        headers=auth_headers,
        json={"question_id": question["id"], "selected_answer": "Apply the cited concept"},
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
    document_id = _upload_document(client, auth_headers, project_id)
    question = _generate_playable_question(client, auth_headers, project_id, document_id)
    session = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"question_count": 1},
    ).json()

    response = client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
        headers=auth_headers,
        json={"question_id": question["id"], "selected_answer": "Not a listed choice"},
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
    _generate_playable_question(client, auth_headers, project_id, document_id)
    second_question = _create_manual_question(
        client,
        auth_headers,
        project_id,
        document_id,
    )
    playable_questions = client.get(
        f"/projects/{project_id}/question-drafts",
        headers=auth_headers,
    ).json()["items"]
    assert second_question["id"] in {question["id"] for question in playable_questions}

    session = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"question_count": 1},
    ).json()
    assert len(session["question_ids"]) == 1
    outside_question = next(
        question for question in playable_questions if question["id"] not in session["question_ids"]
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


def test_full_document_session_uses_source_order_for_document_drafts(
    client: TestClient, auth_headers
) -> None:
    project_id = _create_project(client, auth_headers)
    document_id = _upload_document(client, auth_headers, project_id)
    second = _create_manual_question(
        client,
        auth_headers,
        project_id,
        document_id,
        question="Second source item?",
        source_order=20,
    )
    first = _create_manual_question(
        client,
        auth_headers,
        project_id,
        document_id,
        question="First source item?",
        source_order=10,
    )

    response = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"mode": "full_document", "document_id": document_id},
    )

    assert response.status_code == 201
    session = response.json()
    assert session["mode"] == "full_document"
    assert session["document_id"] == document_id
    assert session["question_count"] == 2
    assert session["random_seed"] is None
    assert session["question_ids"] == [first["id"], second["id"]]


def test_random_draw_session_uses_fixed_seed_deterministically(
    client: TestClient, auth_headers
) -> None:
    project_id = _create_project(client, auth_headers)
    document_id = _upload_document(client, auth_headers, project_id)
    questions = [
        _create_manual_question(
            client,
            auth_headers,
            project_id,
            document_id,
            question=f"Seeded item {index}?",
            source_order=index,
        )
        for index in range(1, 4)
    ]

    payload = {"mode": "random_draw", "question_count": 2, "random_seed": 12345}
    first = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json=payload,
    )
    second = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json=payload,
    )

    assert first.status_code == 201
    assert second.status_code == 201
    first_session = first.json()
    second_session = second.json()
    assert first_session["mode"] == "random_draw"
    assert first_session["question_count"] == 2
    assert first_session["random_seed"] == 12345
    assert first_session["question_ids"] == second_session["question_ids"]
    assert len(first_session["question_ids"]) == 2
    assert set(first_session["question_ids"]) <= {item["id"] for item in questions}


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


def _generate_playable_question(
    client: TestClient,
    auth_headers,
    project_id: str,
    document_id: str,
) -> dict:
    response = client.post(
        f"/projects/{project_id}/documents/{document_id}/drafts",
        headers=auth_headers,
        json={"limit": 1, "strategy": "hybrid_reasoning"},
    )
    assert response.status_code == 201
    draft = response.json()["items"][0]
    assert draft["status"] == "approved"
    return draft


def _create_manual_question(
    client: TestClient,
    auth_headers,
    project_id: str,
    document_id: str,
    *,
    question: str = "Which access model should be applied?",
    source_order: int | None = None,
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
            "question": question,
            "choices": ["Use least privilege", "Allow unrestricted access"],
            "answer": "Use least privilege",
            "rationale": "The document says permissions should remain scoped.",
            "document_id": document_id,
            "chunk_id": chunk["id"],
            "citation_page": chunk["page_number"],
            "source_excerpt": chunk["source_excerpt"],
            "source_order": source_order,
            "item_kind": "vocabulary_single",
        },
    )
    assert created.status_code == 201
    assert created.json()["status"] == "approved"
    return created.json()
