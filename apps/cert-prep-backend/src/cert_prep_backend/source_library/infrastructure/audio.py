from __future__ import annotations

from collections.abc import Callable
from sqlite3 import Connection

from cert_prep_backend.platform.errors import (
    SourceOperationStateError,
    SourceProcessingCanceledError,
)
from cert_prep_backend.platform.database import Database
from cert_prep_backend.source_library.application.ports import TraditionalChineseTranslator
from cert_prep_backend.source_library.domain.source import SourceChunk
from cert_prep_backend.source_library.infrastructure import chunks, sources


class SourceChunkTranslator:
    """Translates a source's transcript chunks with the injected text translator."""

    def __init__(
        self,
        db: Database,
        *,
        translator: Callable[[], TraditionalChineseTranslator],
        batch_translator: Callable[[], TraditionalChineseTranslator],
    ) -> None:
        self._db = db
        self._translator = translator
        self._batch_translator = batch_translator

    def translate_chunk(self, project_id: str, source_id: str, chunk_id: str) -> SourceChunk:
        return translate_chunk(
            self._db,
            translator=self._translator(),
            project_id=project_id,
            source_id=source_id,
            chunk_id=chunk_id,
        )

    def translate_stale_chunks(self, project_id: str, source_id: str) -> list[SourceChunk]:
        return translate_stale_chunks(
            self._db,
            translator=self._batch_translator(),
            project_id=project_id,
            source_id=source_id,
        )


def translate_chunk(
    db: Database,
    *,
    translator: TraditionalChineseTranslator,
    project_id: str,
    source_id: str,
    chunk_id: str,
    should_cancel: Callable[[], bool] | None = None,
    operation_id: str | None = None,
    reconcile_source_status: bool = True,
) -> SourceChunk:
    _raise_if_translation_canceled(should_cancel)
    chunk = chunks.get_chunk(db, project_id, source_id, chunk_id)
    expected_source_revision = chunk.source_revision
    source = sources.get_source(db, project_id, source_id)
    translated = translator.translate(
        chunk.text, source_language=source.language_hint
    )
    _raise_if_translation_canceled(should_cancel)
    if not translated:
        raise ValueError('Translation provider returned empty text.')
    with db.connect() as connection:
        connection.execute('BEGIN IMMEDIATE')
        if operation_id is not None:
            _ensure_translation_operation_active(
                connection,
                project_id=project_id,
                source_id=source_id,
                operation_id=operation_id,
            )
        chunks.compare_and_set_chunk_translation(
            connection,
            project_id=project_id,
            source_id=source_id,
            chunk_id=chunk_id,
            translated_text=translated,
            expected_source_revision=expected_source_revision,
        )
    current = chunks.get_chunk(db, project_id, source_id, chunk_id)
    if reconcile_source_status:
        chunks.reconcile_source_translation_status(
            db,
            project_id=project_id,
            source_id=source_id,
        )
    return current


def translate_stale_chunks(
    db: Database,
    *,
    translator: TraditionalChineseTranslator,
    project_id: str,
    source_id: str,
    should_cancel: Callable[[], bool] | None = None,
    operation_id: str | None = None,
    reconcile_source_status: bool = True,
) -> list[SourceChunk]:
    has_translatable_chunks = False
    try:
        items = chunks.list_chunks(db, project_id, source_id)
        has_translatable_chunks = bool(items)
        translated: list[SourceChunk] = []
        for item in items:
            _raise_if_translation_canceled(should_cancel)
            if item.translation_stale:
                translated.append(
                    translate_chunk(
                        db,
                        translator=translator,
                        project_id=project_id,
                        source_id=source_id,
                        chunk_id=item.id,
                        should_cancel=should_cancel,
                        operation_id=operation_id,
                        reconcile_source_status=False,
                    )
                )
        return translated
    finally:
        release_resources = getattr(translator, 'release_resources', None)
        if callable(release_resources):
            release_resources()
        if reconcile_source_status and has_translatable_chunks:
            chunks.reconcile_source_translation_status(
                db,
                project_id=project_id,
                source_id=source_id,
            )


def _ensure_translation_operation_active(
    connection: Connection,
    *,
    project_id: str,
    source_id: str,
    operation_id: str,
) -> None:
    row = connection.execute(
        'SELECT status, phase, cancellable, source_id FROM source_operations '
        'WHERE id = ? AND project_id = ?',
        (operation_id, project_id),
    ).fetchone()
    if row is not None and row['status'] in {'cancel_requested', 'canceled'}:
        raise SourceProcessingCanceledError('Document translation was canceled.')
    if not (
        row is not None
        and row['source_id'] == source_id
        and row['status'] == 'running'
        and row['cancellable']
    ):
        raise SourceOperationStateError(
            'Document translation operation is no longer active.'
        )


def _raise_if_translation_canceled(
    should_cancel: Callable[[], bool] | None,
) -> None:
    if should_cancel is not None and should_cancel():
        raise SourceProcessingCanceledError('Document translation was canceled.')
