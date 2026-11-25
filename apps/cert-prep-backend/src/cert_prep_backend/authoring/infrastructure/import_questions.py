"""Question Authoring generation that Source Library starts once an import has chunks."""

from __future__ import annotations

from cert_prep_backend.authoring.application import use_cases as authoring
from cert_prep_backend.authoring.application.ports import (
    QuestionGenerationWork,
    QuestionSources,
    QuestionWriting,
    QuestionRepository,
)
from cert_prep_backend.platform.config import Settings


class ImportedDocumentQuestionGeneration:
    """Starts an imported document's questions as the settings configure them."""

    def __init__(
        self,
        *,
        work: QuestionGenerationWork,
        questions: QuestionRepository,
        sources: QuestionSources,
        writing: QuestionWriting,
        model: object,
        settings: Settings,
    ) -> None:
        self._work = work
        self._questions = questions
        self._sources = sources
        self._writing = writing
        self._model = model
        self._settings = settings

    def start_question_generation(self, project_id: str, document_id: str) -> None:
        authoring.generate_imported_questions(
            self._work,
            self._questions,
            self._sources,
            self._writing,
            self._model,
            project_id=project_id,
            document_id=document_id,
            schedules_question_jobs=self._settings.question_jobs_on_upload,
            writes_questions=self._settings.write_questions_on_upload,
            limit=self._settings.write_questions_on_upload_limit,
        )


__all__ = ["ImportedDocumentQuestionGeneration"]
