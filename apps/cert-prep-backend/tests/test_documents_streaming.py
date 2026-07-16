from pathlib import Path

from fastapi.testclient import TestClient

from conftest import minimal_pdf
from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.mock_exams import draft_jobs
from cert_prep_backend.domains.mock_exams.streaming import (
    _call_streaming_provider_method,
    _provider_starts_on_generation,
)
from document_test_helpers import (
    _create_project,
    _draft_job_statuses,
    _wait_for_draft_jobs,
    _wait_for_document_progress,
    _wait_for_document_status,
    _wait_for_question_drafts,
)
from document_test_llm_fakes import (
    FailingExamProvider,
    FastFirstCompletionExamProvider,
    InvalidJsonReasoningExamProvider,
    MissingModelExamProvider,
    MockExamProvider,
    ReleaseRecordingProvider,
    ReleaseKeepAliveRecordingOllamaProvider,
    TimeoutReasoningExamProvider,
)
from document_test_ocr_fakes import (
    BlockingExamFirstPageOcrProvider,
    JlptBlockOcrProvider,
    NoticePageOcrProvider,
)


def test_streaming_generation_startup_uses_provider_capability() -> None:
    class CustomStartsOnGenerationProvider:
        provider = "custom-local-llm"

        @property
        def starts_on_generation(self) -> bool:
            return True

    class NameOnlyProvider:
        provider = "future-provider"
        auto_start_server = True

    assert _provider_starts_on_generation(CustomStartsOnGenerationProvider()) is True
    assert _provider_starts_on_generation(NameOnlyProvider()) is False


def test_streaming_generation_kwargs_are_provider_owned() -> None:
    class CustomStreamingOptionsProvider:
        provider = "custom-local-llm"

        def __init__(self) -> None:
            self.keep_alive_values: list[object] = []

        def streaming_generation_kwargs(self) -> dict[str, int]:
            return {"keep_alive": 0}

        def complete(self, *, keep_alive=None):
            self.keep_alive_values.append(keep_alive)
            return "ok"

    provider = CustomStreamingOptionsProvider()

    result = _call_streaming_provider_method(provider, provider.complete)

    assert result == "ok"
    assert provider.keep_alive_values == [0]


def test_streaming_draft_job_waits_until_document_is_ready(
    tmp_path: Path,
    auth_headers,
) -> None:
    ocr_provider = BlockingExamFirstPageOcrProvider()
    llm_provider = MockExamProvider()
    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                ocr_page_workers=2,
                streaming_draft_generation_on_upload=True,
                streaming_draft_generation_page_limit=1,
            ),
            llm_provider=llm_provider,
            ocr_provider=ocr_provider,
            document_processing_async_jobs=True,
            streaming_draft_generation_async_jobs=False,
        )
    )
    project_id = _create_project(client, auth_headers)

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("scan.pdf", minimal_pdf("", ""), "application/pdf")},
    )

    assert response.status_code == 201
    document = response.json()
    assert document["status"] == "processing"
    assert ocr_provider.page_one_started.wait(timeout=2)
    try:
        assert ocr_provider.page_two_finished.wait(timeout=2)
        partial = _wait_for_document_progress(
            client,
            auth_headers,
            project_id,
            document["id"],
            processed_page_count=1,
            chunks_count=1,
        )
        assert partial["status"] == "processing"
        assert _draft_job_statuses(
            client, auth_headers, project_id, document["id"]
        ) == []
        drafts = client.get(f"/projects/{project_id}/question-drafts", headers=auth_headers)
        assert drafts.status_code == 200
        assert drafts.json()["items"] == []
    finally:
        ocr_provider.release_page_one.set()

    ready = _wait_for_document_status(client, auth_headers, project_id, document["id"], "ready")
    assert ready["chunks_count"] == 2
    jobs = _wait_for_draft_jobs(
        client,
        auth_headers,
        project_id,
        document["id"],
        status="succeeded",
    )
    assert len(jobs) == 1
    assert jobs[0]["generated_count"] == 1

    drafts = _wait_for_question_drafts(client, auth_headers, project_id, count=1)
    assert drafts[0]["status"] == "approved"
    assert drafts[0]["citation_page"] == 1
    assert drafts[0]["answer_key_source"] == "ai_inferred"


def test_streaming_draft_generation_skips_notice_pages(
    tmp_path: Path,
    auth_headers,
) -> None:
    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                streaming_draft_generation_on_upload=True,
            ),
            llm_provider=FailingExamProvider(),
            ocr_provider=NoticePageOcrProvider(),
            document_processing_async_jobs=False,
            streaming_draft_generation_async_jobs=False,
        )
    )
    project_id = _create_project(client, auth_headers)

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("notice.pdf", minimal_pdf(""), "application/pdf")},
    )

    assert response.status_code == 201
    document = response.json()
    assert document["status"] == "ready"
    assert document["chunks_count"] == 1

    jobs = client.get(
        f"/projects/{project_id}/documents/{document['id']}/draft-jobs",
        headers=auth_headers,
    )
    assert jobs.status_code == 200
    assert jobs.json()["items"] == []

    drafts = client.get(f"/projects/{project_id}/question-drafts", headers=auth_headers)
    assert drafts.status_code == 200
    assert drafts.json()["items"] == []


def test_streaming_draft_generation_uses_fast_first_completion_before_reasoning(
    tmp_path: Path,
    auth_headers,
) -> None:
    llm_provider = FastFirstCompletionExamProvider()
    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                streaming_draft_generation_on_upload=True,
                streaming_draft_generation_page_limit=3,
            ),
            llm_provider=llm_provider,
            ocr_provider=JlptBlockOcrProvider(),
            document_processing_async_jobs=False,
            streaming_draft_generation_async_jobs=False,
        )
    )
    project_id = _create_project(client, auth_headers)

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("scan.pdf", minimal_pdf(""), "application/pdf")},
    )

    assert response.status_code == 201
    document = response.json()
    assert document["status"] == "ready"
    assert llm_provider.fast_first_calls == [
        {
            "page_numbers": [1],
            "question": "余暇の楽しみ方はいろいろある。",
        }
    ]
    assert llm_provider.reasoning_calls == []
    jobs = client.get(
        f"/projects/{project_id}/documents/{document['id']}/draft-jobs",
        headers=auth_headers,
    ).json()["items"]
    assert jobs[0]["status"] == "succeeded"
    assert jobs[0]["generated_count"] == 1


def test_streaming_draft_generation_releases_ollama_model_after_completion(
    tmp_path: Path,
    auth_headers,
) -> None:
    llm_provider = ReleaseKeepAliveRecordingOllamaProvider()
    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                streaming_draft_generation_on_upload=True,
                streaming_draft_generation_page_limit=1,
            ),
            llm_provider=llm_provider,
            ocr_provider=JlptBlockOcrProvider(),
            document_processing_async_jobs=False,
            streaming_draft_generation_async_jobs=False,
        )
    )
    project_id = _create_project(client, auth_headers)

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("scan.pdf", minimal_pdf(""), "application/pdf")},
    )

    assert response.status_code == 201
    document = response.json()
    jobs = client.get(
        f"/projects/{project_id}/documents/{document['id']}/draft-jobs",
        headers=auth_headers,
    ).json()["items"]
    assert jobs[0]["status"] == "succeeded"
    assert jobs[0]["generated_count"] == 1
    assert llm_provider.fast_first_keep_alive_values == [0]
    assert llm_provider.reasoning_keep_alive_values == [0]


def test_streaming_draft_generation_releases_provider_resources_after_completion(
    tmp_path: Path,
    auth_headers,
) -> None:
    llm_provider = ReleaseRecordingProvider()
    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                streaming_draft_generation_on_upload=True,
                streaming_draft_generation_page_limit=1,
            ),
            llm_provider=llm_provider,
            ocr_provider=JlptBlockOcrProvider(),
            document_processing_async_jobs=False,
            streaming_draft_generation_async_jobs=False,
        )
    )
    project_id = _create_project(client, auth_headers)

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("scan.pdf", minimal_pdf(""), "application/pdf")},
    )

    assert response.status_code == 201
    document = response.json()
    jobs = client.get(
        f"/projects/{project_id}/documents/{document['id']}/draft-jobs",
        headers=auth_headers,
    ).json()["items"]
    assert jobs[0]["status"] == "succeeded"
    assert jobs[0]["generated_count"] == 1
    assert jobs[0]["provider"] == "future-provider"
    assert jobs[0]["model"] == "future-model"
    assert jobs[0]["effective_provider"] == "future-provider"
    assert jobs[0]["effective_model"] == "future-model-fallback"
    assert "using fallback future-model-fallback" in jobs[0]["fallback_reason"]
    assert llm_provider.release_calls == 1


def test_streaming_draft_generation_treats_invalid_json_as_empty_page(
    tmp_path: Path,
    auth_headers,
) -> None:
    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                streaming_draft_generation_on_upload=True,
                streaming_draft_generation_page_limit=1,
            ),
            llm_provider=InvalidJsonReasoningExamProvider(),
            ocr_provider=JlptBlockOcrProvider(),
            document_processing_async_jobs=False,
            streaming_draft_generation_async_jobs=False,
        )
    )
    project_id = _create_project(client, auth_headers)

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("scan.pdf", minimal_pdf(""), "application/pdf")},
    )

    assert response.status_code == 201
    document = response.json()
    assert document["status"] == "ready"

    jobs = client.get(
        f"/projects/{project_id}/documents/{document['id']}/draft-jobs",
        headers=auth_headers,
    ).json()["items"]
    assert jobs[0]["status"] == "succeeded"
    assert jobs[0]["generated_count"] == 0
    assert jobs[0]["last_error"] is None

    drafts = client.get(f"/projects/{project_id}/question-drafts", headers=auth_headers)
    assert drafts.status_code == 200
    assert drafts.json()["items"] == []


def test_streaming_draft_generation_treats_timeout_as_empty_page(
    tmp_path: Path,
    auth_headers,
) -> None:
    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                streaming_draft_generation_on_upload=True,
                streaming_draft_generation_page_limit=1,
            ),
            llm_provider=TimeoutReasoningExamProvider(),
            ocr_provider=JlptBlockOcrProvider(),
            document_processing_async_jobs=False,
            streaming_draft_generation_async_jobs=False,
        )
    )
    project_id = _create_project(client, auth_headers)

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("scan.pdf", minimal_pdf(""), "application/pdf")},
    )

    assert response.status_code == 201
    document = response.json()
    assert document["status"] == "ready"

    jobs = client.get(
        f"/projects/{project_id}/documents/{document['id']}/draft-jobs",
        headers=auth_headers,
    ).json()["items"]
    assert jobs[0]["status"] == "succeeded"
    assert jobs[0]["generated_count"] == 0
    assert jobs[0]["last_error"] is None

    drafts = client.get(f"/projects/{project_id}/question-drafts", headers=auth_headers)
    assert drafts.status_code == 200
    assert drafts.json()["items"] == []


def test_streaming_draft_async_job_thread_creates_draft(
    tmp_path: Path,
    auth_headers,
) -> None:
    with TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                streaming_draft_generation_on_upload=True,
                streaming_draft_generation_page_limit=1,
            ),
            llm_provider=MockExamProvider(),
            ocr_provider=JlptBlockOcrProvider(),
            document_processing_async_jobs=False,
        )
    ) as client:
        project_id = _create_project(client, auth_headers)

        response = client.post(
            f"/projects/{project_id}/documents",
            headers=auth_headers,
            files={"file": ("scan.pdf", minimal_pdf(""), "application/pdf")},
        )

        assert response.status_code == 201
        document = response.json()
        assert document["status"] == "ready"

        drafts = _wait_for_question_drafts(client, auth_headers, project_id, count=1)
        assert drafts[0]["citation_page"] == 1
        jobs = client.get(
            f"/projects/{project_id}/documents/{document['id']}/draft-jobs",
            headers=auth_headers,
        ).json()["items"]
        assert jobs[0]["status"] == "succeeded"
        assert jobs[0]["generated_count"] == 1


def test_streaming_draft_job_records_missing_model_without_blocking_parse(
    tmp_path: Path,
    auth_headers,
) -> None:
    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                streaming_draft_generation_on_upload=True,
            ),
            llm_provider=MissingModelExamProvider(),
            ocr_provider=JlptBlockOcrProvider(),
            document_processing_async_jobs=False,
            streaming_draft_generation_async_jobs=False,
        )
    )
    project_id = _create_project(client, auth_headers)

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("scan.pdf", minimal_pdf(""), "application/pdf")},
    )

    assert response.status_code == 201
    document = response.json()
    assert document["status"] == "ready"
    assert document["chunks_count"] == 1

    jobs = client.get(
        f"/projects/{project_id}/documents/{document['id']}/draft-jobs",
        headers=auth_headers,
    )
    assert jobs.status_code == 200
    assert jobs.json()["items"][0]["status"] == "skipped_missing_model"
    assert jobs.json()["items"][0]["last_error"] == "model not found"

    drafts = client.get(f"/projects/{project_id}/question-drafts", headers=auth_headers)
    assert drafts.status_code == 200
    assert drafts.json()["items"] == []


def test_streaming_draft_retry_requeues_missing_model_job_after_qwen_available(
    tmp_path: Path,
    auth_headers,
) -> None:
    missing_model_client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                streaming_draft_generation_on_upload=True,
            ),
            llm_provider=MissingModelExamProvider(),
            ocr_provider=JlptBlockOcrProvider(),
            document_processing_async_jobs=False,
            streaming_draft_generation_async_jobs=False,
        )
    )
    project_id = _create_project(missing_model_client, auth_headers)

    response = missing_model_client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("scan.pdf", minimal_pdf(""), "application/pdf")},
    )

    assert response.status_code == 201
    document = response.json()
    assert _draft_job_statuses(
        missing_model_client, auth_headers, project_id, document["id"]
    ) == ["skipped_missing_model"]

    available_model_client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                streaming_draft_generation_on_upload=True,
                streaming_draft_generation_page_limit=1,
            ),
            llm_provider=MockExamProvider(),
            ocr_provider=JlptBlockOcrProvider(),
            document_processing_async_jobs=False,
            streaming_draft_generation_async_jobs=False,
        )
    )

    retry_response = available_model_client.post(
        f"/projects/{project_id}/documents/{document['id']}/draft-jobs/retry",
        headers=auth_headers,
    )

    assert retry_response.status_code == 202
    retried_job = retry_response.json()["items"][0]
    assert retried_job["status"] == "succeeded"
    assert retried_job["generated_count"] == 1
    assert retried_job["retry_count"] == 1
    assert retried_job["last_error"] is None
    assert retried_job["provider"] == MockExamProvider.provider
    assert retried_job["model"] == MockExamProvider.model

    drafts = available_model_client.get(
        f"/projects/{project_id}/question-drafts",
        headers=auth_headers,
    ).json()["items"]
    assert len(drafts) == 1
    assert drafts[0]["status"] == "approved"
    assert drafts[0]["citation_page"] == 1

    idempotent_retry = available_model_client.post(
        f"/projects/{project_id}/documents/{document['id']}/draft-jobs/retry",
        headers=auth_headers,
    )

    assert idempotent_retry.status_code == 202
    assert idempotent_retry.json()["items"][0]["status"] == "succeeded"
    assert idempotent_retry.json()["items"][0]["retry_count"] == 1
    drafts_after_second_retry = available_model_client.get(
        f"/projects/{project_id}/question-drafts",
        headers=auth_headers,
    ).json()["items"]
    assert len(drafts_after_second_retry) == 1


def test_streaming_draft_recovery_resumes_interrupted_running_job(
    tmp_path: Path,
    auth_headers,
) -> None:
    initial_client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            ocr_provider=JlptBlockOcrProvider(),
            document_processing_async_jobs=False,
        )
    )
    project_id = _create_project(initial_client, auth_headers)

    response = initial_client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("scan.pdf", minimal_pdf(""), "application/pdf")},
    )

    assert response.status_code == 201
    document = response.json()
    chunks = initial_client.get(
        f"/projects/{project_id}/documents/{document['id']}/chunks",
        headers=auth_headers,
    ).json()["items"]
    assert len(chunks) == 1

    job = draft_jobs.enqueue_chunk_job(
        initial_client.app.state.database,
        project_id=project_id,
        document_id=document["id"],
        chunk_id=chunks[0]["id"],
        page_number=chunks[0]["page_number"],
        strategy="hybrid_reasoning",
        provider="ollama",
        model="qwen3.5:4b",
    )
    draft_jobs.mark_running(initial_client.app.state.database, job["id"])

    recovered_client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                streaming_draft_generation_on_upload=True,
                streaming_draft_generation_page_limit=1,
            ),
            llm_provider=MockExamProvider(),
            ocr_provider=JlptBlockOcrProvider(),
            document_processing_async_jobs=False,
            streaming_draft_generation_async_jobs=False,
        )
    )

    jobs = recovered_client.get(
        f"/projects/{project_id}/documents/{document['id']}/draft-jobs",
        headers=auth_headers,
    )
    assert jobs.status_code == 200
    recovered_job = jobs.json()["items"][0]
    assert recovered_job["status"] == "succeeded"
    assert recovered_job["generated_count"] == 1
    assert recovered_job["last_error"] is None

    drafts = recovered_client.get(
        f"/projects/{project_id}/question-drafts",
        headers=auth_headers,
    )
    assert drafts.status_code == 200
    assert drafts.json()["items"][0]["status"] == "approved"
    assert drafts.json()["items"][0]["citation_page"] == 1
