"""Source Library as the source of questions: a source's chunks, and its count of questions."""

from __future__ import annotations

from cert_prep_backend.authoring.domain.models import SourceChunk, to_source_chunk
from cert_prep_backend.source_library.application import use_cases as source_library
from cert_prep_backend.source_library.application.ports import SourceRepository


class SourceLibraryQuestionSources:
    """Reads chunks through Source Library's use cases and records a source's question count."""

    def __init__(self, sources: SourceRepository) -> None:
        self._sources = sources

    def chunks_of(self, project_id: str, source_id: str) -> list[SourceChunk]:
        return [
            to_source_chunk(chunk)
            for chunk in source_library.list_chunks(self._sources, project_id, source_id)
        ]

    def chunk(self, project_id: str, source_id: str, chunk_id: str) -> SourceChunk:
        return to_source_chunk(
            source_library.view_chunk(self._sources, project_id, source_id, chunk_id)
        )

    def record_question_count(self, project_id: str, source_id: str, count: int) -> None:
        source_library.record_question_count(self._sources, project_id, source_id, count)

    def record_import_question_count(self, project_id: str, source_id: str, count: int) -> None:
        source_library.record_import_question_count(self._sources, project_id, source_id, count)
