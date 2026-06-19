from __future__ import annotations

from queue import Queue
from threading import Thread

from exam_prep_backend.config import Settings
from exam_prep_backend.database import Database
from exam_prep_backend.domains.mock_exams import draft_jobs
from exam_prep_backend.domains.mock_exams.models import DraftGenerationStrategy, SourceChunk
from exam_prep_backend.domains.mock_exams.normalization import as_ai_reasoning_draft
from exam_prep_backend.domains.mock_exams.ports import DraftGenerationProvider
from exam_prep_backend.domains.mock_exams.provider import generate_drafts_for_strategy
from exam_prep_backend.domains.mock_exams import repository as drafts_repository
from exam_prep_backend.domains.source_documents import repository as documents_repository
from exam_prep_backend.errors import NotFoundError, ProviderUnavailableError


JobItem = tuple[Database, str, int] | None


class StreamingDraftGenerationManager:
    """Runs page-ready draft generation from a SQLite-backed local job queue."""

    def __init__(
        self,
        *,
        settings: Settings,
        provider: DraftGenerationProvider,
        async_jobs: bool = True,
    ) -> None:
        self._settings = settings
        self._provider = provider
        self._async_jobs = async_jobs
        self._queue: Queue[JobItem] = Queue()
        self._workers: list[Thread] = []
        if async_jobs and settings.streaming_draft_generation_on_upload:
            for index in range(settings.streaming_draft_workers):
                worker = Thread(
                    target=self._worker_loop,
                    name=f"streaming-draft-worker-{index + 1}",
                    daemon=True,
                )
                worker.start()
                self._workers.append(worker)

    def enqueue_page(
        self,
        db: Database,
        *,
        project_id: str,
        document_id: str,
        page_number: int,
    ) -> dict | None:
        if not self._settings.streaming_draft_generation_on_upload:
            return None

        try:
            chunk = documents_repository.get_chunk_by_page(
                db, project_id, document_id, page_number
            )
        except NotFoundError:
            return None

        strategy = self._settings.streaming_draft_generation_strategy
        job = draft_jobs.enqueue_chunk_job(
            db,
            project_id=project_id,
            document_id=document_id,
            chunk_id=chunk["id"],
            page_number=page_number,
            strategy=strategy,
            provider=str(getattr(self._provider, "provider", "unknown")),
            model=str(getattr(self._provider, "model", "")),
        )
        if not draft_jobs.should_run(job):
            return job

        page_limit = self._settings.streaming_draft_generation_page_limit
        if self._async_jobs:
            self._queue.put((db, job["id"], page_limit))
        else:
            self._run_job(db, job["id"], page_limit)
        return job

    def close(self) -> None:
        for _worker in self._workers:
            self._queue.put(None)
        for worker in self._workers:
            worker.join(timeout=1)
        self._workers.clear()

    def recover_jobs(self, db: Database) -> int:
        if not self._settings.streaming_draft_generation_on_upload:
            return 0

        jobs = draft_jobs.recover_runnable_jobs(db)
        return self._schedule_jobs(db, jobs)

    def retry_document_jobs(
        self,
        db: Database,
        *,
        project_id: str,
        document_id: str,
    ) -> list[dict]:
        if not self._settings.streaming_draft_generation_on_upload:
            return draft_jobs.list_document_jobs(db, project_id, document_id)

        jobs = draft_jobs.retry_document_jobs(
            db,
            project_id=project_id,
            document_id=document_id,
            provider=str(getattr(self._provider, "provider", "unknown")),
            model=str(getattr(self._provider, "model", "")),
        )
        self._schedule_jobs(db, jobs)
        return draft_jobs.list_document_jobs(db, project_id, document_id)

    def _worker_loop(self) -> None:
        while True:
            item = self._queue.get()
            try:
                if item is None:
                    return
                db, job_id, limit = item
                self._run_job(db, job_id, limit)
            finally:
                self._queue.task_done()

    def _schedule_jobs(self, db: Database, jobs: list[dict]) -> int:
        page_limit = self._settings.streaming_draft_generation_page_limit
        scheduled_count = 0
        for job in jobs:
            if not draft_jobs.should_run(job):
                continue
            scheduled_count += 1
            if self._async_jobs:
                self._queue.put((db, job["id"], page_limit))
            else:
                self._run_job(db, job["id"], page_limit)
        return scheduled_count

    def _run_job(self, db: Database, job_id: str, limit: int) -> None:
        try:
            job = draft_jobs.get_job(db, job_id)
            if not draft_jobs.should_run(job):
                return
            job = draft_jobs.mark_running(db, job_id)
            if self._provider_unavailable(db, job):
                return

            chunk = documents_repository.get_chunk(
                db, job["project_id"], job["document_id"], job["chunk_id"]
            )
            source_chunk = _source_chunk_from_record(chunk)
            suggestions = [
                as_ai_reasoning_draft(suggestion)
                for suggestion in generate_drafts_for_strategy(
                    self._provider,
                    [source_chunk],
                    limit,
                    DraftGenerationStrategy(job["strategy"]),
                )
            ]
            drafts = drafts_repository.append_generated_drafts(
                db,
                project_id=job["project_id"],
                document_id=job["document_id"],
                suggestions=suggestions,
            )
            draft_jobs.mark_succeeded(db, job_id, generated_count=len(drafts))
            _refresh_document_exam_count(db, job["project_id"], job["document_id"])
        except ProviderUnavailableError as exc:
            draft_jobs.mark_skipped_provider_unavailable(db, job_id, detail=str(exc))
        except Exception as exc:
            draft_jobs.mark_failed(db, job_id, detail=f"request_failed: {exc}")

    def _provider_unavailable(self, db: Database, job: dict) -> bool:
        health = self._provider.health()
        if health.available:
            return False

        reason = health.unavailable_reason or "provider_unavailable"
        detail = health.detail
        if reason == "model_missing":
            draft_jobs.mark_skipped_missing_model(db, job["id"], detail=detail)
            return True

        draft_jobs.mark_skipped_provider_unavailable(db, job["id"], detail=detail)
        return True


def _source_chunk_from_record(chunk: dict) -> SourceChunk:
    return SourceChunk(
        id=chunk["id"],
        page_number=chunk["page_number"],
        chunk_index=chunk["chunk_index"],
        text=chunk["text"],
        raw_text=chunk["raw_text"],
        source_excerpt=chunk["source_excerpt"],
        line_start=chunk["line_start"],
        line_end=chunk["line_end"],
        line_count=chunk["line_count"],
        content_profile=chunk["content_profile"],
    )


def _refresh_document_exam_count(db: Database, project_id: str, document_id: str) -> None:
    document = documents_repository.get_document(db, project_id, document_id)
    if document["status"] == "processing":
        next_status = "processing"
    elif document["has_text"] and document["chunks_count"] > 0:
        next_status = "ready"
    else:
        next_status = "exam_failed"
    documents_repository.update_exam_state(
        db,
        project_id=project_id,
        document_id=document_id,
        status=next_status,
        exam_item_count=drafts_repository.count_document_drafts(
            db, project_id, document_id
        ),
    )
