from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from sqlite3 import Connection
from tempfile import NamedTemporaryFile

from ollama import Client

from cert_prep_contracts.transcription import (
    TranscriptSegment,
    TranscriptionCanceledError,
    TranscriptionProvider,
)

from cert_prep_backend.core.config import Settings
from cert_prep_backend.core.exceptions import (
    DocumentOperationStateError,
    DocumentProcessingCanceledError,
)
from cert_prep_backend.persistence.database import Database, utc_now
from cert_prep_backend.domains.source_documents import chunks


TRANSLATION_OPTIONS = {
    "temperature": 0,
    "num_ctx": 2048,
    "num_predict": 512,
}
BATCH_TRANSLATION_KEEP_ALIVE = "5m"


def transcribe_audio(
    db: Database,
    *,
    settings: Settings,
    provider: TranscriptionProvider,
    project_id: str,
    document_id: str,
    operation_id: str,
    source_bytes: bytes,
    suffix: str,
) -> dict:
    next_chunk_index = 0

    def operation_canceled() -> bool:
        return not _audio_operation_is_active(
            db,
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
            phase="transcribing",
        )

    def reset_segments() -> None:
        nonlocal next_chunk_index
        with db.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            _ensure_audio_operation_active(
                connection,
                project_id=project_id,
                document_id=document_id,
                operation_id=operation_id,
                phase="transcribing",
            )
            chunks.delete_audio_segments(
                connection,
                project_id=project_id,
                document_id=document_id,
            )
            _update_incremental_document_state(
                connection,
                project_id=project_id,
                document_id=document_id,
                chunks_count=0,
            )
        next_chunk_index = 0

    def persist_segment(segment: TranscriptSegment) -> None:
        nonlocal next_chunk_index
        with db.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            _ensure_audio_operation_active(
                connection,
                project_id=project_id,
                document_id=document_id,
                operation_id=operation_id,
                phase="transcribing",
            )
            chunks.insert_audio_segment(
                connection,
                project_id=project_id,
                document_id=document_id,
                chunk_index=next_chunk_index,
                segment=segment,
                now=utc_now(),
            )
            next_chunk_index += 1
            _update_incremental_document_state(
                connection,
                project_id=project_id,
                document_id=document_id,
                chunks_count=next_chunk_index,
            )

    reset_segments()
    path: Path | None = None
    try:
        with NamedTemporaryFile(suffix=suffix, delete=False) as temporary:
            path = Path(temporary.name)
            temporary.write(source_bytes)
        result = provider.transcribe(
            str(path),
            on_segment=persist_segment,
            should_cancel=operation_canceled,
            on_segments_reset=reset_segments,
        )
    except TranscriptionCanceledError as exc:
        raise DocumentProcessingCanceledError(str(exc)) from exc
    finally:
        if path is not None:
            path.unlink(missing_ok=True)

    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        _ensure_audio_operation_active(
            connection,
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
            phase="transcribing",
        )
        persisted_count = connection.execute(
            """
            SELECT COUNT(*) FROM document_chunks
            WHERE project_id = ? AND document_id = ? AND locator_kind = 'time'
            """,
            (project_id, document_id),
        ).fetchone()[0]
        document_updated = connection.execute(
            """
            UPDATE documents
            SET duration_ms = ?, transcription_status = 'succeeded',
                translation_status = 'pending', configured_transcription_model = ?,
                effective_transcription_model = ?, transcription_device = ?,
                transcription_warning = ?, has_text = ?, extraction_method = 'transcription',
                processed_page_count = ?, content_profile = 'study_material', updated_at = ?
            WHERE project_id = ? AND id = ?
            """,
            (
                result.duration_ms,
                result.configured_model,
                result.effective_model,
                result.device,
                result.warning,
                int(bool(result.segments)),
                persisted_count,
                now,
                project_id,
                document_id,
            ),
        )
        if document_updated.rowcount != 1:
            raise DocumentOperationStateError(
                "Audio transcription metadata could not be persisted."
            )
    return {"segments": result.segments}


class OllamaTraditionalChineseTranslator:
    def __init__(
        self,
        settings: Settings,
        *,
        keep_alive: str | float | int | None = 0,
    ) -> None:
        self._client = Client(host=settings.ollama_host, timeout=settings.ollama_timeout_seconds)
        self._model = settings.ollama_model
        self._keep_alive = keep_alive
        self._released = False

    def translate(self, japanese: str) -> str:
        response = self._client.chat(
            model=self._model,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Translate Japanese into natural Traditional Chinese used in Taiwan. "
                        "Return only the translation. Preserve names, numbers, and meaning."
                    ),
                },
                {"role": "user", "content": japanese},
            ],
            options=TRANSLATION_OPTIONS,
            think=False,
            stream=False,
            keep_alive=self._keep_alive,
        )
        return str(response.message.content or "").strip()

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
    expected_source_revision = chunk["source_revision"]
    translated = translator.translate(chunk["text"])
    _raise_if_translation_canceled(should_cancel)
    if not translated:
        raise ValueError("Translation provider returned empty text.")
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        if operation_id is not None:
            _ensure_audio_operation_active(
                connection,
                project_id=project_id,
                document_id=document_id,
                operation_id=operation_id,
                phase="translating",
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
    has_time_chunks = False
    try:
        items = chunks.list_chunks(db, project_id, document_id)
        has_time_chunks = any(item["locator_kind"] == "time" for item in items)
        translated: list[dict] = []
        for item in items:
            _raise_if_translation_canceled(should_cancel)
            if item["locator_kind"] == "time" and item["translation_stale"]:
                translated.append(
                    translate_chunk(
                        db,
                        translator=translator,
                        project_id=project_id,
                        document_id=document_id,
                        chunk_id=item["id"],
                        should_cancel=should_cancel,
                        operation_id=operation_id,
                        reconcile_document_status=False,
                    )
                )
        return translated
    finally:
        release_resources = getattr(translator, "release_resources", None)
        if callable(release_resources):
            release_resources()
        if reconcile_document_status and has_time_chunks:
            chunks.reconcile_document_translation_status(
                db,
                project_id=project_id,
                document_id=document_id,
            )


def set_operation_phase(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    operation_id: str,
    phase: str,
) -> None:
    expected_phase = {
        "transcribing": "processing",
        "translating": "transcribing",
    }.get(phase)
    if expected_phase is None:
        raise ValueError(f"Unsupported audio operation phase: {phase}")
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        _ensure_audio_operation_active(
            connection,
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
            phase=expected_phase,
        )
        updated = connection.execute(
            """
            UPDATE document_operations SET phase = ?, updated_at = ?
            WHERE id = ? AND project_id = ? AND document_id = ?
                AND status = 'running' AND phase = ? AND cancellable = 1
            """,
            (
                phase,
                utc_now(),
                operation_id,
                project_id,
                document_id,
                expected_phase,
            ),
        )
        if updated.rowcount != 1:
            raise DocumentOperationStateError(
                "Audio operation phase could not be updated."
            )


def complete_audio_operation(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    operation_id: str,
    translation_succeeded: bool,
) -> None:
    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        _ensure_audio_operation_active(
            connection,
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
            phase="translating",
        )
        committing = connection.execute(
            """
            UPDATE document_operations
            SET phase = 'committing', cancellable = 0, updated_at = ?
            WHERE id = ? AND project_id = ? AND document_id = ?
                AND status = 'running' AND phase = 'translating' AND cancellable = 1
            """,
            (now, operation_id, project_id, document_id),
        )
        if committing.rowcount != 1:
            raise DocumentOperationStateError(
                "Audio operation could not begin its completion commit."
            )
        translation_complete = translation_succeeded and chunks.translation_is_complete(
            connection,
            project_id=project_id,
            document_id=document_id,
        )
        chunks_count = connection.execute(
            """
            SELECT COUNT(*) FROM document_chunks
            WHERE project_id = ? AND document_id = ? AND locator_kind = 'time'
            """,
            (project_id, document_id),
        ).fetchone()[0]
        document_updated = connection.execute(
            """
            UPDATE documents SET status = ?,
                translation_status = ?, updated_at = ?
            WHERE project_id = ? AND id = ?
            """,
            (
                "ready" if chunks_count > 0 else "no_text_detected",
                (
                    "succeeded"
                    if translation_complete
                    else "failed"
                    if chunks_count > 0
                    else "not_applicable"
                ),
                now,
                project_id,
                document_id,
            ),
        )
        if document_updated.rowcount != 1:
            raise DocumentOperationStateError(
                "Audio document could not be completed."
            )
        operation_completed = connection.execute(
            """
            UPDATE document_operations
            SET status = 'succeeded', phase = 'completed', cancellable = 0,
                error = NULL, updated_at = ?
            WHERE id = ? AND project_id = ? AND document_id = ?
                AND status = 'running' AND phase = 'committing' AND cancellable = 0
            """,
            (now, operation_id, project_id, document_id),
        )
        if operation_completed.rowcount != 1:
            raise DocumentOperationStateError(
                "Audio operation success could not be committed."
            )


def audio_operation_is_active(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    operation_id: str,
    phase: str,
) -> bool:
    return _audio_operation_is_active(
        db,
        project_id=project_id,
        document_id=document_id,
        operation_id=operation_id,
        phase=phase,
    )


def _audio_operation_is_active(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    operation_id: str,
    phase: str,
) -> bool:
    with db.connect() as connection:
        row = connection.execute(
            """
            SELECT status, phase, cancellable, document_id
            FROM document_operations WHERE id = ? AND project_id = ?
            """,
            (operation_id, project_id),
        ).fetchone()
    return bool(
        row is not None
        and row["document_id"] == document_id
        and row["status"] == "running"
        and row["phase"] == phase
        and row["cancellable"]
    )


def _ensure_audio_operation_active(
    connection: Connection,
    *,
    project_id: str,
    document_id: str,
    operation_id: str,
    phase: str,
) -> None:
    row = connection.execute(
        """
        SELECT status, phase, cancellable, document_id
        FROM document_operations WHERE id = ? AND project_id = ?
        """,
        (operation_id, project_id),
    ).fetchone()
    if row is not None and row["status"] in {"cancel_requested", "canceled"}:
        raise DocumentProcessingCanceledError("Audio processing was canceled.")
    if not (
        row is not None
        and row["document_id"] == document_id
        and row["status"] == "running"
        and row["phase"] == phase
        and row["cancellable"]
    ):
        raise DocumentOperationStateError(
            "Audio processing operation is no longer active."
        )


def _update_incremental_document_state(
    connection: Connection,
    *,
    project_id: str,
    document_id: str,
    chunks_count: int,
) -> None:
    connection.execute(
        """
        UPDATE documents
        SET has_text = ?, extraction_method = ?, processed_page_count = ?,
            content_profile = ?, updated_at = ?
        WHERE project_id = ? AND id = ? AND source_kind = 'audio'
        """,
        (
            int(chunks_count > 0),
            "transcription" if chunks_count > 0 else "none",
            chunks_count,
            "study_material" if chunks_count > 0 else "unknown",
            utc_now(),
            project_id,
            document_id,
        ),
    )


def _raise_if_translation_canceled(
    should_cancel: Callable[[], bool] | None,
) -> None:
    if should_cancel is not None and should_cancel():
        raise DocumentProcessingCanceledError("Audio translation was canceled.")
