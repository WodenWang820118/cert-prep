import time

from fastapi.testclient import TestClient


def _create_project(client: TestClient, auth_headers) -> str:
    response = client.post("/projects", headers=auth_headers, json={"name": "CISSP"})
    assert response.status_code == 201
    return response.json()["id"]


def _wait_for_document_status(
    client: TestClient,
    auth_headers,
    project_id: str,
    document_id: str,
    status: str,
) -> dict:
    deadline = time.monotonic() + 5
    latest: dict | None = None
    while time.monotonic() < deadline:
        response = client.get(
            f"/projects/{project_id}/documents/{document_id}",
            headers=auth_headers,
        )
        assert response.status_code == 200
        latest = response.json()
        if latest["status"] == status:
            return latest
        time.sleep(0.05)
    raise AssertionError(f"Document did not reach {status}: {latest}")


def _wait_for_document_progress(
    client: TestClient,
    auth_headers,
    project_id: str,
    document_id: str,
    *,
    processed_page_count: int,
    chunks_count: int,
) -> dict:
    deadline = time.monotonic() + 5
    latest: dict | None = None
    while time.monotonic() < deadline:
        response = client.get(
            f"/projects/{project_id}/documents/{document_id}",
            headers=auth_headers,
        )
        assert response.status_code == 200
        latest = response.json()
        if (
            latest["processed_page_count"] == processed_page_count
            and latest["chunks_count"] == chunks_count
        ):
            return latest
        time.sleep(0.05)
    raise AssertionError(
        "Document did not reach progress "
        f"processed_page_count={processed_page_count}, chunks_count={chunks_count}: {latest}"
    )


def _wait_for_question_drafts(
    client: TestClient,
    auth_headers,
    project_id: str,
    *,
    count: int,
) -> list[dict]:
    deadline = time.monotonic() + 5
    latest: list[dict] = []
    while time.monotonic() < deadline:
        response = client.get(f"/projects/{project_id}/question-drafts", headers=auth_headers)
        assert response.status_code == 200
        latest = response.json()["items"]
        if len(latest) >= count:
            return latest
        time.sleep(0.05)
    raise AssertionError(f"Question drafts did not reach count={count}: {latest}")


def _draft_job_statuses(
    client: TestClient,
    auth_headers,
    project_id: str,
    document_id: str,
) -> list[str]:
    response = client.get(
        f"/projects/{project_id}/documents/{document_id}/draft-jobs",
        headers=auth_headers,
    )
    assert response.status_code == 200
    return [job["status"] for job in response.json()["items"]]
