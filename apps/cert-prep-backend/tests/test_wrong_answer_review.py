import json
from uuid import uuid4

from fastapi.testclient import TestClient

from cert_prep_backend.domains.practice import attempt_repository
from practice_test_support import _create_manual_question, _create_project, _upload_document


def test_wrong_answer_summary_counts_current_cleared_and_repeated_misses(
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
        question="Which review habit is grounded?",
        choices=["Check the source", "Guess from memory"],
        answer="Check the source",
        rationale="The source tells learners to check the citation.",
        source_order=20,
    )
    session = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"question_count": 2, "random_seed": 12345},
    ).json()
    for question, selected in [
        (first, "Allow unrestricted access"),
        (first, "Allow unrestricted access"),
        (first, "Use least privilege"),
        (second, "Guess from memory"),
    ]:
        response = client.post(
            f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
            headers=auth_headers,
            json={"question_id": question["id"], "selected_answer": selected},
        )
        assert response.status_code == 201

    summary = client.get(
        f"/projects/{project_id}/wrong-answers/summary", headers=auth_headers
    )

    assert summary.status_code == 200
    body = summary.json()
    assert body["current_wrong_count"] == 1
    assert body["cleared_count"] == 1
    assert body["last_wrong_date"] is not None
    assert body["repeated_misses"][0]["question_id"] == first["id"]
    assert body["repeated_misses"][0]["miss_count"] == 2
    assert body["clusters"] == [
        {
            "document_id": document_id,
            "citation_page": 1,
            "current_wrong_count": 1,
            "cleared_count": 1,
            "last_wrong_at": body["clusters"][0]["last_wrong_at"],
        }
    ]

def test_wrong_answer_summary_groups_same_timestamp_attempts_by_insert_sequence(
    client: TestClient, auth_headers, monkeypatch
) -> None:
    monkeypatch.setattr(
        attempt_repository,
        "utc_now",
        lambda: "2026-07-16T00:00:00+00:00",
    )
    project_id = _create_project(client, auth_headers)
    document_id = _upload_document(client, auth_headers, project_id)
    repeated_question = _create_manual_question(client, auth_headers, project_id, document_id)
    cleared_question = _create_manual_question(
        client,
        auth_headers,
        project_id,
        document_id,
        question="Which credential lifetime is preferred?",
        choices=["Short-lived", "Permanent"],
        answer="Short-lived",
        rationale="The source favors short-lived credentials.",
    )
    session = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"mode": "full_document", "document_id": document_id},
    ).json()
    for _ in range(2):
        response = client.post(
            f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
            headers=auth_headers,
            json={
                "question_id": repeated_question["id"],
                "selected_answer": "Allow unrestricted access",
            },
        )
        assert response.status_code == 201
    response = client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
        headers=auth_headers,
        json={"question_id": cleared_question["id"], "selected_answer": "Permanent"},
    )
    assert response.status_code == 201
    response = client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
        headers=auth_headers,
        json={"question_id": cleared_question["id"], "selected_answer": "Short-lived"},
    )
    assert response.status_code == 201

    summary_response = client.get(
        f"/projects/{project_id}/wrong-answers/summary",
        headers=auth_headers,
    )

    assert summary_response.status_code == 200
    summary = summary_response.json()
    assert summary["current_wrong_count"] == 1
    assert summary["cleared_count"] == 1
    assert summary["last_wrong_date"] is not None
    assert summary["repeated_misses"] == [
        {
            "question_id": repeated_question["id"],
            "question": repeated_question["question"],
            "document_id": document_id,
            "citation_page": 1,
            "source_excerpt": repeated_question["source_excerpt"],
            "miss_count": 2,
            "last_wrong_at": summary["repeated_misses"][0]["last_wrong_at"],
        }
    ]
    assert summary["clusters"] == [
        {
            "document_id": document_id,
            "citation_page": 1,
            "current_wrong_count": 1,
            "cleared_count": 1,
            "last_wrong_at": summary["clusters"][0]["last_wrong_at"],
        }
    ]

def test_wrong_answer_review_uses_latest_attempt_session_snapshot(
    client: TestClient, auth_headers
) -> None:
    project_id = _create_project(client, auth_headers)
    document_id = _upload_document(client, auth_headers, project_id)
    question = _create_manual_question(client, auth_headers, project_id, document_id)
    old_key_session = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"question_count": 1},
    ).json()
    completed_old_session = client.post(
        f"/projects/{project_id}/practice-sessions/{old_key_session['id']}/attempts",
        headers=auth_headers,
        json={
            "question_id": question["id"],
            "selected_answer": "Use least privilege",
        },
    )
    assert completed_old_session.status_code == 201

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
    new_key_session = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"question_count": 1},
    ).json()
    older_wrong = client.post(
        f"/projects/{project_id}/practice-sessions/{new_key_session['id']}/attempts",
        headers=auth_headers,
        json={
            "question_id": question["id"],
            "selected_answer": "Allow unrestricted access",
        },
    )
    assert older_wrong.status_code == 201
    newer_wrong = client.post(
        f"/projects/{project_id}/practice-sessions/{old_key_session['id']}/attempts",
        headers=auth_headers,
        json={
            "question_id": question["id"],
            "selected_answer": "Allow unrestricted access",
        },
    )
    assert newer_wrong.status_code == 201

    response = client.get(f"/projects/{project_id}/wrong-answers", headers=auth_headers)

    assert response.status_code == 200
    items = response.json()["items"]
    assert len(items) == 1
    assert items[0]["attempt_id"] == newer_wrong.json()["id"]
    assert items[0]["correct_answer"] == "Use least privilege"

def test_wrong_answers_do_not_join_question_drafts_across_projects(
    client: TestClient, auth_headers
) -> None:
    owner_project_id = _create_project(client, auth_headers)
    foreign_project_id = _create_project(client, auth_headers)
    foreign_document_id = _upload_document(client, auth_headers, foreign_project_id)
    foreign_question = _create_manual_question(
        client,
        auth_headers,
        foreign_project_id,
        foreign_document_id,
    )
    session_id = str(uuid4())
    attempt_id = str(uuid4())
    now = "2026-06-11T00:20:00+00:00"

    with client.app.state.database.connect() as connection:
        connection.execute(
            """
            INSERT INTO practice_sessions(
                id, project_id, question_ids_json, mode, source_document_id,
                requested_question_count, random_seed, status, created_at, completed_at
            )
            VALUES (?, ?, ?, 'random_draw', NULL, 1, NULL, 'active', ?, NULL)
            """,
            (session_id, owner_project_id, json.dumps([foreign_question["id"]]), now),
        )
        connection.execute(
            """
            INSERT INTO practice_attempts(
                id, session_id, project_id, question_id, selected_answer,
                is_correct, created_at
            )
            VALUES (?, ?, ?, ?, ?, 0, ?)
            """,
            (
                attempt_id,
                session_id,
                owner_project_id,
                foreign_question["id"],
                "Allow unrestricted access",
                now,
            ),
        )

    response = client.get(
        f"/projects/{owner_project_id}/wrong-answers",
        headers=auth_headers,
    )

    assert response.status_code == 200
    assert response.json()["items"] == []
