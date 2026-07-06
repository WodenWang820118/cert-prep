import json
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient

from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.mock_exams.ports import ProviderHealth

from conftest import AUTH_TOKEN
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


def test_wrong_answer_summary_groups_current_cleared_and_repeated_misses(
    client: TestClient, auth_headers
) -> None:
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


def test_wrong_answer_explanation_uses_current_grounded_fields(
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
    attempt = client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
        headers=auth_headers,
        json={
            "question_id": question["id"],
            "selected_answer": "Allow unrestricted access",
        },
    )
    assert attempt.status_code == 201
    attempt_id = attempt.json()["id"]

    response = client.post(
        f"/projects/{project_id}/wrong-answers/{attempt_id}/explanation",
        headers=auth_headers,
    )

    assert response.status_code == 200
    explanation = response.json()
    assert explanation["attempt_id"] == attempt_id
    assert explanation["provider"] == "fake"
    assert explanation["fallback"] is False
    assert "Allow unrestricted access" in explanation["explanation"]
    assert "Use least privilege" in explanation["explanation"]
    assert explanation["grounded_fields"] == {
        "question": "Which access model should be applied?",
        "selected_answer": "Allow unrestricted access",
        "correct_answer": "Use least privilege",
        "rationale": "The document says permissions should remain scoped.",
        "citation_page": 1,
        "source_excerpt": "Least privilege keeps cloud permissions scoped.",
    }


def test_wrong_answer_explanation_returns_not_found_after_attempt_is_cleared(
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
    corrected = client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
        headers=auth_headers,
        json={
            "question_id": question["id"],
            "selected_answer": "Use least privilege",
        },
    )
    assert corrected.status_code == 201
    assert corrected.json()["is_correct"] is True

    response = client.post(
        f"/projects/{project_id}/wrong-answers/{wrong_attempt['id']}/explanation",
        headers=auth_headers,
    )

    assert response.status_code == 404
    assert response.json() == {
        "code": "not_found",
        "message": "Wrong answer not found.",
    }


def test_wrong_answer_explanation_returns_not_found_for_cross_project_attempt(
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
    attempt = client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
        headers=auth_headers,
        json={
            "question_id": question["id"],
            "selected_answer": "Allow unrestricted access",
        },
    ).json()
    other_project_id = _create_project(client, auth_headers)

    response = client.post(
        f"/projects/{other_project_id}/wrong-answers/{attempt['id']}/explanation",
        headers=auth_headers,
    )

    assert response.status_code == 404
    assert response.json() == {
        "code": "not_found",
        "message": "Wrong answer not found.",
    }


def test_wrong_answer_explanation_uses_targeted_attempt_lookup(
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
    attempt = client.post(
        f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
        headers=auth_headers,
        json={
            "question_id": question["id"],
            "selected_answer": "Allow unrestricted access",
        },
    ).json()

    now = "2026-06-11T00:10:00+00:00"
    corrupt_question_id = str(uuid4())
    with client.app.state.database.connect() as connection:
        connection.execute(
            """
            INSERT INTO question_drafts(
                id, project_id, document_id, chunk_id, question, choices_json, answer,
                rationale, citation_page, source_excerpt, status, created_at, updated_at
            )
            VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'approved', ?, ?)
            """,
            (
                corrupt_question_id,
                project_id,
                document_id,
                "Malformed unrelated question?",
                "not-json",
                "Correct",
                "This row should not be loaded for the target attempt.",
                1,
                "Malformed fixture.",
                now,
                now,
            ),
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
                str(uuid4()),
                session["id"],
                project_id,
                corrupt_question_id,
                "Wrong",
                now,
            ),
        )

    response = client.post(
        f"/projects/{project_id}/wrong-answers/{attempt['id']}/explanation",
        headers=auth_headers,
    )

    assert response.status_code == 200
    assert response.json()["attempt_id"] == attempt["id"]


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


def test_wrong_answer_explanation_falls_back_when_provider_unavailable(
    tmp_path: Path, auth_headers
) -> None:
    settings = Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake")
    with TestClient(
        create_app(
            settings=settings,
            llm_provider=UnavailableExplanationProvider(),
            document_processing_async_jobs=False,
        )
    ) as test_client:
        project_id = _create_project(test_client, auth_headers)
        document_id = _upload_document(test_client, auth_headers, project_id)
        question = _create_manual_question(test_client, auth_headers, project_id, document_id)
        session = test_client.post(
            f"/projects/{project_id}/practice-sessions",
            headers=auth_headers,
            json={"question_count": 1},
        ).json()
        attempt = test_client.post(
            f"/projects/{project_id}/practice-sessions/{session['id']}/attempts",
            headers=auth_headers,
            json={
                "question_id": question["id"],
                "selected_answer": "Allow unrestricted access",
            },
        ).json()

        response = test_client.post(
            f"/projects/{project_id}/wrong-answers/{attempt['id']}/explanation",
            headers=auth_headers,
        )

    assert response.status_code == 200
    explanation = response.json()
    assert explanation["provider"] == "unavailable-test"
    assert explanation["model"] == "missing-model"
    assert explanation["fallback"] is True
    assert explanation["grounded_fields"]["selected_answer"] == "Allow unrestricted access"
    assert explanation["grounded_fields"]["correct_answer"] == "Use least privilege"
    assert "Use least privilege" in explanation["explanation"]


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


_USE_CHUNK_EVIDENCE = object()


def _create_manual_question(
    client: TestClient,
    auth_headers,
    project_id: str,
    document_id: str,
    *,
    question: str = "Which access model should be applied?",
    choices: list[str] | None = None,
    answer: str | None = "Use least privilege",
    rationale: str | None = "The document says permissions should remain scoped.",
    citation_page: int | None | object = _USE_CHUNK_EVIDENCE,
    source_excerpt: str | None | object = _USE_CHUNK_EVIDENCE,
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
            "choices": choices or ["Use least privilege", "Allow unrestricted access"],
            "answer": answer,
            "rationale": rationale,
            "document_id": document_id,
            "chunk_id": chunk["id"],
            "citation_page": (
                chunk["page_number"]
                if citation_page is _USE_CHUNK_EVIDENCE
                else citation_page
            ),
            "source_excerpt": (
                chunk["source_excerpt"]
                if source_excerpt is _USE_CHUNK_EVIDENCE
                else source_excerpt
            ),
            "source_order": source_order,
            "item_kind": "vocabulary_single",
        },
    )
    assert created.status_code == 201
    assert created.json()["status"] == "approved"
    return created.json()


class UnavailableExplanationProvider:
    provider = "unavailable-test"
    model = "missing-model"

    def health(self) -> ProviderHealth:
        return ProviderHealth(
            provider=self.provider,
            model=self.model,
            available=False,
            detail="provider unavailable",
            unavailable_reason="provider_unavailable",
        )

    def generate_drafts(self, chunks, limit):
        raise AssertionError("explanation fallback must not generate drafts")
