from exam_prep_backend.llm import SourceChunk, _draft_suggestion_from_item


def test_draft_parser_rejects_cover_page_notice_as_exam_item() -> None:
    chunk = SourceChunk(
        id="chunk-1",
        page_number=1,
        text=(
            "2025年7月 新日本語能力試験 N1 注意 "
            "この試験問題には複数のバージョンがあります。"
        ),
        source_excerpt="この試験問題には複数のバージョンがあります。",
    )

    suggestion = _draft_suggestion_from_item(
        {
            "citation_page": 1,
            "question": "この試験問題には複数のバージョンがあります。",
            "choices": [
                "A. この試験問題には複数のバージョンがあります。",
                "B. 問題内容は同じですが、フォントやレイアウトが異なります。",
            ],
            "answer": "B",
            "answer_key_source": "ai_inferred",
            "rationale": "The notice says the content is the same.",
            "source_excerpt": "この試験問題には複数のバージョンがあります。",
        },
        {1: chunk},
        {"chunk-1": chunk},
    )

    assert suggestion is None


def test_draft_parser_accepts_jlpt_like_choice_item() -> None:
    chunk = SourceChunk(
        id="chunk-2",
        page_number=3,
        text="問題1 正しい読み方を選びなさい。 1 せいかい 2 ごとう 3 べつ 4 ほか",
        source_excerpt="問題1 正しい読み方を選びなさい。",
    )

    suggestion = _draft_suggestion_from_item(
        {
            "chunk_id": "chunk-2",
            "citation_page": 3,
            "question": "問題1 正しい読み方を選びなさい。",
            "choices": ["1 せいかい", "2 ごとう", "3 べつ", "4 ほか"],
            "answer": "1",
            "answer_key_source": "ai_inferred",
            "rationale": "Choice 1 matches the inferred reading.",
            "source_excerpt": "問題1 正しい読み方を選びなさい。",
        },
        {3: chunk},
        {"chunk-2": chunk},
    )

    assert suggestion is not None
    assert suggestion.answer == "1 せいかい"
    assert suggestion.citation_page == 3
