from dataclasses import replace
from pathlib import Path

import pytest

from cert_prep_backend.authoring.domain.deterministic_parser import (
    extract_jlpt_question_blocks,
    is_exam_source_chunk,
)
from cert_prep_backend.authoring.domain.models import (
    SourceChunk,
    source_chunk_from_document_chunk,
)
from cert_prep_backend.platform.config import Settings
from cert_prep_backend.platform.database import Database
from cert_prep_backend.source_library.domain.document import DocumentChunk, ExtractedPage
from cert_prep_backend.source_library.infrastructure.chunks import (
    get_source_chunks,
    sync_document_chunks,
)


def test_formal_extractor_accepts_complete_questions_on_continuation_pages() -> None:
    chunk = SourceChunk(
        id="continuation",
        page_number=17,
        text="前のページから続く本文。\n57.内容はどれか。\n1 甲\n2 乙\n3 丙\n4 丁",
    )

    assert is_exam_source_chunk(chunk)
    suggestions = extract_jlpt_question_blocks([chunk], limit=10)

    assert len(suggestions) == 1
    assert suggestions[0].source_question_number == "57"
    assert suggestions[0].question == "内容はどれか。"
    assert suggestions[0].choices == ("1 甲", "2 乙", "3 丙", "4 丁")
    assert suggestions[0].chunk_id == "continuation"
    assert suggestions[0].citation_page == 17
    assert suggestions[0].answer == ""


def test_formal_extractor_keeps_notice_rejection_even_with_question_like_text() -> None:
    chunk = SourceChunk(
        id="notice",
        page_number=1,
        text="This test paper has multiple versions.\n1 Example? 1 A 2 B 3 C 4 D",
    )
    assert not is_exam_source_chunk(chunk)
    assert extract_jlpt_question_blocks([chunk], limit=10) == []


def _stored_chunk(chunk_id: str, page: int, text: str) -> SourceChunk:
    return source_chunk_from_document_chunk(
        DocumentChunk(
            id=chunk_id,
            document_id="document",
            page_number=page,
            chunk_index=page - 1,
            text=text,
            raw_text=text,
            line_start=1,
            line_end=10,
            line_count=10,
            source_excerpt="",
            extraction_method="ocr",
            content_profile="unknown",
            created_at="2026-01-01",
        )
    )


@pytest.mark.parametrize("delimiter", [" ", "、"])
def test_formal_extractor_completes_visible_options_across_same_document_pages(
    delimiter: str,
) -> None:
    first = _stored_chunk(
        "page-15", 15, "55.前の問い。\n1 甲\n2 乙\n3 丙\n4 丁\n56.続く問い。\n1 最初の選択\n読解"
    )
    second = _stored_chunk(
        "page-16",
        16,
        "2\n次の選択\n3 第三の選択\n4 最後の選択\n"
        f"問題10{delimiter}次の文章を読んで選びなさい。\n"
        "57.新しい問い。\n1 A\n2 B\n3 C\n4 D",
    )

    suggestions = extract_jlpt_question_blocks([first, second], limit=10)

    assert [s.source_question_number for s in suggestions] == ["55", "56", "57"]
    continued = suggestions[1]
    assert continued.question == "続く問い。"
    assert continued.choices == ("1 最初の選択 読解", "2 次の選択", "3 第三の選択", "4 最後の選択")
    assert continued.chunk_id == "page-15"
    assert continued.citation_page == 15
    assert [s.source_order for s in suggestions] == [164001, 164002, 175001]
    assert "問題10" not in continued.source_excerpt
    assert "読解" in continued.choices[0]
    assert first.raw_text.endswith("読解")
    assert second.raw_text.startswith("2\n次の選択")


@pytest.mark.parametrize(
    "case",
    [
        "other-document",
        "unknown-left",
        "unknown-right",
        "page-gap",
        "reversed-pages",
        "missing-marker",
        "new-section",
        "new-question",
        "nonconsecutive-chunk-index",
    ],
)
def test_formal_extractor_rejects_unproven_cross_page_continuations(case: str) -> None:
    left = _stored_chunk("left", 20, "56.問い。\n1 甲\n2 乙\n3 丙")
    right = _stored_chunk("right", 21, "4 丁")
    if case == "other-document":
        right = replace(right, document_id="other")
    elif case == "unknown-left":
        left = replace(left, document_id=None)
    elif case == "unknown-right":
        right = replace(right, document_id=None)
    elif case == "page-gap":
        right = replace(right, page_number=22)
    elif case == "reversed-pages":
        right = replace(right, page_number=19)
    elif case == "missing-marker":
        right = replace(right, text="丁", raw_text="丁")
    elif case == "new-section":
        right = replace(right, text="問題11 次の文章。\n4 丁", raw_text="問題11 次の文章。\n4 丁")
    elif case == "new-question":
        right = replace(right, text="57.新しい問い。\n4 丁", raw_text="57.新しい問い。\n4 丁")
    elif case == "nonconsecutive-chunk-index":
        right = replace(right, chunk_index=left.chunk_index + 2)
    assert extract_jlpt_question_blocks([left, right], limit=10) == []


def test_formal_extractor_keeps_wrapped_option_text_that_mentions_questions() -> None:
    left = _stored_chunk("left", 20, "56.問い。\n1 甲\n2 乙\n3 丙\n― 20 ―")
    right = _stored_chunk("right", 21, "4 自ら\n問題を考える人\n― 21 ―")
    suggestions = extract_jlpt_question_blocks([left, right], limit=10)
    assert len(suggestions) == 1
    assert suggestions[0].choices[-1] == "4 自ら 問題を考える人"
    assert left.document_id == right.document_id == "document"


def test_formal_extractor_honors_limit_without_duplicate_completed_questions() -> None:
    left = _stored_chunk("left", 20, "56.問い。\n1 甲\n2 乙\n3 丙\n4 丁")
    right = _stored_chunk("right", 21, "57.次の問い。\n1 A\n2 B\n3 C\n4 D")
    assert len(extract_jlpt_question_blocks([left, right], limit=1)) == 1
    assert [
        s.source_question_number for s in extract_jlpt_question_blocks([left, right], limit=10)
    ] == ["56", "57"]


def test_formal_extractor_preserves_numeric_lines_in_continued_last_option() -> None:
    left = _stored_chunk("left", 20, "56.問い。\n1 甲\n2 乙\n3 丙")
    right = _stored_chunk("right", 21, "4 全体の\n1.5倍を\n16人にする")
    suggestions = extract_jlpt_question_blocks([left, right], limit=10)
    assert len(suggestions) == 1
    assert suggestions[0].choices[-1] == "4 全体の 1.5倍を 16人にする"


def test_formal_extractor_preserves_wrapped_section_words_in_options() -> None:
    for word in ("読解", "聴解"):
        left = _stored_chunk("left", 20, f"56.問い。\n1 学ぶ分野は\n{word}")
        right = _stored_chunk("right", 21, f"2 乙\n3 丙\n4 最後も\n{word}")
        suggestions = extract_jlpt_question_blocks([left, right], limit=10)
        assert len(suggestions) == 1
        assert suggestions[0].choices[0] == f"1 学ぶ分野は {word}"
        assert suggestions[0].choices[-1] == f"4 最後も {word}"


def test_formal_extractor_reads_actual_persisted_page_indices(tmp_path: Path) -> None:
    db = Database(Settings(data_dir=tmp_path, api_token="test-token"))
    db.migrate()
    pages = (
        ExtractedPage(15, "56.問い。\n1 甲", "", "ocr"),
        ExtractedPage(16, "2 乙\n3 丙\n4 丁", "", "ocr"),
    )
    with db.connect() as connection:
        connection.execute(
            "INSERT INTO projects(id, name, description, created_at, updated_at) "
            "VALUES ('project', 'Project', '', '2026-01-01', '2026-01-01')"
        )
        connection.execute(
            "INSERT INTO documents(id, project_id, filename, sha256, storage_path, "
            "page_count, has_text, status, created_at, updated_at) "
            "VALUES ('document', 'project', 'test.pdf', 'hash', 'test.pdf', "
            "16, 1, 'ready', '2026-01-01', '2026-01-01')"
        )
        sync_document_chunks(
            connection,
            project_id="project",
            document_id="document",
            pages=pages,
            now="2026-01-01",
        )
    chunks = [
        source_chunk_from_document_chunk(chunk)
        for chunk in get_source_chunks(db, "project", "document")
    ]

    assert [chunk.chunk_index for chunk in chunks] == [0, 1]
    assert [chunk.raw_or_text() for chunk in chunks] == [page.text for page in pages]
    suggestions = extract_jlpt_question_blocks(chunks, limit=10)
    assert len(suggestions) == 1
    assert suggestions[0].source_question_number == "56"
    assert suggestions[0].choices == ("1 甲", "2 乙", "3 丙", "4 丁")


def test_formal_extractor_preserves_numbered_problem_references_in_choice() -> None:
    left = _stored_chunk("left", 20, "55 問い。\n1 第一\n2 第二\n3 第三")
    right = _stored_chunk("right", 21, "4 最初の\n問題1を解く")
    suggestions = extract_jlpt_question_blocks([left, right], limit=10)
    assert len(suggestions) == 1
    assert suggestions[0].choices[-1] == "4 最初の 問題1を解く"
