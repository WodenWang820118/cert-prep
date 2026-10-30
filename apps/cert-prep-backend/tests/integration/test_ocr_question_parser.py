from pathlib import Path

from cert_prep_backend.authoring.domain.deterministic_parser import extract_jlpt_question_blocks
from cert_prep_backend.authoring.domain.models import source_chunk_from_document_chunk
from cert_prep_backend.authoring.domain.normalization import as_editable_question
from cert_prep_backend.authoring.domain.reading_solver import section_asks_for_reading
from cert_prep_backend.platform.config import Settings
from cert_prep_backend.platform.database import Database
from cert_prep_backend.source_library.domain.document import ExtractedPage
from cert_prep_backend.source_library.domain.exam_content import classify_exam_text
from cert_prep_backend.source_library.infrastructure.chunks import get_source_chunks, sync_document_chunks


def test_persisted_ocr_keeps_original_text_and_reading_instruction(tmp_path: Path) -> None:
    instruction = "問題Ⅰ 漢字の読み方をⅠ２3４からーつ選びなさい。"
    text = f"日本語能力試験NI\n{instruction}(1*6)\n１\n港へ荷物を運んだ。\nIはこんだ２はさんだ3はばんだ４はらんだ"
    db = Database(Settings(data_dir=tmp_path, api_token="test-token"))
    db.migrate()
    with db.connect() as connection:
        connection.execute(
            "INSERT INTO projects(id, name, description, created_at, updated_at) "
            "VALUES ('project', 'Project', '', '2026-01-01', '2026-01-01')"
        )
        connection.execute(
            "INSERT INTO documents(id, project_id, filename, sha256, storage_path, "
            "page_count, has_text, status, created_at, updated_at) "
            "VALUES ('document', 'project', 'test.pdf', 'hash', 'test.pdf', "
            "1, 1, 'ready', '2026-01-01', '2026-01-01')"
        )
        sync_document_chunks(
            connection, project_id="project", document_id="document",
            pages=(ExtractedPage(
                1, text, "", "ocr", raw_text=text,
                content_profile=classify_exam_text(text).content_profile,
            ),),
            now="2026-01-01",
        )
    chunks = [source_chunk_from_document_chunk(chunk)
              for chunk in get_source_chunks(db, "project", "document")]
    assert chunks[0].raw_or_text() == text
    suggestions = extract_jlpt_question_blocks(chunks, limit=10)
    assert len(suggestions) == 1
    editable = as_editable_question(suggestions[0])
    assert editable.question == "港へ荷物を運んだ。"
    assert editable.section_instruction == instruction
    assert section_asks_for_reading(editable.section_instruction)
    assert suggestions[0].choices == ("1 はこんだ", "2 はさんだ", "3 はばんだ", "4 はらんだ")
