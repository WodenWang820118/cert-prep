"""Question Authoring as the drafting the Source Library starts once an import has chunks."""

from __future__ import annotations

from cert_prep_backend.authoring.application import use_cases as authoring
from cert_prep_backend.authoring.application.ports import (
    DraftGenerationWork,
    DraftSources,
    DraftWriting,
    QuestionDraftRepository,
)
from cert_prep_backend.platform.config import Settings


class ImportedDocumentDrafts:
    """Starts an imported document's drafts as the settings configure them."""

    def __init__(
        self,
        *,
        work: DraftGenerationWork,
        drafts: QuestionDraftRepository,
        sources: DraftSources,
        writing: DraftWriting,
        model: object,
        settings: Settings,
    ) -> None:
        self._work = work
        self._drafts = drafts
        self._sources = sources
        self._writing = writing
        self._model = model
        self._settings = settings

    def draft_questions(self, project_id: str, document_id: str) -> None:
        authoring.draft_imported_document(
            self._work,
            self._drafts,
            self._sources,
            self._writing,
            self._model,
            project_id=project_id,
            document_id=document_id,
            streams_drafts=self._settings.streaming_draft_generation_on_upload,
            writes_drafts=self._settings.auto_generate_exam_on_upload,
            limit=self._settings.auto_generate_exam_limit,
        )


__all__ = ["ImportedDocumentDrafts"]
