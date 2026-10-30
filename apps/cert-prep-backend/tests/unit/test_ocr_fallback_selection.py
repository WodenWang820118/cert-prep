"""Synthetic review probes and HEAD-first whole-chunk selection guarantees."""

from dataclasses import replace
import importlib
import inspect
from itertools import product

import pytest

from cert_prep_backend.source_library.domain import exam_content, ocr_exam_content


def _probe_cases():
    cases = []
    for continuation, field in product(("3人です。", "1.5倍です。"), range(5)):
        fields = ["報告の内容はどれか。", "人数は三人", "人数は五人", "割合は半分", "割合は同じ"]
        fields[field] = f"記録によると\n{continuation}"
        cases.append((f"r1-wrap-{continuation}-{field}", "48", fields, None, False))
    for field in (0, 1, 4):
        fields = ["生徒は何をするか。", "本を読む", "紙を配る", "黒板を消す", "窓を開ける"]
        fields[field] = "先生に\n質問する"
        cases.append((f"r1-verb-{field}", "48", fields, None, False))
    for phrase in ("前の問題1 を確認する", "正しい答えを選んでください"):
        for field in range(1, 5):
            fields = ["係の人は何と言ったか。", "図を見る", "表を読む", "式を書く", "本を閉じる"]
            fields[field] = phrase
            cases.append((f"r1-choice-{phrase}-{field}", "48", fields, None, False))
    reading = ["庭に苗を植えた。", "うえた", "うえだ", "ういた", "うれた"]
    cases.extend(
        [
            ("r1-unseparated", "7", reading, "問題1漢字の読み方を答えてください。", False),
            (
                "r1-wrapped-instruction",
                "7",
                reading,
                "問題1 下線の言葉について、\n1・2・3・4から正しい読み方を選びなさい。",
                False,
            ),
            (
                "r2-fullwidth-content",
                "48",
                ["問い。", "合計２個を買う", "三個を買う", "四個を買う", "五個を買う"],
                None,
                True,
            ),
            (
                "r2-wrapped-stem",
                "48",
                ["来場者は\n16人です。", "正しい", "誤り", "不明", "ほか"],
                None,
                False,
            ),
            (
                "r2-wrapped-ordinal",
                "48",
                ["問い。", "合計を\n2番目の欄に書く", "乙", "丙", "丁"],
                None,
                False,
            ),
            (
                "r2-quoted-request",
                "48",
                ["「正しい答えを選んでください」と誰が言ったか。", "甲", "乙", "丙", "丁"],
                None,
                False,
            ),
            ("r2-inline-heading", "7", reading, "問題1 読み方を答えてください。", True),
        ]
    )
    return cases


@pytest.mark.parametrize("case", _probe_cases(), ids=lambda case: case[0])
def test_review_probes_keep_primary_and_are_safe_in_fallback(case, monkeypatch):
    _, number, fields, instruction, inline = case
    separator = " " if inline else "\n"
    text = separator.join(
        [f"{number} {fields[0]}", *(f"{i} {choice}" for i, choice in enumerate(fields[1:], 1))]
    )
    if instruction:
        text = instruction + separator + text
    selector = ocr_exam_content._select_ocr_question_blocks
    primary_results = []

    def checked_selection(*, primary, **kwargs):
        result = selector(primary=primary, **kwargs)
        assert result is primary
        primary_results.append(primary)
        return result

    with monkeypatch.context() as context:
        context.setattr(ocr_exam_content, "_select_ocr_question_blocks", checked_selection)
        dispatched = exam_content.parse_jlpt_question_blocks(text=text, page_number=1)
    assert dispatched == primary_results[0]
    for blocks in (
        dispatched,
        ocr_exam_content._parse_ocr_jlpt_question_blocks(text=text, page_number=1),
    ):
        assert [block.source_question_number for block in blocks] == [number]
        assert blocks[0].stem == " ".join(fields[0].split())
        assert blocks[0].choices == tuple(
            f"{i} {' '.join(value.split())}" for i, value in enumerate(fields[1:], 1)
        )
        assert blocks[0].section_instruction == (
            " ".join(instruction.split()) if instruction else None
        )


def _existing_fixtures(module_names=("test_exam_content", "test_section_instructions")):
    cases = []
    for name in module_names:
        module = importlib.import_module(name)
        for fixture_name, function in vars(module).items():
            if not fixture_name.startswith("test_") or not inspect.isfunction(function):
                continue
            parameters = {}
            for mark in getattr(function, "pytestmark", ()):
                if mark.name == "parametrize":
                    parameters[mark.args[0]] = mark.args[1]
            for values in product(*parameters.values()):
                cases.append((name, fixture_name, dict(zip(parameters, values))))
    return cases


@pytest.mark.parametrize("module_name,fixture_name,kwargs", _existing_fixtures())
def test_existing_public_well_formed_fixtures_equal_primary(
    module_name, fixture_name, kwargs, monkeypatch
):
    selector = ocr_exam_content._select_ocr_question_blocks
    checked = []

    def checked_selection(*, primary, **arguments):
        result = selector(primary=primary, **arguments)
        assert result is primary
        assert result == primary
        checked.append(result)
        return result

    monkeypatch.setattr(ocr_exam_content, "_select_ocr_question_blocks", checked_selection)
    getattr(importlib.import_module(module_name), fixture_name)(**kwargs)
    assert checked


@pytest.mark.parametrize(
    "module_name,fixture_name,kwargs",
    _existing_fixtures(
        ("test_exam_content_ocr", "test_exam_content_ocr_regressions"),
    ),
)
def test_standalone_fallback_reuses_ocr_artifact_fixtures(
    module_name, fixture_name, kwargs, monkeypatch
):
    module = importlib.import_module(module_name)
    monkeypatch.setattr(
        module, "parse_jlpt_question_blocks", ocr_exam_content._parse_ocr_jlpt_question_blocks
    )
    getattr(module, fixture_name)(**kwargs)


def _item(number, *, glued=False):
    return f"{number}{'' if glued else ' '}問い。\n1 甲\n2 乙\n3 丙\n4 丁"


def _primary(text):
    # Capture HEAD's result through the public entry point without applying recovery.
    with pytest.MonkeyPatch.context() as context:
        context.setattr(
            ocr_exam_content, "_select_ocr_question_blocks", lambda *, primary, **_: primary
        )
        return exam_content.parse_jlpt_question_blocks(text=text, page_number=1)


@pytest.mark.parametrize("extra,chosen", [(1, False), (2, True), (3, True)])
def test_two_additional_validated_line_starts_are_required(extra, chosen):
    text = "\n".join(
        [_item(8), *(_item(9 + i, glued=True).replace("\n1 ", "\nI") for i in range(extra))]
    )
    primary = _primary(text)
    result = ocr_exam_content._select_ocr_question_blocks(primary=primary, text=text, page_number=1)
    assert (result is not primary) is chosen
    assert len(result) == (1 + extra if chosen else 1)


@pytest.mark.parametrize(
    "suffix",
    [
        "\n9 未完。\n1 甲\n2 乙\n3 丙",
        "\n9 問い。\n1 甲\n3 丙\n2 乙\n4 丁",
        "\n説明に 9 問い。\n1 甲\n2 乙\n3 丙\n4 丁",
        "\n3人です。\n1.5倍です。\n16人です。",
    ],
)
def test_unvalidated_numbers_do_not_trigger_fallback(suffix, monkeypatch):
    text = _item(8) + suffix * 3
    primary = _primary(text)

    def unexpected_fallback(**_):
        pytest.fail("Fallback ran without two additional complete line-start questions")

    monkeypatch.setattr(ocr_exam_content, "_parse_ocr_jlpt_question_blocks", unexpected_fallback)
    assert (
        ocr_exam_content._select_ocr_question_blocks(primary=primary, text=text, page_number=1)
        is primary
    )


def test_zero_complete_primary_uses_fallback_and_its_instruction():
    instruction = "問題Ⅰ 読み方を答えてください。"
    text = instruction + "\n７問い。\nIこう２おつ3へい４てい"
    assert _primary(text) == []
    blocks = exam_content.parse_jlpt_question_blocks(text=text, page_number=1, chunk_index=2)
    assert len(blocks) == 1
    assert blocks[0].source_order == 12001
    assert blocks[0].section_instruction == instruction


@pytest.mark.parametrize("gain", [-1, 0, 1])
def test_only_strictly_more_complete_fallback_blocks_can_replace_primary(gain, monkeypatch):
    text = "\n".join(_item(number, glued=True) for number in (8, 9, 10))
    primary = _primary(_item(8))
    incomplete = replace(primary[0], choices=("1 ", "2 乙", "3 丙", "4 丁"))
    fallback = [replace(primary[0], section_instruction="recovered")] * (1 + gain) + [
        incomplete
    ] * 4
    monkeypatch.setattr(ocr_exam_content, "_parse_ocr_jlpt_question_blocks", lambda **_: fallback)
    result = ocr_exam_content._select_ocr_question_blocks(primary=primary, text=text, page_number=1)
    assert result is (fallback if gain > 0 else primary)


def test_zero_complete_tie_keeps_primary(monkeypatch):
    primary = []
    monkeypatch.setattr(ocr_exam_content, "_parse_ocr_jlpt_question_blocks", lambda **_: [])
    assert (
        ocr_exam_content._select_ocr_question_blocks(primary=primary, text="", page_number=1)
        is primary
    )


@pytest.mark.parametrize("empty_field", ["stem", "choice", "missing-choice"])
def test_incomplete_primary_does_not_prevent_recovery(empty_field):
    block = _primary(_item(8))[0]
    if empty_field == "stem":
        block = replace(block, stem=" ")
    elif empty_field == "choice":
        block = replace(block, choices=("1 甲", "2 ", "3 丙", "4 丁"))
    else:
        block = replace(block, choices=block.choices[:3])
    primary = [block]
    result = ocr_exam_content._select_ocr_question_blocks(
        primary=primary,
        text=_item(9, glued=True),
        page_number=1,
    )
    assert result is not primary
    assert [item.source_question_number for item in result] == ["9"]
