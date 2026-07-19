from __future__ import annotations

from threading import BoundedSemaphore, Lock, Thread

from cert_prep_backend.api.errors import ProviderUnavailableError
from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.mock_exams import draft_jobs
from cert_prep_backend.domains.mock_exams import manual_operations
from cert_prep_backend.domains.mock_exams import repository as drafts_repository
from cert_prep_backend.domains.mock_exams.deterministic_parser import (
    extract_jlpt_question_blocks,
    is_exam_source_chunk,
)
from cert_prep_backend.domains.mock_exams.models import (
    DraftGenerationStrategy,
    DraftSuggestion,
    SourceChunk,
    source_chunk_from_record,
)
from cert_prep_backend.domains.mock_exams.normalization import as_editable_question
from cert_prep_backend.domains.mock_exams.ports import (
    DraftGenerationProvider,
    FastFirstDraftProvider,
    GenerationAttributionProvider,
    ReasoningDraftProvider,
    ResourceReleasingProvider,
    StartsOnGenerationProvider,
    StreamingGenerationOptionsProvider,
    provider_capability,
)
from cert_prep_contracts.llm import GenerationAttribution
from cert_prep_backend.domains.mock_exams.provider import generate_drafts_for_strategy
from cert_prep_backend.domains.mock_exams.response_parsing import (
    is_non_fatal_generation_error,
)
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
        self._manual_schedule_lock = Lock()
        self._scheduled_manual_ids: set[str] = set()

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
            if not _should_enqueue_streaming_chunk(source_chunk, DraftGenerationStrategy(strategy)):
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
        scheduled = 0
        if self._settings.streaming_draft_generation_on_upload:
            jobs = draft_jobs.recover_runnable_jobs(db)
            scheduled = self._schedule_jobs(db, jobs)
        for operation in manual_operations.recover_operations(db):
            scheduled += self._schedule_manual_operation(db, operation["id"])
        return scheduled

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

    def start_manual_operation(
        self,
        db: Database,
        *,
        project_id: str,
        document_id: str,
        limit: int,
        strategy: DraftGenerationStrategy,
    ) -> dict:
        operation = manual_operations.create_operation(
            db,
            project_id=project_id,
            document_id=document_id,
            limit=limit,
            strategy=strategy,
            provider=str(getattr(self._provider, "provider", "unknown")),
            model=str(getattr(self._provider, "model", "")),
        )
        if operation["status"] == manual_operations.ManualDraftOperationStatus.QUEUED:
            self._schedule_manual_operation(db, operation["id"])
        return manual_operations.get_operation(
            db,
            project_id=project_id,
            document_id=document_id,
            operation_id=operation["id"],
        )

    def get_manual_operation(
        self,
        db: Database,
        *,
        project_id: str,
        document_id: str,
        operation_id: str,
    ) -> dict:
        return manual_operations.get_operation(
            db,
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
        )

    def cancel_manual_operation(
        self,
        db: Database,
        *,
        project_id: str,
        document_id: str,
        operation_id: str,
    ) -> dict:
        return manual_operations.request_cancel(
            db,
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
        )

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
            if job["status"] != draft_jobs.DraftGenerationJobStatus.RUNNING:
                return
            if self._provider_unavailable(db, job):
                return
            _reset_generation_attribution(self._provider)

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
            attribution = _generation_attribution(
                self._provider,
                generated=bool(suggestions),
            )
            draft_jobs.begin_commit(db, job_id)
            drafts_repository.append_generated_drafts_and_complete_job(
                db,
                job_id=job_id,
                project_id=job["project_id"],
                document_id=job["document_id"],
                suggestions=suggestions,
                effective_provider=attribution.effective_provider,
                effective_model=attribution.effective_model,
                fallback_reason=attribution.fallback_reason,
            )
        except draft_jobs.DraftJobCanceledError:
            draft_jobs.mark_canceled(db, job_id)
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
            _mark_provider_unavailable_job(db, job, health.unavailable_reason, detail)
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

    def _schedule_manual_operation(self, db: Database, operation_id: str) -> int:
        with self._manual_schedule_lock:
            if operation_id in self._scheduled_manual_ids:
                return 0
            self._scheduled_manual_ids.add(operation_id)
        if self._async_jobs:
            self._start_manual_thread(db, operation_id)
        else:
            self._run_manual_operation_with_slot(db, operation_id)
        return 1

    def _start_manual_thread(self, db: Database, operation_id: str) -> None:
        self._job_threads = [thread for thread in self._job_threads if thread.is_alive()]
        worker = Thread(
            target=self._run_manual_operation_with_slot,
            args=(db, operation_id),
            name=f"manual-draft-operation-{operation_id[:8]}",
            daemon=True,
        )
        worker.start()
        self._job_threads.append(worker)

    def _run_manual_operation_with_slot(
        self,
        db: Database,
        operation_id: str,
    ) -> None:
        try:
            with self._job_slots:
                self._run_manual_operation(db, operation_id)
        finally:
            with self._manual_schedule_lock:
                self._scheduled_manual_ids.discard(operation_id)

    def _run_manual_operation(self, db: Database, operation_id: str) -> None:
        try:
            operation = manual_operations.mark_running(db, operation_id)
            if operation["status"] != manual_operations.ManualDraftOperationStatus.RUNNING:
                return
            chunks = [
                _source_chunk_from_record(chunk)
                for chunk in documents_repository.get_source_chunks(
                    db,
                    operation["project_id"],
                    operation["document_id"],
                )
            ]
            if not chunks:
                raise ValueError("Document has no extracted text chunks.")
            _reset_generation_attribution(self._provider)
            suggestions = generate_drafts_for_strategy(
                self._provider,
                chunks,
                operation["limit"],
                DraftGenerationStrategy(operation["strategy"]),
            )
            attribution = _generation_attribution(
                self._provider,
                generated=bool(suggestions),
            )
            manual_operations.begin_commit(db, operation_id)
            drafts_repository.append_generated_drafts_and_complete_manual_operation(
                db,
                operation_id=operation_id,
                project_id=operation["project_id"],
                document_id=operation["document_id"],
                suggestions=suggestions,
                effective_provider=attribution.effective_provider,
                effective_model=attribution.effective_model,
                fallback_reason=attribution.fallback_reason,
            )
        except draft_jobs.DraftJobCanceledError:
            manual_operations.mark_canceled(db, operation_id)
        except Exception as exc:
            manual_operations.mark_failed(db, operation_id, str(exc))
        finally:
            self._release_provider_resources()

    def _release_provider_resources(self) -> None:
        provider = provider_capability(self._provider, ResourceReleasingProvider)
        if provider is not None:
            provider.release_resources()


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
        fast_first_provider = provider_capability(provider, FastFirstDraftProvider)
        if deterministic and fast_first_provider is not None:
            try:
                suggestion = _call_streaming_provider_method(
                    provider,
                    fast_first_provider.generate_fast_first_draft,
                    source_chunk,
                    deterministic[0],
                )
            except ProviderUnavailableError as exc:
                if not is_non_fatal_generation_error(exc):
                    raise
                suggestion = None
            if suggestion is not None:
                return [suggestion]

        reasoning_provider = provider_capability(provider, ReasoningDraftProvider)
        if reasoning_provider is not None:
            prompt_chunk = _compact_reasoning_chunk(source_chunk)
            try:
                suggestions = _call_streaming_provider_method(
                    provider,
                    reasoning_provider.generate_reasoning_drafts,
                    [prompt_chunk],
                    first_limit,
                    num_ctx=STREAMING_FAST_FIRST_NUM_CTX,
                    num_predict=STREAMING_FAST_FIRST_NUM_PREDICT,
                )
            except ProviderUnavailableError as exc:
                if not is_non_fatal_generation_error(exc):
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
    kwargs.update(_streaming_generation_kwargs(provider))
    return method(*args, **kwargs)


def _streaming_generation_kwargs(provider: DraftGenerationProvider) -> dict[str, object]:
    options_provider = provider_capability(provider, StreamingGenerationOptionsProvider)
    if options_provider is None:
        return {}
    return dict(options_provider.streaming_generation_kwargs())


def _provider_starts_on_generation(provider: DraftGenerationProvider) -> bool:
    starts_provider = provider_capability(provider, StartsOnGenerationProvider)
    return bool(starts_provider and starts_provider.starts_on_generation)


def _reset_generation_attribution(provider: DraftGenerationProvider) -> None:
    attribution_provider = provider_capability(provider, GenerationAttributionProvider)
    if attribution_provider is not None:
        attribution_provider.reset_generation_attribution()


def _generation_attribution(
    provider: DraftGenerationProvider,
    *,
    generated: bool,
) -> GenerationAttribution:
    attribution_provider = provider_capability(provider, GenerationAttributionProvider)
    if attribution_provider is not None:
        attribution = attribution_provider.generation_attribution()
        if attribution.effective_provider and attribution.effective_model:
            return attribution
    if not generated:
        return GenerationAttribution(None, None)
    return GenerationAttribution(
        effective_provider=str(getattr(provider, "provider", "")) or None,
        effective_model=str(getattr(provider, "model", "")) or None,
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
    return source_chunk_from_record(chunk)
