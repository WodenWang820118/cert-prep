from __future__ import annotations

from threading import BoundedSemaphore, Lock, Thread

from cert_prep_backend.authoring.application.ports import (
    QuestionSources,
    ProjectSources,
    ReadingLexicon,
    StudyProjects,
)

from cert_prep_backend.platform.errors import LanguageModelUnavailable
from cert_prep_backend.platform.config import Settings
from cert_prep_backend.authoring.infrastructure import question_generation_jobs
from cert_prep_backend.authoring.infrastructure import manual_operations
from cert_prep_backend.authoring.infrastructure import repository as questions_repository
from cert_prep_backend.authoring.domain.deterministic_parser import (
    extract_jlpt_question_blocks,
    is_exam_source_chunk,
)
from cert_prep_backend.authoring.domain.models import (
    QuestionGenerationStrategy,
    QuestionSuggestion,
    SourceChunk,
)
from cert_prep_backend.authoring.domain.normalization import as_editable_question
from cert_prep_backend.ai_providers.domain.generation_errors import (
    is_non_fatal_generation_error,
)
from cert_prep_backend.ai_providers.domain.provider import (
    GenerationAttributionProvider,
    LLMProvider,
    ResourceReleasingProvider,
    StartsOnGenerationProvider,
    BackgroundGenerationOptionsProvider,
    provider_capability,
)
from cert_prep_backend.authoring.domain.ports import (
    FastFirstQuestionWriter,
    ReasoningQuestionWriter,
)
from cert_prep_contracts.llm import GenerationAttribution
from cert_prep_backend.authoring.domain.generation import (
    QuestionGenerationJob,
    QuestionGenerationJobStatus,
    QuestionJobCanceledError,
    ManualQuestionGeneration,
    ManualQuestionGenerationStatus,
)
from cert_prep_backend.authoring.infrastructure.question_writing import (
    _with_chunk_source_order,
    question_writer_for,
    write_questions_for_strategy,
    write_questions_with_annotations_for_strategy,
)
from cert_prep_backend.platform.database import Database


FAST_FIRST_NUM_CTX = 2048
FAST_FIRST_NUM_PREDICT = 512
QUESTIONS_PER_JOB_LIMIT = 1


class QuestionJobScheduler:
    """Runs SQLite-backed question generation jobs after extraction."""

    def __init__(
        self,
        *,
        settings: Settings,
        provider: LLMProvider,
        async_jobs: bool = True,
        reading_lexicon: ReadingLexicon | None = None,
        question_count: questions_repository.BindSourceQuestionCount,
        sources: QuestionSources,
        projects: StudyProjects,
        project_sources: ProjectSources,
    ) -> None:
        self._settings = settings
        # Source Library's question count and status of a source, written in the commit of its questions.
        self._question_count = question_count
        self._provider = provider
        self._async_jobs = async_jobs
        self._reading_lexicon = reading_lexicon if settings.reading_solver_enabled else None
        self._sources = sources
        self._projects = projects
        self._project_sources = project_sources
        self._job_slots = BoundedSemaphore(settings.question_job_workers)
        self._job_threads: list[Thread] = []
        self._manual_schedule_lock = Lock()
        self._scheduled_manual_ids: set[str] = set()

    def enqueue_source(
        self,
        db: Database,
        *,
        project_id: str,
        source_id: str,
    ) -> list[QuestionGenerationJob]:
        if not self._settings.question_jobs_on_upload:
            return []

        strategy = self._settings.question_jobs_strategy
        max_jobs = self._settings.question_jobs_chunk_limit
        jobs: list[QuestionGenerationJob] = []
        chunks = self._sources.chunks_of(project_id, source_id)
        for chunk in chunks:
            if len(jobs) >= max_jobs:
                break

            source_chunk = chunk
            if not _should_enqueue_chunk(source_chunk, QuestionGenerationStrategy(strategy)):
                continue

            jobs.append(
                question_generation_jobs.enqueue_chunk_job(
                    db,
                    project_id=project_id,
                    source_id=source_id,
                    chunk_id=chunk.id,
                    page_number=chunk.page_number,
                    strategy=strategy,
                    provider=str(getattr(self._provider, "provider", "unknown")),
                    model=str(getattr(self._provider, "model", "")),
                    projects=self._projects,
                    sources=self._sources,
                )
            )

        self._schedule_jobs(db, jobs)
        return question_generation_jobs.list_source_jobs(
            db, project_id, source_id, sources=self._project_sources
        )

    def close(self) -> None:
        for worker in self._job_threads:
            worker.join(timeout=1)
        self._job_threads.clear()

    def recover_jobs(self, db: Database) -> int:
        scheduled = 0
        if self._settings.question_jobs_on_upload:
            jobs = question_generation_jobs.recover_runnable_jobs(db)
            scheduled = self._schedule_jobs(db, jobs)
        for operation in manual_operations.recover_operations(db):
            scheduled += self._schedule_manual_operation(db, operation.id)
        return scheduled

    def retry_source_jobs(
        self,
        db: Database,
        *,
        project_id: str,
        source_id: str,
    ) -> list[QuestionGenerationJob]:
        if not self._settings.question_jobs_on_upload:
            return question_generation_jobs.list_source_jobs(
                db, project_id, source_id, sources=self._project_sources
            )

        jobs = question_generation_jobs.retry_source_jobs(
            db,
            project_id=project_id,
            source_id=source_id,
            provider=str(getattr(self._provider, "provider", "unknown")),
            model=str(getattr(self._provider, "model", "")),
            sources=self._project_sources,
        )
        self._schedule_jobs(db, jobs)
        return question_generation_jobs.list_source_jobs(
            db, project_id, source_id, sources=self._project_sources
        )

    def start_manual_operation(
        self,
        db: Database,
        *,
        project_id: str,
        source_id: str,
        limit: int,
        strategy: QuestionGenerationStrategy,
    ) -> ManualQuestionGeneration:
        operation = manual_operations.create_operation(
            db,
            project_id=project_id,
            source_id=source_id,
            limit=limit,
            strategy=strategy,
            provider=str(getattr(self._provider, "provider", "unknown")),
            model=str(getattr(self._provider, "model", "")),
            projects=self._projects,
            sources=self._project_sources,
        )
        if operation.status == ManualQuestionGenerationStatus.QUEUED:
            self._schedule_manual_operation(db, operation.id)
        return manual_operations.get_operation(
            db,
            project_id=project_id,
            source_id=source_id,
            operation_id=operation.id,
        )

    def get_manual_operation(
        self,
        db: Database,
        *,
        project_id: str,
        source_id: str,
        operation_id: str,
    ) -> ManualQuestionGeneration:
        return manual_operations.get_operation(
            db,
            project_id=project_id,
            source_id=source_id,
            operation_id=operation_id,
        )

    def cancel_manual_operation(
        self,
        db: Database,
        *,
        project_id: str,
        source_id: str,
        operation_id: str,
    ) -> ManualQuestionGeneration:
        return manual_operations.request_cancel(
            db,
            project_id=project_id,
            source_id=source_id,
            operation_id=operation_id,
            sources=self._project_sources,
        )

    def _schedule_jobs(self, db: Database, jobs: list[QuestionGenerationJob]) -> int:
        runnable_jobs = [job for job in jobs if job.should_run()]
        if not runnable_jobs:
            return 0
        if self._provider_unavailable_for_jobs(db, runnable_jobs):
            return 0

        scheduled_count = 0
        for job in runnable_jobs:
            scheduled_count += 1
            if self._async_jobs:
                self._start_job_thread(db, job.id, QUESTIONS_PER_JOB_LIMIT)
            else:
                self._run_job(db, job.id, QUESTIONS_PER_JOB_LIMIT)
        return scheduled_count

    def _run_job(self, db: Database, job_id: str, limit: int) -> None:
        try:
            job = question_generation_jobs.get_job(db, job_id)
            if not job.should_run():
                return
            job = question_generation_jobs.mark_running(db, job_id)
            if job.status != QuestionGenerationJobStatus.RUNNING:
                return
            if self._provider_unavailable(db, job):
                return
            _reset_generation_attribution(self._provider)

            source_chunk = self._sources.chunk(
                job.project_id, job.source_id, job.chunk_id
            )
            suggestions = [
                as_editable_question(suggestion)
                for suggestion in _generate_fast_first_questions(
                    self._provider,
                    source_chunk,
                    limit,
                    QuestionGenerationStrategy(job.strategy),
                    reading_lexicon=self._reading_lexicon,
                )
            ]
            attribution = _generation_attribution(
                self._provider,
                generated=bool(suggestions),
                dictionary_only=bool(suggestions) and all(
                    suggestion.dictionary_generated for suggestion in suggestions
                ),
            )
            question_generation_jobs.begin_commit(db, job_id)
            questions_repository.append_generated_questions_and_complete_job(
                db,
                job_id=job_id,
                project_id=job.project_id,
                source_id=job.source_id,
                suggestions=suggestions,
                effective_provider=attribution.effective_provider,
                effective_model=attribution.effective_model,
                fallback_reason=attribution.fallback_reason,
                question_count=self._question_count,
                projects=self._projects,
            )
        except QuestionJobCanceledError:
            question_generation_jobs.mark_canceled(db, job_id)
        except LanguageModelUnavailable as exc:
            question_generation_jobs.mark_skipped_provider_unavailable(db, job_id, detail=str(exc))
        except Exception as exc:
            question_generation_jobs.mark_failed(db, job_id, detail=f"request_failed: {exc}")
        finally:
            self._release_provider_resources()

    def _provider_unavailable(self, db: Database, job: QuestionGenerationJob) -> bool:
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

    def _provider_unavailable_for_jobs(self, db: Database, jobs: list[QuestionGenerationJob]) -> bool:
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
            name=f"question-job-{job_id[:8]}",
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
            name=f"manual-question-generation-{operation_id[:8]}",
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
            if operation.status != ManualQuestionGenerationStatus.RUNNING:
                return
            chunks = self._sources.chunks_of(operation.project_id, operation.source_id)
            if not chunks:
                raise ValueError("Document has no extracted text chunks.")
            _reset_generation_attribution(self._provider)
            generation = write_questions_with_annotations_for_strategy(
                self._provider,
                chunks,
                operation.limit,
                QuestionGenerationStrategy(operation.strategy),
                reading_lexicon=self._reading_lexicon,
            )
            suggestions = generation.suggestions
            attribution = _generation_attribution(
                self._provider,
                generated=bool(suggestions),
                dictionary_only=bool(suggestions) and all(
                    suggestion.dictionary_generated for suggestion in suggestions
                ),
            )
            manual_operations.begin_commit(db, operation_id)
            questions_repository.append_generated_questions_and_complete_manual_operation(
                db,
                operation_id=operation_id,
                project_id=operation.project_id,
                source_id=operation.source_id,
                suggestions=suggestions,
                effective_provider=attribution.effective_provider,
                effective_model=attribution.effective_model,
                fallback_reason=attribution.fallback_reason,
                question_count=self._question_count,
                unavailable_blocks=generation.unavailable_blocks,
                projects=self._projects,
            )
        except QuestionJobCanceledError:
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
    job: QuestionGenerationJob,
    unavailable_reason: str | None,
    detail: str,
) -> None:
    reason = unavailable_reason or "provider_unavailable"
    if reason == "model_missing":
        question_generation_jobs.mark_skipped_missing_model(db, job.id, detail=detail)
        return

    question_generation_jobs.mark_skipped_provider_unavailable(db, job.id, detail=detail)


def _generate_fast_first_questions(
    provider: LLMProvider,
    source_chunk: SourceChunk,
    limit: int,
    strategy: QuestionGenerationStrategy,
    *,
    reading_lexicon: ReadingLexicon | None = None,
) -> list[QuestionSuggestion]:
    first_limit = min(limit, 1)
    if first_limit <= 0:
        return []
    if strategy == QuestionGenerationStrategy.HYBRID_REASONING:
        deterministic = extract_jlpt_question_blocks([source_chunk], 1)
        writer = question_writer_for(provider, reading_lexicon=reading_lexicon)
        fast_first_provider = provider_capability(writer, FastFirstQuestionWriter)
        if deterministic and fast_first_provider is not None:
            try:
                suggestion = _call_background_provider_method(
                    provider,
                    fast_first_provider.write_fast_first_question,
                    source_chunk,
                    deterministic[0],
                )
            except LanguageModelUnavailable as exc:
                if not is_non_fatal_generation_error(exc):
                    raise
                suggestion = None
            if suggestion is not None:
                return [suggestion]

        # Same order as the batch path (question_writing.write_questions_with_annotations_
        # for_strategy): only a page without a usable parsed block goes to model
        # extraction, and its items pass domain/question_admission.py.
        reasoning_provider = provider_capability(writer, ReasoningQuestionWriter)
        if reasoning_provider is not None:
            prompt_chunk = _compact_reasoning_chunk(source_chunk)
            try:
                suggestions = _call_background_provider_method(
                    provider,
                    reasoning_provider.write_reasoning_questions,
                    [prompt_chunk],
                    first_limit,
                    num_ctx=FAST_FIRST_NUM_CTX,
                    num_predict=FAST_FIRST_NUM_PREDICT,
                )
            except LanguageModelUnavailable as exc:
                if not is_non_fatal_generation_error(exc):
                    raise
                return []
            if suggestions:
                return _with_chunk_source_order(suggestions, source_chunk)
            return []

    return write_questions_for_strategy(
        provider, [source_chunk], first_limit, strategy, reading_lexicon=reading_lexicon
    )


def _call_background_provider_method(
    provider: LLMProvider,
    method,
    *args,
    **kwargs,
):
    kwargs.update(_background_generation_kwargs(provider))
    return method(*args, **kwargs)


def _background_generation_kwargs(provider: LLMProvider) -> dict[str, object]:
    options_provider = provider_capability(provider, BackgroundGenerationOptionsProvider)
    if options_provider is None:
        return {}
    return dict(options_provider.background_generation_kwargs())


def _provider_starts_on_generation(provider: LLMProvider) -> bool:
    starts_provider = provider_capability(provider, StartsOnGenerationProvider)
    return bool(starts_provider and starts_provider.starts_on_generation)


def _reset_generation_attribution(provider: LLMProvider) -> None:
    attribution_provider = provider_capability(provider, GenerationAttributionProvider)
    if attribution_provider is not None:
        attribution_provider.reset_generation_attribution()


def _generation_attribution(
    provider: LLMProvider,
    *,
    generated: bool,
    dictionary_only: bool = False,
) -> GenerationAttribution:
    if dictionary_only:
        return GenerationAttribution(None, None)
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


def _should_enqueue_chunk(
    source_chunk: SourceChunk,
    strategy: QuestionGenerationStrategy,
) -> bool:
    if strategy == QuestionGenerationStrategy.HYBRID_REASONING:
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


class QuestionJobWork:
    """Background question generation of one database, run by the scheduler."""

    def __init__(self, manager: QuestionJobScheduler, db: Database) -> None:
        self._manager = manager
        self._db = db

    def enqueue_source(self, project_id: str, source_id: str) -> None:
        self._manager.enqueue_source(
            self._db, project_id=project_id, source_id=source_id
        )

    def retry_jobs(self, project_id: str, source_id: str) -> list[QuestionGenerationJob]:
        return self._manager.retry_source_jobs(
            self._db, project_id=project_id, source_id=source_id
        )

    def start_manual_operation(
        self,
        project_id: str,
        source_id: str,
        limit: int,
        strategy: QuestionGenerationStrategy,
    ) -> ManualQuestionGeneration:
        return self._manager.start_manual_operation(
            self._db,
            project_id=project_id,
            source_id=source_id,
            limit=limit,
            strategy=strategy,
        )

    def manual_operation(
        self, project_id: str, source_id: str, operation_id: str
    ) -> ManualQuestionGeneration:
        return self._manager.get_manual_operation(
            self._db, project_id=project_id, source_id=source_id, operation_id=operation_id
        )

    def cancel_manual_operation(
        self, project_id: str, source_id: str, operation_id: str
    ) -> ManualQuestionGeneration:
        return self._manager.cancel_manual_operation(
            self._db, project_id=project_id, source_id=source_id, operation_id=operation_id
        )
