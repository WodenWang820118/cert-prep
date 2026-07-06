from fastapi.testclient import TestClient

from practice_test_support import (
    _create_manual_question,
    _create_project,
    _generate_playable_question,
    _upload_document,
)


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

def test_legacy_practice_attempt_fallback_does_not_require_live_playability(
    client: TestClient, auth_headers
) -> None:
    project_id = _create_project(client, auth_headers)
    document_id = _upload_document(client, auth_headers, project_id)
    question = _create_manual_question(client, auth_headers, project_id, document_id)
    session = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"question_count": 1},
    ).json()

    with client.app.state.database.connect() as connection:
        connection.execute(
            "DELETE FROM practice_session_questions WHERE session_id = ?",
            (session["id"],),
        )
        connection.execute(
            """
            UPDATE question_drafts
            SET rationale = ''
            WHERE project_id = ? AND id = ?
            """,
            (project_id, question["id"]),
        )

    response = client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
        headers=auth_headers,
        json={
            "question_id": question["id"],
            "selected_answer": "Use least privilege",
        },
    )

    assert response.status_code == 201
    assert response.json()["is_correct"] is True

def test_practice_attempt_grades_against_session_question_snapshot(
    client: TestClient, auth_headers
) -> None:
    project_id = _create_project(client, auth_headers)
    document_id = _upload_document(client, auth_headers, project_id)
    question = _create_manual_question(client, auth_headers, project_id, document_id)
    session = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"question_count": 1},
    ).json()

    updated = client.patch(
        f"/projects/{project_id}/question-drafts/{question['id']}",
        headers=auth_headers,
        json={
            "choices": ["Rotate keys after launch", "Allow unrestricted access"],
            "answer": "Rotate keys after launch",
            "rationale": "The live draft was edited after session creation.",
        },
    )
    assert updated.status_code == 200
    assert updated.json()["answer"] == "Rotate keys after launch"

    response = client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
        headers=auth_headers,
        json={
            "question_id": question["id"],
            "selected_answer": "Use least privilege",
        },
    )

    assert response.status_code == 201
    attempt = response.json()
    assert attempt["is_correct"] is True

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

def test_practice_attempt_rejects_incomplete_approved_row_as_not_playable(
    client: TestClient, auth_headers
) -> None:
    project_id = _create_project(client, auth_headers)
    document_id = _upload_document(client, auth_headers, project_id)
    _create_manual_question(client, auth_headers, project_id, document_id)
    incomplete = _create_manual_question(
        client,
        auth_headers,
        project_id,
        document_id,
        rationale=" ",
    )
    session = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"question_count": 1},
    ).json()

    response = client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
        headers=auth_headers,
        json={
            "question_id": incomplete["id"],
            "selected_answer": incomplete["answer"],
        },
    )

    assert response.status_code == 404
    assert response.json() == {
        "code": "not_found",
        "message": "Playable question not found.",
    }

def test_practice_excludes_and_rejects_no_evidence_approved_row(
    client: TestClient, auth_headers
) -> None:
    project_id = _create_project(client, auth_headers)
    document_id = _upload_document(client, auth_headers, project_id)
    complete = _create_manual_question(client, auth_headers, project_id, document_id)
    no_evidence = _create_manual_question(
        client,
        auth_headers,
        project_id,
        document_id,
        question="Which answer is missing source evidence?",
        citation_page=None,
        source_excerpt=None,
        source_order=20,
    )
    assert no_evidence["citation_page"] is None
    assert no_evidence["source_excerpt"] is None

    session_response = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"mode": "random_draw", "question_count": 10, "random_seed": 12345},
    )
    assert session_response.status_code == 201
    session = session_response.json()
    assert session["question_ids"] == [complete["id"]]
    assert no_evidence["id"] not in session["question_ids"]

    attempt_response = client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
        headers=auth_headers,
        json={
            "question_id": no_evidence["id"],
            "selected_answer": no_evidence["answer"],
        },
    )

    assert attempt_response.status_code == 404
    assert attempt_response.json() == {
        "code": "not_found",
        "message": "Playable question not found.",
    }
