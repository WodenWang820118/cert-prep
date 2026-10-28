"""Correcting an answer key regrades the question and clears it from the wrong-answer list."""

from fastapi.testclient import TestClient

from practice_test_support import _create_manual_question, _create_project, _upload_document


def test_regrade_clears_a_wrong_answer_after_the_draft_key_is_corrected(
    client: TestClient, auth_headers
) -> None:
    project_id = _create_project(client, auth_headers)
    document_id = _upload_document(client, auth_headers, project_id)
    question = _create_manual_question(client, auth_headers, project_id, document_id)
    session = client.post(
        f"/projects/{project_id}/practice-sessions",
        headers=auth_headers,
        json={"question_count": 1},
    )
    assert session.status_code == 201

    attempt = client.post(
        f"/projects/{project_id}/practice-sessions/{session.json()['id']}/attempts",
        headers=auth_headers,
        json={
            "question_id": question["id"],
            "selected_answer": "Allow unrestricted access",
        },
    )
    assert attempt.status_code == 201
    assert attempt.json()["is_correct"] is False

    corrected = client.patch(
        f"/projects/{project_id}/question-drafts/{question['id']}",
        headers=auth_headers,
        json={"answer": "Allow unrestricted access", "answer_key_source": "manual"},
    )
    assert corrected.status_code == 200
    assert corrected.json()["answer"] == "Allow unrestricted access"

    before = client.get(f"/projects/{project_id}/wrong-answers", headers=auth_headers)
    assert before.status_code == 200
    assert question["id"] in {item["question_id"] for item in before.json()["items"]}

    regrade = client.post(
        f"/projects/{project_id}/practice-questions/{question['id']}/regrade",
        headers=auth_headers,
    )
    assert regrade.status_code == 200
    assert regrade.json() == {
        "question_id": question["id"],
        "regraded_attempts": 1,
        "latest_attempt_wrong": False,
    }

    wrong_answers = client.get(f"/projects/{project_id}/wrong-answers", headers=auth_headers)
    assert wrong_answers.status_code == 200
    assert question["id"] not in {
        item["question_id"] for item in wrong_answers.json()["items"]
    }


def test_a_corrected_key_reaches_the_wrong_answer_that_was_graded_against_the_old_key(
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
        json={"question_id": question["id"], "selected_answer": "Use least privilege"},
    )
    assert attempt.json()["is_correct"] is True

    corrected = client.patch(
        f"/projects/{project_id}/question-drafts/{question['id']}",
        headers=auth_headers,
        json={
            "answer": "Allow unrestricted access",
            "answer_key_source": "manual",
            "rationale": "",
        },
    )
    assert corrected.status_code == 200
    regrade = client.post(
        f"/projects/{project_id}/practice-questions/{question['id']}/regrade",
        headers=auth_headers,
    )
    assert regrade.json()["latest_attempt_wrong"] is True

    items = client.get(f"/projects/{project_id}/wrong-answers", headers=auth_headers).json()["items"]
    assert [item["question_id"] for item in items] == [question["id"]]
    assert items[0]["correct_answer"] == "Allow unrestricted access"
    assert not items[0]["rationale"]
    assert items[0]["answer_key_source"] == "manual"
