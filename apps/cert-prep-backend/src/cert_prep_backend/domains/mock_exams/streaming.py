from __future__ import annotations

from inspect import Parameter, signature
from threading import BoundedSemaphore, Thread

from cert_prep_backend.api.errors import ProviderUnavailableError
from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.mock_exams import draft_jobs
from cert_prep_backend.domains.mock_exams import repository as drafts_repository
from cert_prep_backend.domains.mock_exams.deterministic_parser import (
    extract_jlpt_question_blocks,
    is_exam_source_chunk,
)
from cert_prep_backend.domains.mock_exams.models import (
    DraftGenerationStrategy,
    DraftSuggestion,
    SourceChunk,
)
from cert_prep_backend.domains.mock_exams.normalization import as_editable_question
from cert_prep_backend.domains.mock_exams.ollama_transport import STREAMING_RELEASE_KEEP_ALIVE
from cert_prep_backend.domains.mock_exams.ports import DraftGenerationProvider
from cert_prep_backend.domains.mock_exams.provider import generate_drafts_for_strategy
from cert_prep_backend.domains.source_documents import repository as documents_repository
from cert_prep_backend.persistence.database import Database


STREAMING_FAST_FIRST_NUM_CTX = 2048
STREAMING_FAST_FIRST_NUM_PREDICT = 512
STREAMING_DRAFTS_PER_JOB_LIMIT = 1


class StreamingDraftGenerationManager:
    """Runs post-OCR draft generation from SQLite-backed local jobs."""

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

    def enqueue_document(
        self,
        db: Database,
        *,
        project_id: str,
        document_id: str,
    ) -> list[dict]:
        if not self._settings.streaming_draft_generation_on_upload:
            return []

        strategy = self._settings.streaming_draft_generation_strategy
        max_jobs = self._settings.streaming_draft_generation_page_limit
        jobs: list[dict] = []
        for chunk in documents_repository.get_source_chunks(db, project_id, document_id):
            if len(jobs) >= max_jobs:
                break

            source_chunk = _source_chunk_from_record(chunk)
            if not _should_enqueue_streaming_chunk(
                source_chunk, DraftGenerationStrategy(strategy)
            ):
                continue

            jobs.append(
                draft_jobs.enqueue_chunk_job(
                    db,
                    project_id=project_id,
                    document_id=document_id,
                    chunk_id=chunk["id"],
                    page_number=chunk["page_number"],
                    strategy=strategy,
                    provider=str(getattr(self._provider, "provider", "unknown")),
                    model=str(getattr(self._provider, "model", "")),
                )
            )

        self._schedule_jobs(db, jobs)
        return draft_jobs.list_document_jobs(db, project_id, document_id)

    def close(self) -> None:
        for worker in self._job_threads:
            worker.join(timeout=1)
        self._job_threads.clear()

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
        runnable_jobs = [job for job in jobs if draft_jobs.should_run(job)]
        if not runnable_jobs:
            return 0
        if self._provider_unavailable_for_jobs(db, runnable_jobs):
            return 0

        scheduled_count = 0
        for job in runnable_jobs:
            scheduled_count += 1
            if self._async_jobs:
                self._start_job_thread(db, job["id"], STREAMING_DRAFTS_PER_JOB_LIMIT)
            else:
                self._run_job(db, job["id"], STREAMING_DRAFTS_PER_JOB_LIMIT)
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
        finally:
            self._release_provider_resources()

    def _provider_unavailable(self, db: Database, job: dict) -> bool:
        if _provider_starts_on_generation(self._provider):
            return False
        health = self._provider.health()
        if health.available:
            return False

        _mark_provider_unavailable_job(
            db,
            job,
            health.unavailable_reason,
            health.detail or "provider unavailable",
        )
        return True

    def _provider_unavailable_for_jobs(self, db: Database, jobs: list[dict]) -> bool:
        if _provider_starts_on_generation(self._provider):
            return False
        health = self._provider.health()
        if health.available:
            return False

        detail = health.detail or "provider unavailable"
        for job in jobs:
            _mark_provider_unavailable_job(
                db, job, health.unavailable_reason, detail
            )
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

    def _release_provider_resources(self) -> None:
        release_resources = getattr(self._provider, "release_resources", None)
        if callable(release_resources):
            release_resources()


def _mark_provider_unavailable_job(
    db: Database,
    job: dict,
    unavailable_reason: str | None,
    detail: str,
) -> None:
    reason = unavailable_reason or "provider_unavailable"
    if reason == "model_missing":
        draft_jobs.mark_skipped_missing_model(db, job["id"], detail=detail)
        return

    draft_jobs.mark_skipped_provider_unavailable(db, job["id"], detail=detail)


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
            try:
                suggestion = _call_streaming_provider_method(
                    provider,
                    fast_first,
                    source_chunk,
                    deterministic[0],
                )
            except ProviderUnavailableError as exc:
                if not _is_non_fatal_generation_error(exc):
                    raise
                suggestion = None
            if suggestion is not None:
                return [suggestion]

        reasoning = getattr(provider, "generate_reasoning_drafts", None)
        if callable(reasoning):
            prompt_chunk = _compact_reasoning_chunk(source_chunk)
            try:
                suggestions = _call_streaming_provider_method(
                    provider,
                    reasoning,
                    [prompt_chunk],
                    first_limit,
                    num_ctx=STREAMING_FAST_FIRST_NUM_CTX,
                    num_predict=STREAMING_FAST_FIRST_NUM_PREDICT,
                )
            except ProviderUnavailableError as exc:
                if not _is_non_fatal_generation_error(exc):
                    raise
                return []
            if suggestions:
                return suggestions
            return []

    return generate_drafts_for_strategy(provider, [source_chunk], first_limit, strategy)


def _call_streaming_provider_method(
    provider: DraftGenerationProvider,
    method,
    *args,
    **kwargs,
):
    if _should_release_after_streaming(provider) and _accepts_keyword(
        method, "keep_alive"
    ):
        kwargs["keep_alive"] = STREAMING_RELEASE_KEEP_ALIVE
    return method(*args, **kwargs)


def _should_release_after_streaming(provider: DraftGenerationProvider) -> bool:
    return str(getattr(provider, "provider", "")).lower() == "ollama"


def _provider_starts_on_generation(provider: DraftGenerationProvider) -> bool:
    return (
        str(getattr(provider, "provider", "")).lower() == "fastflowlm"
        and bool(getattr(provider, "auto_start_server", False))
    )


def _accepts_keyword(method, keyword: str) -> bool:
    try:
        parameters = signature(method).parameters
    except (TypeError, ValueError):
        return False
    return keyword in parameters or any(
        parameter.kind == Parameter.VAR_KEYWORD
        for parameter in parameters.values()
    )


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


def _is_non_fatal_generation_error(exc: Exception) -> bool:
    error = " ".join(str(exc).lower().split())
    return any(
        marker in error
        for marker in (
            "invalid json",
            "unreadable response",
            "non-object json response",
            "timed out",
            "timeout",
        )
    )
