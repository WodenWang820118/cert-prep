from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from threading import Lock, Thread
from typing import Callable, Protocol
from uuid import uuid4

from exam_prep_backend.domains.mock_exams.ports import ModelPullProgress
from exam_prep_backend.errors import ProviderUnavailableError


class _Missing:
    pass


_MISSING = _Missing()


class ModelDownloadStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class ModelDownloadSnapshot:
    id: str
    provider: str
    model: str
    status: ModelDownloadStatus
    detail: str
    completed: int | None
    total: int | None
    created_at: str
    updated_at: str


@dataclass(slots=True)
class _ModelDownloadJob:
    id: str
    provider: str
    model: str
    status: ModelDownloadStatus
    detail: str
    completed: int | None
    total: int | None
    created_at: datetime
    updated_at: datetime

    def snapshot(self) -> ModelDownloadSnapshot:
        return ModelDownloadSnapshot(
            id=self.id,
            provider=self.provider,
            model=self.model,
            status=self.status,
            detail=self.detail,
            completed=self.completed,
            total=self.total,
            created_at=self.created_at.isoformat(),
            updated_at=self.updated_at.isoformat(),
        )


class _PullProvider(Protocol):
    provider: str
    model: str

    def pull_model(self, progress: Callable[[ModelPullProgress], None]) -> None:
        pass


class ModelDownloadManager:
    """Coordinates explicit user-confirmed LLM model download jobs."""

    def __init__(self, provider: object, *, async_jobs: bool = True) -> None:
        self._provider = provider
        self._async_jobs = async_jobs
        self._jobs: dict[str, _ModelDownloadJob] = {}
        self._lock = Lock()

    def start_download(self) -> ModelDownloadSnapshot:
        pull_provider = self._pull_provider()
        with self._lock:
            existing = self._active_job_for(pull_provider.provider, pull_provider.model)
            if existing is not None:
                return existing.snapshot()

            now = _utcnow()
            job = _ModelDownloadJob(
                id=str(uuid4()),
                provider=pull_provider.provider,
                model=pull_provider.model,
                status=ModelDownloadStatus.QUEUED,
                detail="model download queued",
                completed=None,
                total=None,
                created_at=now,
                updated_at=now,
            )
            self._jobs[job.id] = job

        if self._async_jobs:
            Thread(target=self._run_download, args=(job.id, pull_provider), daemon=True).start()
        else:
            self._run_download(job.id, pull_provider)
        return self.get_download(job.id)

    def get_download(self, job_id: str) -> ModelDownloadSnapshot:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise KeyError(job_id)
            return job.snapshot()

    def _run_download(self, job_id: str, provider: _PullProvider) -> None:
        self._update_job(
            job_id,
            status=ModelDownloadStatus.RUNNING,
            detail="model download running",
        )
        try:
            provider.pull_model(lambda progress: self._record_progress(job_id, progress))
        except Exception as exc:
            self._update_job(
                job_id,
                status=ModelDownloadStatus.FAILED,
                detail=f"Ollama unavailable: {exc}",
            )
            return

        snapshot = self.get_download(job_id)
        self._update_job(
            job_id,
            status=ModelDownloadStatus.SUCCEEDED,
            detail="model download complete",
            completed=snapshot.completed,
            total=snapshot.total,
        )

    def _record_progress(self, job_id: str, progress: ModelPullProgress) -> None:
        self._update_job(
            job_id,
            status=ModelDownloadStatus.RUNNING,
            detail=progress.status or "model download running",
            completed=progress.completed,
            total=progress.total,
        )

    def _update_job(
        self,
        job_id: str,
        *,
        status: ModelDownloadStatus,
        detail: str,
        completed: int | None | object = _MISSING,
        total: int | None | object = _MISSING,
    ) -> None:
        with self._lock:
            job = self._jobs[job_id]
            job.status = status
            job.detail = detail
            if completed is not _MISSING:
                job.completed = completed  # type: ignore[assignment]
            if total is not _MISSING:
                job.total = total  # type: ignore[assignment]
            job.updated_at = _utcnow()

    def _active_job_for(self, provider: str, model: str) -> _ModelDownloadJob | None:
        for job in self._jobs.values():
            if (
                job.provider == provider
                and job.model == model
                and job.status in {ModelDownloadStatus.QUEUED, ModelDownloadStatus.RUNNING}
            ):
                return job
        return None

    def _pull_provider(self) -> _PullProvider:
        pull = getattr(self._provider, "pull_model", None)
        if not callable(pull):
            raise ProviderUnavailableError(
                "Configured LLM provider does not support model downloads."
            )
        return self._provider  # type: ignore[return-value]


def _utcnow() -> datetime:
    return datetime.now(UTC)
