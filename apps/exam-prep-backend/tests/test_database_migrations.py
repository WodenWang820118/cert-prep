from __future__ import annotations

from pathlib import Path

from exam_prep_backend.config import Settings
from exam_prep_backend.database import Database


def test_saved_exam_runtime_metadata_columns_are_migrated(tmp_path: Path) -> None:
    db = Database(Settings(data_dir=tmp_path, api_token="test-token"))
    db.migrate()

    with db.connect() as connection:
        document_columns = _columns(connection, "documents")
        chunk_columns = _columns(connection, "document_chunks")
        draft_columns = _columns(connection, "question_drafts")
        session_columns = _columns(connection, "practice_sessions")

    assert document_columns["content_profile"] == "'unknown'"
    assert "classification_detail" in document_columns
    assert {
        "parse_wall_duration_ms",
        "render_duration_ms",
        "ocr_engine_duration_ms",
        "ocr_worker_count",
        "first_chunk_ms",
    } <= set(document_columns)
    assert {"raw_text", "line_start", "line_end", "line_count", "content_profile"} <= set(
        chunk_columns
    )
    assert {
        "source_order",
        "source_question_number",
        "item_kind",
        "group_key",
        "group_prompt",
        "confidence",
    } <= set(draft_columns)
    assert session_columns["mode"] == "'random_draw'"
    assert {
        "source_document_id",
        "requested_question_count",
        "random_seed",
    } <= set(session_columns)


def _columns(connection, table_name: str) -> dict[str, str | None]:
    rows = connection.execute(f"PRAGMA table_info({table_name})").fetchall()
    return {row["name"]: row["dflt_value"] for row in rows}
