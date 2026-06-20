from __future__ import annotations

from threading import BoundedSemaphore, Thread

from exam_prep_backend.config import Settings
from exam_prep_backend.database import Database
from exam_prep_backend.domains.mock_exams import draft_jobs
from exam_prep_backend.domains.mock_exams import repository as drafts_repository
from exam_prep_backend.domains.mock_exams.deterministic_parser import (
    extract_jlpt_question_blocks,
    is_exam_source_chunk,
)
from exam_prep_backend.domains.mock_exams.models import (
    DraftGenerationStrategy,
    DraftSuggestion,
    SourceChunk,
)
from exam_prep_backend.domains.mock_exams.normalization import as_editable_question
from exam_prep_backend.domains.mock_exams.ports import DraftGenerationProvider
from exam_prep_backend.domains.mock_exams.provider import generate_drafts_for_strategy
from exam_prep_backend.domains.source_documents import repository as documents_repository
from exam_prep_backend.errors import NotFoundError, ProviderUnavailableError


STREAMING_FAST_FIRST_NUM_CTX = 2048
STREAMING_FAST_FIRST_NUM_PREDICT = 512


class StreamingDraftGenerationManager:
    """Runs page-ready draft generation from SQLite-backed local jobs."""

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
        self._job_slots = BoundedSemaphore(settings.streaming_draft_workers)
        self._job_threads: list[Thread] = []
        self._prewarm_thread: Thread | None = None
        if async_jobs and settings.streaming_draft_generation_on_upload:
            self._start_provider_prewarm()

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
        source_chunk = _source_chunk_from_record(chunk)
        if not _should_enqueue_streaming_chunk(
            source_chunk, DraftGenerationStrategy(strategy)
        ):
            return None

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
            self._start_job_thread(db, job["id"], page_limit)
        else:
            self._run_job(db, job["id"], page_limit)
        return job

    def close(self) -> None:
        for worker in self._job_threads:
            worker.join(timeout=1)
        self._job_threads.clear()
        if self._prewarm_thread is not None:
            self._prewarm_thread.join(timeout=1)
            self._prewarm_thread = None

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

    def _schedule_jobs(self, db: Database, jobs: list[dict]) -> int:
        page_limit = self._settings.streaming_draft_generation_page_limit
        scheduled_count = 0
        for job in jobs:
            if not draft_jobs.should_run(job):
                continue
            scheduled_count += 1
            if self._async_jobs:
                self._start_job_thread(db, job["id"], page_limit)
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
                as_editable_question(suggestion)
                for suggestion in _generate_streaming_fast_first_drafts(
                    self._provider,
                    source_chunk,
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

    def _start_job_thread(self, db: Database, job_id: str, limit: int) -> None:
        self._job_threads = [thread for thread in self._job_threads if thread.is_alive()]
        worker = Thread(
            target=self._run_job_with_slot,
            args=(db, job_id, limit),
            name=f"streaming-draft-job-{job_id[:8]}",
            daemon=True,
        )
        worker.start()
        self._job_threads.append(worker)

    def _run_job_with_slot(self, db: Database, job_id: str, limit: int) -> None:
        with self._job_slots:
            self._run_job(db, job_id, limit)

    def _start_provider_prewarm(self) -> None:
        prewarm = getattr(self._provider, "prewarm", None)
        if not callable(prewarm):
            return

        self._prewarm_thread = Thread(
            target=self._prewarm_provider,
            name="streaming-draft-prewarm",
            daemon=True,
        )
        self._prewarm_thread.start()

    def _prewarm_provider(self) -> None:
        prewarm = getattr(self._provider, "prewarm", None)
        if not callable(prewarm):
            return
        try:
            prewarm()
        except Exception:
            return


def _generate_streaming_fast_first_drafts(
    provider: DraftGenerationProvider,
    source_chunk: SourceChunk,
    limit: int,
    strategy: DraftGenerationStrategy,
) -> list[DraftSuggestion]:
    first_limit = min(limit, 1)
    if first_limit <= 0:
        return []
    if strategy == DraftGenerationStrategy.HYBRID_REASONING:
        deterministic = extract_jlpt_question_blocks([source_chunk], 1)
        fast_first = getattr(provider, "generate_fast_first_draft", None)
        if deterministic and callable(fast_first):
            suggestion = fast_first(source_chunk, deterministic[0])
            if suggestion is not None:
                return [suggestion]

        reasoning = getattr(provider, "generate_reasoning_drafts", None)
        if callable(reasoning):
            prompt_chunk = _compact_reasoning_chunk(source_chunk)
            suggestions = reasoning(
                [prompt_chunk],
                first_limit,
                num_ctx=STREAMING_FAST_FIRST_NUM_CTX,
                num_predict=STREAMING_FAST_FIRST_NUM_PREDICT,
            )
            if suggestions:
                return suggestions

    return generate_drafts_for_strategy(provider, [source_chunk], first_limit, strategy)


def _should_enqueue_streaming_chunk(
    source_chunk: SourceChunk,
    strategy: DraftGenerationStrategy,
) -> bool:
    if strategy == DraftGenerationStrategy.HYBRID_REASONING:
        return bool(extract_jlpt_question_blocks([source_chunk], 1))
    return is_exam_source_chunk(source_chunk)


def _compact_reasoning_chunk(source_chunk: SourceChunk) -> SourceChunk:
    deterministic = extract_jlpt_question_blocks([source_chunk], 1)
    if not deterministic:
        return source_chunk

    first = deterministic[0]
    choices = "\n".join(f"- {choice}" for choice in first.choices)
    text = (
        "JLPT question candidate for qwen answer/rationale completion.\n"
        f"Question: {first.question}\n"
        f"Choices:\n{choices}\n"
        f"Source excerpt: {first.source_excerpt}\n"
        "Infer exactly one correct answer from the visible stem and choices."
    )
    return SourceChunk(
        id=source_chunk.id,
        page_number=source_chunk.page_number,
        chunk_index=source_chunk.chunk_index,
        text=text,
        raw_text=text,
        source_excerpt=first.source_excerpt,
        line_start=source_chunk.line_start,
        line_end=source_chunk.line_end,
        line_count=source_chunk.line_count,
        content_profile=source_chunk.content_profile,
    )


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
