from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

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

    all_current = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"mode": "review_retry"},
    )

    assert all_current.status_code == 201
    all_current_session = all_current.json()
    assert all_current_session["mode"] == "review_retry"
    assert set(all_current_session["question_ids"]) == {
        first_question["id"],
        second_question["id"],
    }
    assert all_current_session["question_count"] == 2

    abandoned = client.post(
        f"/projects/{project_id}/practice-sessions/{all_current_session['id']}/abandon",
        headers=auth_headers,
    )
    assert abandoned.status_code == 200
    assert abandoned.json()["status"] == "abandoned"

    targeted = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"mode": "review_retry", "wrong_attempt_ids": [second_wrong["id"]]},
    )

    assert targeted.status_code == 201
    targeted_session = targeted.json()
    assert targeted_session["mode"] == "review_retry"
    assert targeted_session["document_id"] is None
    assert targeted_session["question_count"] == 1
    assert targeted_session["question_ids"] == [second_question["id"]]
    assert targeted_session["questions"][0]["document_id"] == document_id
    assert targeted_session["questions"][0]["answer"] == "Temporary credentials"

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
    assert first.status_code == 201
    abandoned = client.post(
        f"/projects/{project_id}/practice-sessions/{first.json()['id']}/abandon",
        headers=auth_headers,
    )
    assert abandoned.status_code == 200
    second = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json=payload,
    )

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


def test_active_session_can_be_discovered_abandoned_and_replaced(
    client: TestClient, auth_headers
) -> None:
    project_id = _create_project(client, auth_headers)
    document_id = _upload_document(client, auth_headers, project_id)
    question = _create_manual_question(client, auth_headers, project_id, document_id)

    created = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"question_count": 1},
    )

    assert created.status_code == 201
    session = created.json()
    assert session["status"] == "active"
    assert session["completed_at"] is None
    assert session["abandoned_at"] is None
    assert session["attempts"] == []

    active = client.get(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
    )
    assert active.status_code == 200
    assert active.json() == {
        "items": [
            {
                "id": session["id"],
                "project_id": project_id,
                "mode": "random_draw",
                "document_id": None,
                "status": "active",
                "created_at": session["created_at"],
            }
        ]
    }

    conflict = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"question_count": 1},
    )
    assert conflict.status_code == 409
    assert conflict.json() == {
        "code": "active_session_exists",
        "message": "An active practice session already exists for this project.",
        "details": {"active_session": active.json()["items"][0]},
    }

    abandoned = client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/abandon",
        headers=auth_headers,
    )
    assert abandoned.status_code == 200
    abandoned_session = abandoned.json()
    assert abandoned_session["status"] == "abandoned"
    assert abandoned_session["abandoned_at"] is not None
    assert abandoned_session["completed_at"] is None
    assert client.get(
        f"/projects/{project_id}/practice-sessions", headers=auth_headers
    ).json() == {"items": []}

    repeated_abandon = client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/abandon",
        headers=auth_headers,
    )
    assert repeated_abandon.status_code == 200
    assert repeated_abandon.json()["abandoned_at"] == abandoned_session["abandoned_at"]

    rejected_attempt = client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
        headers=auth_headers,
        json={"question_id": question["id"], "selected_answer": question["answer"]},
    )
    assert rejected_attempt.status_code == 409
    assert rejected_attempt.json() == {
        "code": "practice_session_abandoned",
        "message": "Abandoned practice sessions cannot accept attempts.",
    }

    replacement = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"question_count": 1},
    )
    assert replacement.status_code == 201
    assert replacement.json()["id"] != session["id"]


def test_session_completion_uses_distinct_coverage_and_preserves_attempt_history(
    client: TestClient, auth_headers
) -> None:
    project_id = _create_project(client, auth_headers)
    document_id = _upload_document(client, auth_headers, project_id)
    first = _create_manual_question(client, auth_headers, project_id, document_id)
    second = _create_manual_question(
        client,
        auth_headers,
        project_id,
        document_id,
        question="Which credential should be preferred?",
        choices=["Temporary credential", "Permanent administrator"],
        answer="Temporary credential",
    )
    session = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"mode": "full_document", "document_id": document_id},
    ).json()

    first_attempt = client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
        headers=auth_headers,
        json={"question_id": first["id"], "selected_answer": first["answer"]},
    )
    repeated_first = client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
        headers=auth_headers,
        json={"question_id": first["id"], "selected_answer": first["answer"]},
    )
    assert first_attempt.status_code == 201
    assert repeated_first.status_code == 201

    still_active = client.get(
        f"/projects/{project_id}/practice-sessions/{session['id']}",
        headers=auth_headers,
    ).json()
    assert still_active["status"] == "active"
    assert still_active["completed_at"] is None
    assert [attempt["id"] for attempt in still_active["attempts"]] == [
        first_attempt.json()["id"],
        repeated_first.json()["id"],
    ]

    last_distinct = client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
        headers=auth_headers,
        json={"question_id": second["id"], "selected_answer": second["answer"]},
    )
    assert last_distinct.status_code == 201

    completed = client.get(
        f"/projects/{project_id}/practice-sessions/{session['id']}",
        headers=auth_headers,
    ).json()
    assert completed["status"] == "completed"
    assert completed["completed_at"] == last_distinct.json()["created_at"]
    assert completed["abandoned_at"] is None
    assert len(completed["attempts"]) == 3
    assert client.get(
        f"/projects/{project_id}/practice-sessions", headers=auth_headers
    ).json() == {"items": []}

    repeated_after_completion = client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
        headers=auth_headers,
        json={"question_id": first["id"], "selected_answer": first["answer"]},
    )
    assert repeated_after_completion.status_code == 201
    after_repeat = client.get(
        f"/projects/{project_id}/practice-sessions/{session['id']}",
        headers=auth_headers,
    ).json()
    assert after_repeat["completed_at"] == completed["completed_at"]
    assert len(after_repeat["attempts"]) == 4

    abandon_completed = client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/abandon",
        headers=auth_headers,
    )
    assert abandon_completed.status_code == 409
    assert abandon_completed.json() == {
        "code": "practice_session_completed",
        "message": "Completed practice sessions cannot be abandoned.",
    }


def test_concurrent_session_creation_keeps_exactly_one_active_session(
    client: TestClient, auth_headers
) -> None:
    project_id = _create_project(client, auth_headers)
    document_id = _upload_document(client, auth_headers, project_id)
    _create_manual_question(client, auth_headers, project_id, document_id)
    start = Barrier(2)

    def create_session() -> tuple[int, dict]:
        start.wait()
        response = client.post(
            f"/projects/{project_id}/practice-sessions",
            headers=auth_headers,
            json={"question_count": 1},
        )
        return response.status_code, response.json()

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _index: create_session(), range(2)))

    assert sorted(status_code for status_code, _payload in results) == [201, 409]
    conflict_payload = next(payload for status_code, payload in results if status_code == 409)
    created_payload = next(payload for status_code, payload in results if status_code == 201)
    assert conflict_payload["code"] == "active_session_exists"
    assert conflict_payload["details"]["active_session"]["id"] == created_payload["id"]

    with client.app.state.database.connect() as connection:
        active_count = connection.execute(
            """
            SELECT COUNT(*)
            FROM practice_sessions
            WHERE project_id = ? AND status = 'active'
            """,
            (project_id,),
        ).fetchone()[0]
    assert active_count == 1
