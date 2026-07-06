from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient

from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings
from conftest import AUTH_TOKEN
from practice_test_support import (
    UnavailableExplanationProvider,
    _create_manual_question,
    _create_project,
    _upload_document,
)


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
