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
