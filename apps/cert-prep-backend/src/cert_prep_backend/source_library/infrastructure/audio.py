from __future__ import annotations

from collections.abc import Callable
from sqlite3 import Connection

from cert_prep_backend.platform.errors import (
    DocumentOperationStateError,
    DocumentProcessingCanceledError,
)
from cert_prep_backend.platform.database import Database
from cert_prep_backend.source_library.application.ports import TraditionalChineseTranslator
from cert_prep_backend.source_library.domain.document import DocumentChunk
from cert_prep_backend.source_library.infrastructure import chunks


class DocumentChunkTranslator:
    """Translates a document's transcript chunks with the injected text translator."""

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

    def translate_chunk(self, project_id: str, document_id: str, chunk_id: str) -> DocumentChunk:
        return translate_chunk(
            self._db,
            translator=self._translator(),
            project_id=project_id,
            document_id=document_id,
            chunk_id=chunk_id,
        )

    def translate_stale_chunks(self, project_id: str, document_id: str) -> list[DocumentChunk]:
        return translate_stale_chunks(
            self._db,
            translator=self._batch_translator(),
            project_id=project_id,
            document_id=document_id,
        )


def translate_chunk(
    db: Database,
    *,
    translator: TraditionalChineseTranslator,
    project_id: str,
    document_id: str,
    chunk_id: str,
    should_cancel: Callable[[], bool] | None = None,
    operation_id: str | None = None,
    reconcile_document_status: bool = True,
) -> DocumentChunk:
    _raise_if_translation_canceled(should_cancel)
    chunk = chunks.get_chunk(db, project_id, document_id, chunk_id)
    expected_source_revision = chunk.source_revision
    translated = translator.translate(chunk.text)
    _raise_if_translation_canceled(should_cancel)
    if not translated:
        raise ValueError('Translation provider returned empty text.')
    with db.connect() as connection:
        connection.execute('BEGIN IMMEDIATE')
        if operation_id is not None:
            _ensure_translation_operation_active(
                connection,
                project_id=project_id,
                document_id=document_id,
                operation_id=operation_id,
            )
        chunks.compare_and_set_chunk_translation(
            connection,
            project_id=project_id,
            document_id=document_id,
            chunk_id=chunk_id,
            translated_text=translated,
            expected_source_revision=expected_source_revision,
        )
    current = chunks.get_chunk(db, project_id, document_id, chunk_id)
    if reconcile_document_status:
        chunks.reconcile_document_translation_status(
            db,
            project_id=project_id,
            document_id=document_id,
        )
    return current


def translate_stale_chunks(
    db: Database,
    *,
    translator: TraditionalChineseTranslator,
    project_id: str,
    document_id: str,
    should_cancel: Callable[[], bool] | None = None,
    operation_id: str | None = None,
    reconcile_document_status: bool = True,
) -> list[DocumentChunk]:
    has_translatable_chunks = False
    try:
        items = chunks.list_chunks(db, project_id, document_id)
        has_translatable_chunks = bool(items)
        translated: list[DocumentChunk] = []
        for item in items:
            _raise_if_translation_canceled(should_cancel)
            if item.translation_stale:
                translated.append(
                    translate_chunk(
                        db,
                        translator=translator,
                        project_id=project_id,
                        document_id=document_id,
                        chunk_id=item.id,
                        should_cancel=should_cancel,
                        operation_id=operation_id,
                        reconcile_document_status=False,
                    )
                )
        return translated
    finally:
        release_resources = getattr(translator, 'release_resources', None)
        if callable(release_resources):
            release_resources()
        if reconcile_document_status and has_translatable_chunks:
            chunks.reconcile_document_translation_status(
                db,
                project_id=project_id,
                document_id=document_id,
            )


def _ensure_translation_operation_active(
    connection: Connection,
    *,
    project_id: str,
    document_id: str,
    operation_id: str,
) -> None:
    row = connection.execute(
        'SELECT status, phase, cancellable, document_id FROM document_operations '
        'WHERE id = ? AND project_id = ?',
        (operation_id, project_id),
    ).fetchone()
    if row is not None and row['status'] in {'cancel_requested', 'canceled'}:
        raise DocumentProcessingCanceledError('Document translation was canceled.')
    if not (
        row is not None
        and row['document_id'] == document_id
        and row['status'] == 'running'
        and row['cancellable']
    ):
        raise DocumentOperationStateError(
            'Document translation operation is no longer active.'
        )


def _raise_if_translation_canceled(
    should_cancel: Callable[[], bool] | None,
) -> None:
    if should_cancel is not None and should_cancel():
        raise DocumentProcessingCanceledError('Document translation was canceled.')
