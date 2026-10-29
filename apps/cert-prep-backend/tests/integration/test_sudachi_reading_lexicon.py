from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import pytest

from cert_prep_backend.authoring.domain.reading_solver import (
    ReadingSolution,
    ReadingSpan,
    solve_reading_question,
)
from cert_prep_backend.authoring.infrastructure.sudachi_reading_lexicon import SudachiReadingLexicon


@pytest.mark.parametrize("sentence, surface, reading", [
    ("舞台の客が絶叫した。", "絶叫", "ぜっきょう"),
    ("係員は新しい案を承諾した。", "承諾", "しょうだく"),
    ("駅前の小さな店は繁盛している。", "繁盛", "はんじょう"),
])
def test_real_core_dictionary(sentence, surface, reading) -> None:
    spans = SudachiReadingLexicon().kanji_span_readings(sentence)
    solution = solve_reading_question(sentence, [reading, "まちがい"], spans)
    assert isinstance(solution, ReadingSolution)
    assert (solution.surface, solution.reading) == (surface, reading)


@pytest.mark.parametrize("sentence, choices", [
    ("誰もいない、人気のない道を歩いた。", ["ひとけ", "にんき", "じんき", "ひとき"]),
    ("この生物を調べた。", ["せいぶつ", "なまもの", "しょうぶつ", "せいもの"]),
    ("一昨日は雨だった。", ["いっさくび", "おととい", "おとつい", "いちさくにち"]),
])
def test_competing_dictionary_readings_decline(sentence, choices) -> None:
    spans = SudachiReadingLexicon().kanji_span_readings(sentence)
    assert solve_reading_question(sentence, choices, spans) == "ambiguous_readings"


def test_lookup_readings_include_a_span_split_in_both_modes() -> None:
    from sudachipy import Dictionary, SplitMode

    dictionary = Dictionary(dict="core")
    tokenizer = dictionary.tokenizer()
    for mode in (SplitMode.A, SplitMode.C):
        assert len(tokenizer.tokenize("一昨日", mode)) > 1
    expected = {
        ReadingSpan(entry.surface(), entry.reading_form())
        for entry in dictionary.lookup("一昨日")
        if entry.surface() == "一昨日"
    }
    assert {span.reading for span in expected} == {"オトツイ", "オトトイ"}
    assert expected <= set(SudachiReadingLexicon().kanji_span_readings("一昨日は雨だった。"))


def test_real_adapter_only_uses_single_tokens_or_exact_dictionary_entries() -> None:
    import re
    from sudachipy import Dictionary, SplitMode

    sentence = "国際空港の店は繁盛している。"
    dictionary = Dictionary(dict="core")
    tokenizer = dictionary.tokenizer()
    expected = set()
    for mode in (SplitMode.A, SplitMode.C):
        tokens = list(tokenizer.tokenize(sentence, mode))
        for start in range(len(tokens)):
            for end in range(start + 1, min(start + 4, len(tokens)) + 1):
                surface = "".join(token.surface() for token in tokens[start:end])
                if re.search(r"[㐀-鿿々]", surface):
                    if end == start + 1 and tokens[start].part_of_speech()[1] != "数詞":
                        expected.add(ReadingSpan(surface, tokens[start].reading_form()))
                    expected.update(
                        ReadingSpan(surface, entry.reading_form())
                        for entry in dictionary.lookup(surface)
                        if entry.surface() == surface and entry.part_of_speech()[1] != "数詞"
                    )
    assert expected == set(SudachiReadingLexicon().kanji_span_readings(sentence))


@pytest.mark.parametrize("sentence, choices, span", [
    ("庭に一匹の猫が来た。", ["いっぴき", "いちひき", "いっひき", "いちびき"],
     ReadingSpan("一匹", "イチヒキ")),
    ("切符は三百円だった。", ["さんびゃく", "さんひゃく", "さんぴゃく", "みひゃく"],
     ReadingSpan("三百", "サンヒャク")),
])
def test_joined_readings_cannot_solve_sound_change_items(sentence, choices, span) -> None:
    spans = SudachiReadingLexicon().kanji_span_readings(sentence)
    assert span not in spans
    assert solve_reading_question(sentence, choices, spans) == "no_matching_reading"


def test_lazy_tokenizer_created_once_and_safe_across_threads() -> None:
    from sudachipy import Dictionary

    with patch("sudachipy.Dictionary", wraps=Dictionary) as factory:
        lexicon = SudachiReadingLexicon()
        factory.assert_not_called()
        sentences = ["案を承諾した。", "人気のない道。", "この生物。", "一昨日は雨だった。"] * 3
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lexicon.kanji_span_readings, sentences))
        assert all(results)
        assert results == [lexicon.kanji_span_readings(sentence) for sentence in sentences]
        assert ReadingSpan("人気", "ヒトケ") in results[1]
        assert ReadingSpan("生物", "ナマモノ") in results[2]
        assert ReadingSpan("一昨日", "オトトイ") in results[3]
        factory.assert_called_once_with(dict="core")


@pytest.mark.parametrize("failure", [ImportError("native extension missing"), OSError("no dictionary")])
def test_load_failure_declines_and_logs_only_once(failure, caplog) -> None:
    with patch("sudachipy.Dictionary", side_effect=failure) as factory:
        lexicon = SudachiReadingLexicon()
        assert lexicon.kanji_span_readings("承諾した。") == ()
        assert lexicon.kanji_span_readings("繁盛した。") == ()
        factory.assert_called_once()
    assert sum("Sudachi reading lexicon unavailable" in record.message for record in caplog.records) == 1
