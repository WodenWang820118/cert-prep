"""Use cases of Question Authoring, named after what the learner does with questions."""

from __future__ import annotations

from collections.abc import Sequence

from cert_prep_backend.authoring.application.ports import (
    QuestionGenerationJobRepository,
    QuestionGenerationWork,
    QuestionSources,
    QuestionWriting,
    QuestionRepository,
)
from cert_prep_backend.authoring.domain.question import QuestionEdit, NewQuestion, Question
from cert_prep_backend.authoring.domain.generation import QuestionGenerationJob, ManualQuestionGeneration
from cert_prep_backend.authoring.domain.models import QuestionGenerationStrategy
from cert_prep_backend.authoring.domain.normalization import as_editable_question
from cert_prep_backend.platform.errors import LanguageModelUnavailable, ValidationError

__all__ = [
    "source_questions",
    "cancel_generation_job",
    "cancel_manual_generation",
    "discard_unfinished_generation_jobs",
    "generate_imported_questions",
    "edit_question",
    "find_question",
    "generate_source_questions",
    "list_questions",
    "list_generation_jobs",
    "questions_for",
    "retry_generation_jobs",
    "start_manual_generation",
    "view_manual_generation",
    "write_question",
]


def list_questions(questions: QuestionRepository, project_id: str) -> list[Question]:
    return questions.questions_of(project_id)


def source_questions(
    questions: QuestionRepository, project_id: str, *, source_id: str | None
) -> list[Question]:
    """Questions of a project, by id, or of one source in source order."""

    return questions.for_source(project_id, source_id=source_id)


def find_question(
    questions: QuestionRepository, project_id: str, question_id: str
) -> Question | None:
    """The project's current question, or None when it is gone."""

    return questions.find(project_id, question_id)


def questions_for(
    questions: QuestionRepository, project_id: str, question_ids: Sequence[str]
) -> list[Question]:
    """The project's current questions for these ids; ids with no question are absent."""

    return questions.find_many(project_id, question_ids)


def write_question(
    questions: QuestionRepository, project_id: str, authored_question: NewQuestion
) -> Question:
    return questions.write(project_id, authored_question)


def edit_question(
    questions: QuestionRepository, project_id: str, question_id: str, edit: QuestionEdit
) -> Question:
    return questions.edit(project_id, question_id, edit)


def generate_source_questions(
    questions: QuestionRepository,
    sources: QuestionSources,
    writing: QuestionWriting,
    model: object,
    *,
    project_id: str,
    source_id: str,
    limit: int,
    strategy: QuestionGenerationStrategy,
) -> list[Question]:
    """Write questions from every chunk of a source now, and record how many it has in all."""

    chunks = sources.chunks_of(project_id, source_id)
    if not chunks:
        raise ValidationError("Document has no extracted text chunks.")
    suggestions = writing.suggestions(model, chunks, limit, strategy)
    return questions.append_generated_questions_and_record_count(project_id, source_id, suggestions)


def list_generation_jobs(
    jobs: QuestionGenerationJobRepository, project_id: str, source_id: str
) -> list[QuestionGenerationJob]:
    return jobs.jobs_of(project_id, source_id)


def retry_generation_jobs(
    work: QuestionGenerationWork, project_id: str, source_id: str
) -> list[QuestionGenerationJob]:
    """Run again the jobs of a source that ended without questions."""

    return work.retry_jobs(project_id, source_id)


def cancel_generation_job(
    jobs: QuestionGenerationJobRepository, project_id: str, source_id: str, job_id: str
) -> QuestionGenerationJob:
    return jobs.cancel(project_id, source_id, job_id)


def discard_unfinished_generation_jobs(
    jobs: QuestionGenerationJobRepository, project_id: str, source_id: str
) -> None:
    """Drop the source's jobs that have not ended, because its source text is being redone.

    Source Library calls this when a run of the source stops or is retried. Ended jobs stay
    as the source's question generation history.
    """

    jobs.discard_unfinished(project_id, source_id)


def start_manual_generation(
    work: QuestionGenerationWork,
    project_id: str,
    source_id: str,
    *,
    limit: int,
    strategy: QuestionGenerationStrategy,
) -> ManualQuestionGeneration:
    """Generate questions for a whole source in the background; one operation at a time."""

    return work.start_manual_operation(project_id, source_id, limit, strategy)


def view_manual_generation(
    work: QuestionGenerationWork, project_id: str, source_id: str, operation_id: str
) -> ManualQuestionGeneration:
    return work.manual_operation(project_id, source_id, operation_id)


def cancel_manual_generation(
    work: QuestionGenerationWork, project_id: str, source_id: str, operation_id: str
) -> ManualQuestionGeneration:
    return work.cancel_manual_operation(project_id, source_id, operation_id)


def generate_imported_questions(
    work: QuestionGenerationWork,
    questions: QuestionRepository,
    sources: QuestionSources,
    writing: QuestionWriting,
    model: object,
    *,
    project_id: str,
    source_id: str,
    schedules_question_jobs: bool,
    writes_questions: bool,
    limit: int,
) -> None:
    """Start the questions of a source whose import produced chunks.

    The scheduler queues a job per chunk. When the settings write questions at import instead, and
    only then, up to `limit` questions are written now; an unavailable model writes none, and the
    source records how many questions it has in all.
    """

    work.enqueue_source(project_id, source_id)
    if schedules_question_jobs or not writes_questions:
        return
    chunks = sources.chunks_of(project_id, source_id)
    try:
        suggestions = [
            as_editable_question(suggestion)
            for suggestion in writing.import_suggestions(model, chunks, limit)
        ]
    except LanguageModelUnavailable:
        suggestions = []
    questions.append_import_questions_and_record_count(project_id, source_id, suggestions)
