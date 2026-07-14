from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from threading import Event
import time

import pytest
from fastapi.testclient import TestClient

from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.mock_exams import draft_jobs, manual_operations
from cert_prep_backend.domains.mock_exams import repository as drafts_repository
from cert_prep_backend.domains.mock_exams.models import DraftSuggestion
from cert_prep_backend.domains.mock_exams.ports import ProviderHealth
from cert_prep_backend.domains.runtime_installations import RuntimeInstallationManager
from cert_prep_backend.domains.source_documents.ocr import OCRHealth, OCRPageResult
from cert_prep_backend.persistence.database import Database
from cert_prep_contracts.runtime import (
    RuntimeInstallationStatus,
    RuntimeInstallProgress,
    RuntimeRequirementKind,
    RuntimeRequirementSnapshot,
)
from conftest import minimal_pdf


AUTH_HEADERS = {"Authorization": "Bearer test-token"}


def test_pending_draft_job_delete_is_idempotently_canceled(client, auth_headers) -> None:
    project_id, document_id, chunk = _source_chunk(client, auth_headers)
    job = _enqueue(client, project_id, document_id, chunk)
    endpoint = (
        f"/projects/{project_id}/documents/{document_id}/draft-jobs/{job['id']}"
    )

    first = client.delete(endpoint, headers=auth_headers)
    second = client.delete(endpoint, headers=auth_headers)

    assert first.status_code == 200
    assert first.json()["status"] == "canceled"
    assert first.json()["phase"] == "canceled"
    assert first.json()["cancellable"] is False
    assert second.json() == first.json()
    persisted = draft_jobs.mark_failed(
        client.app.state.database,
        job["id"],
        detail="late worker failure",
    )
    assert persisted["status"] == "canceled"


def test_cancel_wins_before_draft_commit_and_rolls_back_inserts(
    client,
    auth_headers,
) -> None:
    project_id, document_id, chunk = _source_chunk(client, auth_headers)
    job = _enqueue(client, project_id, document_id, chunk)
    draft_jobs.mark_running(client.app.state.database, job["id"])

    canceled = draft_jobs.request_cancel(
        client.app.state.database,
        project_id=project_id,
        document_id=document_id,
        job_id=job["id"],
    )
    assert canceled["status"] == "cancel_requested"
    assert canceled["cancellable"] is False

    with pytest.raises(draft_jobs.DraftJobCanceledError):
        drafts_repository.append_generated_drafts_and_complete_job(
            client.app.state.database,
            job_id=job["id"],
            project_id=project_id,
            document_id=document_id,
            suggestions=[_suggestion(chunk)],
            effective_provider="fastflowlm",
            effective_model="qwen3.5:4b",
            fallback_reason=None,
        )

    draft_jobs.mark_canceled(client.app.state.database, job["id"])
    assert drafts_repository.list_drafts(client.app.state.database, project_id) == []
    assert draft_jobs.get_job(client.app.state.database, job["id"])["status"] == "canceled"


def test_draft_commit_phase_rejects_cancel_and_terminal_delete_is_idempotent(
    client,
    auth_headers,
) -> None:
    project_id, document_id, chunk = _source_chunk(client, auth_headers)
    job = _enqueue(client, project_id, document_id, chunk)
    draft_jobs.mark_running(client.app.state.database, job["id"])
    committing = draft_jobs.begin_commit(client.app.state.database, job["id"])
    assert committing["phase"] == "committing"
    assert committing["cancellable"] is False

    endpoint = (
        f"/projects/{project_id}/documents/{document_id}/draft-jobs/{job['id']}"
    )
    rejected = client.delete(endpoint, headers=auth_headers)
    assert rejected.status_code == 409
    assert rejected.json()["code"] == "operation_not_cancellable"

    drafts_repository.append_generated_drafts_and_complete_job(
        client.app.state.database,
        job_id=job["id"],
        project_id=project_id,
        document_id=document_id,
        suggestions=[_suggestion(chunk)],
        effective_provider="fastflowlm",
        effective_model="qwen3.5:4b",
        fallback_reason=None,
    )
    terminal = client.delete(endpoint, headers=auth_headers)
    assert terminal.status_code == 200
    assert terminal.json()["status"] == "succeeded"
    assert terminal.json()["phase"] == "completed"


def test_runtime_delete_cancels_owned_running_installer(tmp_path: Path) -> None:
    installer = BlockingInstaller(RuntimeRequirementKind.WINDOWSML_OCR)
    manager = _runtime_manager(tmp_path, installer)
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            runtime_installation_manager=manager,
        )
    )

    started = client.post(
        "/runtime/installations/windowsml_ocr",
        headers=AUTH_HEADERS,
    )
    assert started.status_code == 202
    assert installer.started.wait(timeout=2)

    canceled = client.delete(
        f"/runtime/installations/{started.json()['id']}",
        headers=AUTH_HEADERS,
    )
    assert canceled.status_code == 200
    assert canceled.json()["status"] == "cancel_requested"
    assert canceled.json()["cancellable"] is False
    assert installer.cancel_called.wait(timeout=2)

    terminal = _wait_for_runtime_status(
        client,
        f"/runtime/installations/{started.json()['id']}",
        "canceled",
    )
    assert terminal["phase"] == "canceled"
    assert terminal["cancellable"] is False
    repeated = client.delete(
        f"/runtime/installations/{started.json()['id']}",
        headers=AUTH_HEADERS,
    )
    assert repeated.json()["status"] == "canceled"


def test_model_commit_phase_returns_409_then_cannot_reverse_success(tmp_path: Path) -> None:
    installer = BlockingInstaller(
        RuntimeRequirementKind.OLLAMA_MODEL,
        commit_phase=True,
    )
    manager = _runtime_manager(tmp_path, installer)
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            runtime_installation_manager=manager,
        )
    )

    started = client.post("/llm/model-downloads", headers=AUTH_HEADERS)
    assert installer.started.wait(timeout=2)
    rejected = client.delete(
        f"/llm/model-downloads/{started.json()['id']}",
        headers=AUTH_HEADERS,
    )
    assert rejected.status_code == 409
    assert rejected.json()["code"] == "operation_not_cancellable"
    committing = client.get(
        f"/llm/model-downloads/{started.json()['id']}",
        headers=AUTH_HEADERS,
    ).json()
    commit_started_at = committing["commit_started_at"]
    assert commit_started_at is not None
    datetime.fromisoformat(commit_started_at)

    installer.release.set()
    terminal = _wait_for_runtime_status(
        client,
        f"/llm/model-downloads/{started.json()['id']}",
        "succeeded",
    )
    assert terminal["phase"] == "completed"
    assert terminal["cancellable"] is False
    assert terminal["commit_started_at"] == commit_started_at
    repeated = client.delete(
        f"/llm/model-downloads/{started.json()['id']}",
        headers=AUTH_HEADERS,
    )
    assert repeated.status_code == 409
    assert repeated.json()["code"] == "operation_not_cancellable"


def test_runtime_commit_latch_persists_and_rejects_progress_regression(
    tmp_path: Path,
) -> None:
    settings = Settings(data_dir=tmp_path, api_token="test-token")
    installer = CommitRegressionInstaller(RuntimeRequirementKind.WINDOWSML_OCR)
    manager = RuntimeInstallationManager(
        settings=settings,
        llm_provider=object(),
        ocr_provider=UnavailableOcrProvider(),
        db=Database(settings),
        installers=[installer],
        async_jobs=True,
    )
    client = TestClient(
        create_app(
            settings=settings,
            runtime_installation_manager=manager,
        )
    )

    started = client.post(
        "/runtime/installations/windowsml_ocr",
        headers=AUTH_HEADERS,
    ).json()
    assert installer.commit_recorded.wait(timeout=2)
    committing = client.get(
        f"/runtime/installations/{started['id']}",
        headers=AUTH_HEADERS,
    ).json()
    commit_started_at = committing["commit_started_at"]
    assert committing["phase"] == "committing"
    assert committing["cancellable"] is False
    assert commit_started_at is not None
    datetime.fromisoformat(commit_started_at)

    installer.allow_regression.set()
    assert installer.regression_recorded.wait(timeout=2)
    latched = client.get(
        f"/runtime/installations/{started['id']}",
        headers=AUTH_HEADERS,
    ).json()
    assert latched["phase"] == "committing"
    assert latched["cancellable"] is False
    assert latched["commit_started_at"] == commit_started_at

    installer.allow_finish.set()
    terminal = _wait_for_runtime_status(
        client,
        f"/runtime/installations/{started['id']}",
        "succeeded",
    )
    assert terminal["commit_started_at"] == commit_started_at

    restored_manager = RuntimeInstallationManager(
        settings=settings,
        llm_provider=object(),
        ocr_provider=UnavailableOcrProvider(),
        db=Database(settings),
        installers=[BlockingInstaller(RuntimeRequirementKind.WINDOWSML_OCR)],
        async_jobs=False,
    )
    restored_client = TestClient(
        create_app(
            settings=settings,
            runtime_installation_manager=restored_manager,
        )
    )
    restored = restored_client.get(
        f"/runtime/installations/{started['id']}",
        headers=AUTH_HEADERS,
    ).json()
    assert restored["commit_started_at"] == commit_started_at
    rejected = restored_client.delete(
        f"/runtime/installations/{started['id']}",
        headers=AUTH_HEADERS,
    )
    assert rejected.status_code == 409
    assert rejected.json()["code"] == "operation_not_cancellable"


def test_runtime_failed_after_commit_remains_idempotently_deletable(
    tmp_path: Path,
) -> None:
    installer = FailingCommitInstaller(RuntimeRequirementKind.WINDOWSML_OCR)
    manager = RuntimeInstallationManager(
        settings=Settings(data_dir=tmp_path, api_token="test-token"),
        llm_provider=object(),
        ocr_provider=UnavailableOcrProvider(),
        installers=[installer],
        async_jobs=False,
    )
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            runtime_installation_manager=manager,
        )
    )

    failed = client.post(
        "/runtime/installations/windowsml_ocr",
        headers=AUTH_HEADERS,
    )
    repeated = client.delete(
        f"/runtime/installations/{failed.json()['id']}",
        headers=AUTH_HEADERS,
    )

    assert failed.status_code == 202
    assert failed.json()["status"] == "failed"
    assert failed.json()["commit_started_at"] is not None
    assert repeated.status_code == 200
    assert repeated.json()["status"] == "failed"


def test_manual_draft_operation_get_delete_prevents_late_draft_commit(
    tmp_path: Path,
) -> None:
    provider = BlockingDraftProvider()
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            llm_provider=provider,
            document_processing_async_jobs=False,
        )
    )
    project_id, document_id, _chunk = _source_chunk(client, AUTH_HEADERS)
    started = client.post(
        f"/projects/{project_id}/documents/{document_id}/draft-operations",
        headers=AUTH_HEADERS,
        json={"limit": 1, "strategy": "hybrid_reasoning"},
    )
    assert started.status_code == 202
    assert provider.started.wait(timeout=2)

    endpoint = (
        f"/projects/{project_id}/documents/{document_id}/draft-operations/"
        f"{started.json()['id']}"
    )
    observed = client.get(endpoint, headers=AUTH_HEADERS)
    assert observed.status_code == 200
    assert observed.json()["status"] == "running"
    canceled = client.delete(endpoint, headers=AUTH_HEADERS)
    assert canceled.status_code == 200
    assert canceled.json()["status"] == "cancel_requested"
    assert canceled.json()["cancellable"] is False

    provider.release.set()
    terminal = _wait_for_status(client, endpoint, "canceled")
    assert terminal["phase"] == "canceled"
    repeated = client.delete(endpoint, headers=AUTH_HEADERS)
    assert repeated.json()["status"] == "canceled"
    drafts = client.get(
        f"/projects/{project_id}/question-drafts",
        headers=AUTH_HEADERS,
    )
    assert drafts.json()["items"] == []


def test_manual_commit_timestamp_is_stable_and_recovery_clears_requeued_state(
    client,
    auth_headers,
) -> None:
    project_id, document_id, _chunk = _source_chunk(client, auth_headers)
    operation = manual_operations.create_operation(
        client.app.state.database,
        project_id=project_id,
        document_id=document_id,
        limit=1,
        strategy="hybrid_reasoning",
        provider="ollama",
        model="qwen3.5:4b",
    )
    manual_operations.mark_running(client.app.state.database, operation["id"])

    first = manual_operations.begin_commit(
        client.app.state.database,
        operation["id"],
    )
    second = manual_operations.begin_commit(
        client.app.state.database,
        operation["id"],
    )

    assert first["commit_started_at"] is not None
    datetime.fromisoformat(first["commit_started_at"])
    assert second["commit_started_at"] == first["commit_started_at"]
    recovered = {
        item["id"]: item
        for item in manual_operations.recover_operations(client.app.state.database)
    }[operation["id"]]
    assert recovered["status"] == "queued"
    assert recovered["phase"] == "queued"
    assert recovered["cancellable"] is True
    assert recovered["commit_started_at"] is None


def test_manual_succeeded_commit_delete_returns_409_but_failed_stays_idempotent(
    client,
    auth_headers,
) -> None:
    project_id, document_id, chunk = _source_chunk(client, auth_headers)
    succeeded = manual_operations.create_operation(
        client.app.state.database,
        project_id=project_id,
        document_id=document_id,
        limit=1,
        strategy="hybrid_reasoning",
        provider="ollama",
        model="qwen3.5:4b",
    )
    manual_operations.mark_running(client.app.state.database, succeeded["id"])
    committing = manual_operations.begin_commit(
        client.app.state.database,
        succeeded["id"],
    )
    drafts_repository.append_generated_drafts_and_complete_manual_operation(
        client.app.state.database,
        operation_id=succeeded["id"],
        project_id=project_id,
        document_id=document_id,
        suggestions=[_suggestion(chunk)],
        effective_provider="ollama",
        effective_model="qwen3.5:4b",
        fallback_reason=None,
    )
    succeeded_endpoint = (
        f"/projects/{project_id}/documents/{document_id}/draft-operations/"
        f"{succeeded['id']}"
    )

    succeeded_delete = client.delete(succeeded_endpoint, headers=auth_headers)

    assert committing["commit_started_at"] is not None
    assert succeeded_delete.status_code == 409
    assert succeeded_delete.json()["code"] == "operation_not_cancellable"

    failed = manual_operations.create_operation(
        client.app.state.database,
        project_id=project_id,
        document_id=document_id,
        limit=1,
        strategy="hybrid_reasoning",
        provider="ollama",
        model="qwen3.5:4b",
    )
    manual_operations.mark_running(client.app.state.database, failed["id"])
    manual_operations.begin_commit(client.app.state.database, failed["id"])
    terminal_failed = manual_operations.mark_failed(
        client.app.state.database,
        failed["id"],
        "commit failed",
    )
    failed_endpoint = (
        f"/projects/{project_id}/documents/{document_id}/draft-operations/"
        f"{failed['id']}"
    )

    failed_delete = client.delete(failed_endpoint, headers=auth_headers)

    assert terminal_failed["commit_started_at"] is not None
    assert failed_delete.status_code == 200
    assert failed_delete.json()["status"] == "failed"
    assert (
        failed_delete.json()["commit_started_at"]
        == terminal_failed["commit_started_at"]
    )


def _runtime_manager(tmp_path: Path, installer) -> RuntimeInstallationManager:
    return RuntimeInstallationManager(
        settings=Settings(data_dir=tmp_path, api_token="test-token"),
        llm_provider=object(),
        ocr_provider=UnavailableOcrProvider(),
        installers=[installer],
        async_jobs=True,
    )


def _wait_for_runtime_status(
    client: TestClient,
    endpoint: str,
    expected: str,
) -> dict:
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        response = client.get(endpoint, headers=AUTH_HEADERS)
        assert response.status_code == 200
        if response.json()["status"] == expected:
            return response.json()
        time.sleep(0.01)
    raise AssertionError(f"Runtime job did not reach {expected}.")


def _wait_for_status(client: TestClient, endpoint: str, expected: str) -> dict:
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        response = client.get(endpoint, headers=AUTH_HEADERS)
        assert response.status_code == 200
        if response.json()["status"] == expected:
            return response.json()
        time.sleep(0.01)
    raise AssertionError(f"Operation did not reach {expected}.")


@dataclass
class BlockingInstaller:
    kind: RuntimeRequirementKind
    commit_phase: bool = False
    provider: str = "test-runtime"
    model: str = "qwen3.5:4b"
    started: Event = field(default_factory=Event)
    release: Event = field(default_factory=Event)
    cancel_called: Event = field(default_factory=Event)

    def requirement(self) -> RuntimeRequirementSnapshot:
        return RuntimeRequirementSnapshot(
            kind=self.kind,
            label=self.kind.value,
            available=False,
            detail=f"{self.kind.value} missing",
            unavailable_reason=f"{self.kind.value}_missing",
        )

    def install(self, progress) -> RuntimeInstallationStatus:
        progress(
            RuntimeInstallProgress(
                "installer reached checkpoint",
                phase="committing" if self.commit_phase else "installing",
                cancellable=not self.commit_phase,
            )
        )
        self.started.set()
        assert self.release.wait(timeout=3)
        progress(
            RuntimeInstallProgress(
                "installer finished",
                completed=100,
                total=100,
                phase="committing" if self.commit_phase else "installing",
                cancellable=not self.commit_phase,
            )
        )
        return RuntimeInstallationStatus.SUCCEEDED

    def cancel(self) -> None:
        self.cancel_called.set()
        self.release.set()


@dataclass
class CommitRegressionInstaller:
    kind: RuntimeRequirementKind
    provider: str = "test-runtime"
    model: str = "qwen3.5:4b"
    commit_recorded: Event = field(default_factory=Event)
    allow_regression: Event = field(default_factory=Event)
    regression_recorded: Event = field(default_factory=Event)
    allow_finish: Event = field(default_factory=Event)

    def requirement(self) -> RuntimeRequirementSnapshot:
        return RuntimeRequirementSnapshot(
            kind=self.kind,
            label=self.kind.value,
            available=False,
            detail=f"{self.kind.value} missing",
            unavailable_reason=f"{self.kind.value}_missing",
        )

    def install(self, progress) -> RuntimeInstallationStatus:
        progress(
            RuntimeInstallProgress(
                "commit started",
                phase="committing",
                cancellable=False,
            )
        )
        self.commit_recorded.set()
        assert self.allow_regression.wait(timeout=3)
        progress(
            RuntimeInstallProgress(
                "stale installer progress",
                phase="installing",
                cancellable=True,
            )
        )
        self.regression_recorded.set()
        assert self.allow_finish.wait(timeout=3)
        return RuntimeInstallationStatus.SUCCEEDED


@dataclass
class FailingCommitInstaller:
    kind: RuntimeRequirementKind
    provider: str = "test-runtime"
    model: str = "qwen3.5:4b"

    def requirement(self) -> RuntimeRequirementSnapshot:
        return RuntimeRequirementSnapshot(
            kind=self.kind,
            label=self.kind.value,
            available=False,
            detail=f"{self.kind.value} missing",
            unavailable_reason=f"{self.kind.value}_missing",
        )

    def install(self, progress) -> RuntimeInstallationStatus:
        progress(
            RuntimeInstallProgress(
                "commit started",
                phase="committing",
                cancellable=False,
            )
        )
        raise RuntimeError("commit failed")


class UnavailableOcrProvider:
    provider = "fake"
    engine = "fake"

    def health(self) -> OCRHealth:
        return OCRHealth(
            provider=self.provider,
            engine=self.engine,
            available=False,
            detail="unavailable",
            python_version="3.13",
            paddle_version=None,
            paddleocr_version=None,
            selected_device=None,
            cuda_available=False,
            gpu_count=0,
            model_cache_dir=None,
            fallback_reason=None,
            unavailable_reason="missing",
        )

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        raise AssertionError("OCR should not run in cancellation tests.")


class BlockingDraftProvider:
    provider = "fastflowlm"
    model = "qwen3.5:4b"

    def __init__(self) -> None:
        self.started = Event()
        self.release = Event()

    def health(self) -> ProviderHealth:
        return ProviderHealth(
            provider=self.provider,
            model=self.model,
            available=True,
            detail="ready",
        )

    def generate_drafts(self, chunks, limit: int) -> list[DraftSuggestion]:
        self.started.set()
        assert self.release.wait(timeout=3)
        return [
            DraftSuggestion(
                chunk_id=chunks[0].id,
                question="Generated after cancellation.",
                choices=["A", "B"],
                answer="A",
                answer_key_source="ai_inferred",
                rationale="A is correct.",
                citation_page=chunks[0].page_number,
                source_excerpt=chunks[0].source_excerpt,
            )
        ][:limit]


def _source_chunk(client, auth_headers) -> tuple[str, str, dict]:
    project_id = client.post(
        "/projects",
        headers=auth_headers,
        json={"name": "Cancellation project"},
    ).json()["id"]
    document = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={
            "file": (
                "source.pdf",
                minimal_pdf("JLPT question 1 choose the correct word A correct B wrong"),
                "application/pdf",
            )
        },
    ).json()
    chunk = client.get(
        f"/projects/{project_id}/documents/{document['id']}/chunks",
        headers=auth_headers,
    ).json()["items"][0]
    return project_id, document["id"], chunk


def _enqueue(client, project_id: str, document_id: str, chunk: dict) -> dict:
    return draft_jobs.enqueue_chunk_job(
        client.app.state.database,
        project_id=project_id,
        document_id=document_id,
        chunk_id=chunk["id"],
        page_number=chunk["page_number"],
        strategy="hybrid_reasoning",
        provider="fastflowlm",
        model="qwen3.5:4b",
    )


def _suggestion(chunk: dict) -> DraftSuggestion:
    return DraftSuggestion(
        chunk_id=chunk["id"],
        question="Choose the correct word.",
        choices=["A correct", "B wrong"],
        answer="A correct",
        answer_key_source="ai_inferred",
        rationale="The cited source identifies A.",
        citation_page=chunk["page_number"],
        source_excerpt="JLPT question 1",
    )
