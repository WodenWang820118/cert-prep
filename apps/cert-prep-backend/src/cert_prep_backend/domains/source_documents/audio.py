from __future__ import annotations

from collections.abc import Callable
from sqlite3 import Connection

from ollama import Client

from cert_prep_backend.core.config import Settings
from cert_prep_backend.core.exceptions import (
    DocumentOperationStateError,
    DocumentProcessingCanceledError,
)
from cert_prep_backend.persistence.database import Database
from cert_prep_backend.domains.source_documents import chunks


TRANSLATION_OPTIONS = {
    'temperature': 0,
    'num_ctx': 2048,
    'num_predict': 512,
}
BATCH_TRANSLATION_KEEP_ALIVE = '5m'


class OllamaTraditionalChineseTranslator:
    def __init__(
        self,
        settings: Settings,
        *,
        keep_alive: str | float | int | None = 0,
    ) -> None:
        self._client = Client(
            host=settings.ollama_host,
            timeout=settings.ollama_timeout_seconds,
        )
        self._model = settings.ollama_model
        self._keep_alive = keep_alive
        self._released = False

    def translate(self, japanese: str) -> str:
        response = self._client.chat(
            model=self._model,
            messages=[
                {
                    'role': 'system',
                    'content': (
                        'Translate Japanese into natural Traditional Chinese used in Taiwan. '
                        'Return only the translation. Preserve names, numbers, and meaning.'
                    ),
                },
                {'role': 'user', 'content': japanese},
            ],
            options=TRANSLATION_OPTIONS,
            think=False,
            stream=False,
            keep_alive=self._keep_alive,
        )
        return str(response.message.content or '').strip()

    def release_resources(self) -> None:
        if self._released or self._keep_alive == 0:
            return
        self._released = True
        self._client.generate(model=self._model, keep_alive=0)


def translate_chunk(
    db: Database,
    *,
    translator,
    project_id: str,
    document_id: str,
    chunk_id: str,
    should_cancel: Callable[[], bool] | None = None,
    operation_id: str | None = None,
    reconcile_document_status: bool = True,
) -> dict:
    _raise_if_translation_canceled(should_cancel)
    chunk = chunks.get_chunk(db, project_id, document_id, chunk_id)
    expected_source_revision = chunk['source_revision']
    translated = translator.translate(chunk['text'])
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
    translator,
    project_id: str,
    document_id: str,
    should_cancel: Callable[[], bool] | None = None,
    operation_id: str | None = None,
    reconcile_document_status: bool = True,
) -> list[dict]:
    has_translatable_chunks = False
    try:
        items = chunks.list_chunks(db, project_id, document_id)
        has_translatable_chunks = bool(items)
        translated: list[dict] = []
        for item in items:
            _raise_if_translation_canceled(should_cancel)
            if item['translation_stale']:
                translated.append(
                    translate_chunk(
                        db,
                        translator=translator,
                        project_id=project_id,
                        document_id=document_id,
                        chunk_id=item['id'],
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
