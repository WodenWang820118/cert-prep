"""Uploading a document queues streaming draft jobs for its exam-like chunks."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from cert_prep_backend.api.app import create_app
from cert_prep_backend.platform.config import Settings
from conftest import AUTH_TOKEN, TestCaptureRuntimeClient, minimal_pdf

EXAM_PAGE = (
    "Mondai 1 Choose the best reading. 1 Correct reading? 1 seikai 2 gotou 3 betsu 4 hoka "
    "2 Another reading? 1 ichi 2 ni 3 san 4 yon"
)


def test_upload_queues_a_draft_job_for_each_exam_chunk(tmp_path: Path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        api_token=AUTH_TOKEN,
        llm_provider="fake",
        streaming_draft_generation_on_upload=True,
        streaming_draft_generation_strategy="deterministic_only",
    )
    headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
    with TestClient(
        create_app(
            settings=settings,
            capture_runtime_client=TestCaptureRuntimeClient(),
            document_processing_async_jobs=False,
            streaming_draft_generation_async_jobs=False,
        )
    ) as client:
        project_id = client.post("/projects", headers=headers, json={"name": "Exam"}).json()["id"]
        document = client.post(
            f"/projects/{project_id}/documents",
            headers=headers,
            files={"file": ("exam.pdf", minimal_pdf(EXAM_PAGE, "Page two."), "application/pdf")},
        ).json()
        chunks = client.get(
            f"/projects/{project_id}/documents/{document['id']}/chunks", headers=headers
        ).json()["items"]
        jobs = client.get(
            f"/projects/{project_id}/documents/{document['id']}/draft-jobs", headers=headers
        ).json()["items"]

    exam_chunk = next(chunk for chunk in chunks if chunk["page_number"] == 1)
    assert [(job["chunk_id"], job["page_number"]) for job in jobs] == [(exam_chunk["id"], 1)]
