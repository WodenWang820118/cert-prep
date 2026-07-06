from fastapi.testclient import TestClient

from practice_test_support import (
    _create_manual_question,
    _create_project,
    _generate_playable_question,
    _upload_document,
)


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
    assert session["questions"] == [
        {
            "id": question["id"],
            "question": question["question"],
            "choices": question["choices"],
            "answer": question["answer"],
            "rationale": question["rationale"],
            "citation_page": question["citation_page"],
            "source_excerpt": question["source_excerpt"],
            "document_id": document_id,
        }
    ]

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
    assert item["document_id"] == document_id
    assert item["document_id"] == document_id

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

def test_review_retry_session_uses_current_wrong_answer_snapshots(
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
    wrong_attempt = client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
        headers=auth_headers,
        json={
            "question_id": question["id"],
            "selected_answer": "Allow unrestricted access",
        },
    ).json()

    retry_response = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"mode": "review_retry", "wrong_attempt_ids": [wrong_attempt["id"]]},
    )

    assert retry_response.status_code == 201
    retry = retry_response.json()
    assert retry["mode"] == "review_retry"
    assert retry["question_ids"] == [question["id"]]
    assert retry["questions"] == [
        {
            "id": question["id"],
            "question": "Which access model should be applied?",
            "choices": ["Use least privilege", "Allow unrestricted access"],
            "answer": "Use least privilege",
            "rationale": "The document says permissions should remain scoped.",
            "citation_page": 1,
            "source_excerpt": "Least privilege keeps cloud permissions scoped.",
            "document_id": document_id,
        }
    ]

    corrected = client.post(
        f"/projects/{project_id}/practice-sessions/{retry['id']}/attempts",
        headers=auth_headers,
        json={
            "question_id": question["id"],
            "selected_answer": "Use least privilege",
        },
    )
    assert corrected.status_code == 201
    assert corrected.json()["is_correct"] is True
    assert (
        client.get(f"/projects/{project_id}/wrong-answers", headers=auth_headers).json()[
            "items"
        ]
        == []
    )

def test_review_retry_rejects_cleared_wrong_attempt(client: TestClient, auth_headers) -> None:
    project_id = _create_project(client, auth_headers)
    document_id = _upload_document(client, auth_headers, project_id)
    question = _create_manual_question(client, auth_headers, project_id, document_id)
    session = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"question_count": 1},
    ).json()
    wrong_attempt = client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
        headers=auth_headers,
        json={
            "question_id": question["id"],
            "selected_answer": "Allow unrestricted access",
        },
    ).json()
    client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
        headers=auth_headers,
        json={
            "question_id": question["id"],
            "selected_answer": "Use least privilege",
        },
    )

    retry_response = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"mode": "review_retry", "wrong_attempt_ids": [wrong_attempt["id"]]},
    )

    assert retry_response.status_code == 422
    assert retry_response.json() == {
        "code": "validation_error",
        "message": "Wrong attempt ids must refer to current wrong answers in this project.",
    }

def test_review_retry_session_uses_selected_current_wrong_answers(
    client: TestClient, auth_headers
) -> None:
    project_id = _create_project(client, auth_headers)
    document_id = _upload_document(client, auth_headers, project_id)
    first_question = _create_manual_question(client, auth_headers, project_id, document_id)
    second_question = _create_manual_question(
        client,
        auth_headers,
        project_id,
        document_id,
        question="Which permissions should be rotated?",
        choices=["Temporary credentials", "Global administrator"],
        answer="Temporary credentials",
        rationale="The source says short-lived credentials reduce blast radius.",
    )
    session = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"mode": "full_document", "document_id": document_id},
    ).json()
    first_wrong = client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
        headers=auth_headers,
        json={
            "question_id": first_question["id"],
            "selected_answer": "Allow unrestricted access",
        },
    ).json()
    second_wrong = client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
        headers=auth_headers,
        json={
            "question_id": second_question["id"],
            "selected_answer": "Global administrator",
        },
    ).json()

    targeted = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"mode": "review_retry", "wrong_attempt_ids": [second_wrong["id"]]},
    )
    all_current = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"mode": "review_retry"},
    )

    assert targeted.status_code == 201
    targeted_session = targeted.json()
    assert targeted_session["mode"] == "review_retry"
    assert targeted_session["document_id"] is None
    assert targeted_session["question_count"] == 1
    assert targeted_session["question_ids"] == [second_question["id"]]
    assert targeted_session["questions"][0]["document_id"] == document_id
    assert targeted_session["questions"][0]["answer"] == "Temporary credentials"

    assert all_current.status_code == 201
    all_current_session = all_current.json()
    assert all_current_session["mode"] == "review_retry"
    assert set(all_current_session["question_ids"]) == {
        first_question["id"],
        second_question["id"],
    }
    assert all_current_session["question_count"] == 2

    cleared = client.post(
        f"/projects/{project_id}/practice-sessions/{targeted_session['id']}/attempts",
        headers=auth_headers,
        json={
            "question_id": second_question["id"],
            "selected_answer": "Temporary credentials",
        },
    )
    assert cleared.status_code == 201
    invalid_retry = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"mode": "review_retry", "wrong_attempt_ids": [second_wrong["id"]]},
    )
    assert invalid_retry.status_code == 422
    assert first_wrong["id"] != second_wrong["id"]

def test_session_question_document_id_falls_back_for_old_snapshots(
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
            """
            UPDATE practice_session_questions
            SET document_id = NULL
            WHERE session_id = ? AND question_id = ?
            """,
            (session["id"], question["id"]),
        )

    response = client.get(
        f"/projects/{project_id}/practice-sessions/{session['id']}",
        headers=auth_headers,
    )

    assert response.status_code == 200
    assert response.json()["questions"][0]["document_id"] == document_id

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

def test_random_quiz_session_excludes_incomplete_approved_rows(
    client: TestClient, auth_headers
) -> None:
    project_id = _create_project(client, auth_headers)
    document_id = _upload_document(client, auth_headers, project_id)
    complete = _create_manual_question(client, auth_headers, project_id, document_id)
    incomplete = _create_manual_question(
        client,
        auth_headers,
        project_id,
        document_id,
        question="   ",
    )

    response = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"mode": "random_draw", "question_count": 10, "random_seed": 12345},
    )

    assert response.status_code == 201
    session = response.json()
    assert session["question_ids"] == [complete["id"]]
    assert incomplete["id"] not in session["question_ids"]

def test_full_exam_session_excludes_incomplete_approved_rows(
    client: TestClient, auth_headers
) -> None:
    project_id = _create_project(client, auth_headers)
    document_id = _upload_document(client, auth_headers, project_id)
    first = _create_manual_question(
        client,
        auth_headers,
        project_id,
        document_id,
        question="First source item?",
        source_order=10,
    )
    incomplete = _create_manual_question(
        client,
        auth_headers,
        project_id,
        document_id,
        question="Incomplete source item?",
        rationale=" ",
        source_order=20,
    )
    second = _create_manual_question(
        client,
        auth_headers,
        project_id,
        document_id,
        question="Second source item?",
        source_order=30,
    )

    response = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"mode": "full_document", "document_id": document_id},
    )

    assert response.status_code == 201
    session = response.json()
    assert session["mode"] == "full_document"
    assert session["question_count"] == 2
    assert session["question_ids"] == [first["id"], second["id"]]
    assert incomplete["id"] not in session["question_ids"]
