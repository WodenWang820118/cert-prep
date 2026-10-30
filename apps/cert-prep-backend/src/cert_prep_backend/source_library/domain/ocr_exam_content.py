"""OCR recovery on an offset-preserving working copy, isolated from the primary parser."""

from __future__ import annotations

from collections.abc import Iterator, Sequence
import re

from .exam_content import ParsedQuestionBlock, QuestionItemKind, without_page_footer


# A numbered OCR line is a structural boundary. Missing markers must not make
# one stem/choice consume the next question's numbered lines.
_SECTION_START = (
    r"(?:問題[ \t]*|(?i:mondai)[ \t]+)\d{1,3}"
    r"(?=[\s、，,（(_]|の言葉|次の|$|[^\d\r\n][^\r\n]*(?:ください|なさい))"
)
_SECTION_BOUNDARY = rf"^[ \t]*{_SECTION_START}"
_GROUP_PROMPT_END = (
    r".{0,400}?(?:\u9078\u3073\u306a\u3055\u3044|(?i:choose))"
    r"[^0-9\r\n。?？.]{0,80}[。?？.]?[ \t]*"
)
_NUMBERED_BOUNDARY = (
    r"\r?\n[ \t]*(?:\d{1,3}(?:[.\uFF0E](?!\d)|(?=\s|$)|番(?=[ \t]*\r?$))"
    r"|[（(]\d{1,3}[）)]|質問[ \t]*\d{1,3}(?!\d))"
)
_GLUED_QUESTION_BOUNDARY = (
    r"\r?\n[ \t]*(?!\d{1,3}[人個箱倍番章年月日])"
    r"\d{1,3}(?=[\u3040-\u9fff「『])[^\r\n]*[。?？][ \t]*"
    r"(?=\r?\n[ \t]*1(?!\d))"
)
_BLOCK_TEXT = (
    rf"(?:(?!{_NUMBERED_BOUNDARY})"
    rf"(?!{_GLUED_QUESTION_BOUNDARY})"
    rf"(?!{_SECTION_BOUNDARY}).)"
)
_QUESTION_BODY = (
    r"(?P<open>[（(])?(?P<number>\d{1,3})(?(open)[）)])"
    r"(?:[.\uFF0E](?!\d)\s*|\s+|(?=[\u3040-\u9fff「『（(]))"
    # Each field ends at the first following label and is then committed
    # (atomic group). Without that, noisy text with many 1-3 labels and no 4
    # backtracks through every label combination.
    rf"(?>(?P<stem>{_BLOCK_TEXT}+?)\s*"
    rf"(?<![\d注第題])1(?!\d|[.．]\d|番目|[人個箱倍番章年月日目](?![一-鿿]))(?:[.．](?!\d))?\s*)(?>(?P<c1>{_BLOCK_TEXT}+?)\s*"
    rf"(?<![\d注第題])2(?!\d|[.．]\d|番目|[人個箱倍番章年月日目](?![一-鿿]))(?:[.．](?!\d))?\s*)(?>(?P<c2>{_BLOCK_TEXT}+?)\s*"
    rf"(?<![\d注第題])3(?!\d|[.．]\d|番目|[人個箱倍番章年月日目](?![一-鿿]))(?:[.．](?!\d))?\s*)(?>(?P<c3>{_BLOCK_TEXT}+?)\s*"
    r"(?<![\d注第題])4(?!\d|[.．]\d|番目|[人個箱倍番章年月日目](?![一-鿿]))(?:[.．](?!\d))?\s*)(?P<c4>.+?)"
    rf"(?=\s+\d{{1,3}}(?:[.\uFF0E](?!\d)\s*|\s+)(?=\S)|"
    rf"{_GLUED_QUESTION_BOUNDARY}|"
    r"\r?\n[ \t]*(?:[（(]\d{1,3}[）)]|\d{1,3}番|質問[ \t]*\d{1,3}(?!\d))|"
    rf"{_SECTION_BOUNDARY}|[ \t]+(?=(?:問題|(?i:mondai))\s*\d{{1,3}}{_GROUP_PROMPT_END})|"
    r"\r?\n[ \t]*(?:\(\d+\s*[*×]\s*\d+\)|言語知識|日本語能力試験)|\Z)"
)
_QUESTION_BLOCK_PATTERN = re.compile(r"^[ \t]*" + _QUESTION_BODY, re.DOTALL | re.MULTILINE)
_INLINE_QUESTION_BLOCK_PATTERN = re.compile(_QUESTION_BODY, re.DOTALL | re.MULTILINE)
# Prefer explicitly separated labels over digits glued to quantities in prose.
_SPACED_QUESTION_BODY = _QUESTION_BODY
for _label in range(1, 5):
    _SPACED_QUESTION_BODY = _SPACED_QUESTION_BODY.replace(
        rf"(?<![\d注第題]){_label}(?!\d|[.．]\d|番目|[人個箱倍番章年月日目](?![一-鿿]))(?:[.．](?!\d))?\s*",
        rf"(?<!\S){_label}(?:[.．](?!\d))?\s+",
    )
_SPACED_QUESTION_BLOCK_PATTERN = re.compile(_SPACED_QUESTION_BODY, re.DOTALL | re.MULTILINE)
# A bracketed or closing-parenthesis item number inside a stem, as in "順応 （8）彼は…"
# or "元祖 8）一年で…": the primary parser merged one item into the next.
_EMBEDDED_QUESTION_START = re.compile(
    r"(?:^|\s)[（(]?\s*(?:\d{1,3}|[IVXⅠ-Ⅻ]{1,4})\s*[）)]\S"
)
# A line that opens a question with its number glued to the stem, as OCR
# often prints it. Counters (16人, 4つ) and enumerations (1・2・3・4) are not.
_GLUED_QUESTION_START = re.compile(
    r"\s*\d{1,3}(?![\d人個箱倍番章年月日つ・])(?=[぀-鿿「『])[^\r\n]*[。?？]\s*$"
)
_GROUP_PROMPT_PATTERN = re.compile(
    rf"(?P<prompt>(?:\u554f\u984c|mondai)\s*(?P<number>\d{{1,3}}){_GROUP_PROMPT_END})",
    re.IGNORECASE | re.DOTALL,
)


def _complete_block(block: ParsedQuestionBlock) -> bool:
    return (
        bool(block.stem.strip())
        and len(block.choices) == 4
        and all(choice[2:].strip() for choice in block.choices)
    )


def _complete_block_count(blocks: Sequence[ParsedQuestionBlock]) -> int:
    return sum(_complete_block(block) for block in blocks)


def _validated_question_start_count(text: str, page_number: int) -> int:
    working = _matching_exam_text(without_page_footer(text, page_number))
    count = 0
    for match in _question_matches(working):
        # Inline labels and quantities cannot count as additional question starts.
        line_start = working.rfind("\n", 0, match.start()) + 1
        if working[line_start : match.start()].strip():
            continue
        stem = _clean_exam_text(match.group("stem"))
        choices = tuple(f"{i} {_clean_exam_text(match.group(f'c{i}'))}" for i in range(1, 5))
        if (
            stem
            and all(choice[2:].strip() for choice in choices)
            and not _looks_like_question_group_instruction(stem)
            and not _junk_question(stem, choices)
        ):
            count += 1
    return count


def _select_ocr_question_blocks(
    *,
    primary: list[ParsedQuestionBlock],
    text: str,
    page_number: int,
    chunk_index: int = 0,
) -> list[ParsedQuestionBlock]:
    """Keep primary output unless conservative whole-chunk recovery completes more items."""
    complete = _complete_block_count(primary)
    if complete and _validated_question_start_count(text, page_number) < complete + 2:
        return primary
    fallback = _parse_ocr_jlpt_question_blocks(
        text=text,
        page_number=page_number,
        chunk_index=chunk_index,
    )
    if _complete_block_count(fallback) > complete and _preserves_primary_blocks(primary, fallback):
        return fallback
    return primary


def _preserves_primary_blocks(
    primary: Sequence[ParsedQuestionBlock], fallback: Sequence[ParsedQuestionBlock]
) -> bool:
    """Every complete primary question needs its own complete fallback counterpart.

    Numbers repeat across sections, so a counterpart must match the number and the
    stem, and each fallback block can stand in for one primary block only.
    """
    unused = [block for block in fallback if _complete_block(block)]
    for block in primary:
        if not _protected_primary_block(block):
            continue
        counterpart = next(
            (candidate for candidate in unused if _same_question(block, candidate)), None
        )
        if counterpart is None:
            return False
        unused.remove(counterpart)
    return True


def _protected_primary_block(block: ParsedQuestionBlock) -> bool:
    """A primary block worth keeping: complete, not junk, and not two items merged.

    On OCR text the primary parser often glues a choice onto the next item, giving a
    stem such as "順応 （8）彼の活躍は…". Those are not questions to preserve.
    """
    if not _complete_block(block):
        return False
    stem = _matching_exam_text(block.stem)
    choices = tuple(_matching_exam_text(choice) for choice in block.choices)
    # Only structural signals decide; an answer may legitimately be digits only.
    return not _structural_junk(stem, choices) and not _EMBEDDED_QUESTION_START.search(stem)


def _same_question(primary: ParsedQuestionBlock, fallback: ParsedQuestionBlock) -> bool:
    if _matching_exam_text(primary.source_question_number) != _matching_exam_text(
        fallback.source_question_number
    ):
        return False
    primary_stem = re.sub(r"\s+", "", _matching_exam_text(primary.stem))
    fallback_stem = re.sub(r"\s+", "", _matching_exam_text(fallback.stem))
    return primary_stem in fallback_stem or fallback_stem in primary_stem


def _recover_ocr_classification(
    text: str,
    question_matches: list[re.Match[str]],
    group_prompts: list[tuple[str, str]],
) -> tuple[list[re.Match[str]] | list[ParsedQuestionBlock], list[tuple[str, str]]]:
    from .exam_content import parse_jlpt_question_blocks

    # The primary parser accepts precisely the complete matches in this list.
    # Dispatch can increase that count only when whole-chunk recovery wins.
    complete = sum(
        bool(_clean_exam_text(match.group("stem")))
        and all(_clean_exam_text(match.group(f"c{i}")) for i in range(1, 5))
        for match in question_matches
    )
    selected = parse_jlpt_question_blocks(text=text, page_number=0)
    if len(selected) > complete:
        return selected, _group_prompts(text)
    return question_matches, group_prompts


def _parse_ocr_jlpt_question_blocks(
    *,
    text: str,
    page_number: int,
    chunk_index: int = 0,
) -> list[ParsedQuestionBlock]:
    chunk_text = without_page_footer(text, page_number)
    matching_text = _matching_exam_text(chunk_text)
    source_text = _question_block_source_text(matching_text)
    source_offset = len(chunk_text) - len(source_text)
    instructions = iter(_section_instructions(chunk_text))
    next_instruction = next(instructions, None)
    section_instruction = None
    group_prompt = _first_group_prompt(text)
    is_grouped_set = group_prompt is not None and _prompt_is_grouped_question_set(group_prompt[1])
    item_kind = (
        QuestionItemKind.GROUPED_QUESTION if is_grouped_set else QuestionItemKind.VOCABULARY_SINGLE
    )
    group_key = None
    if is_grouped_set and group_prompt is not None:
        group_number = group_prompt[0]
        group_key = f"page-{page_number}:group-{group_number}"

    blocks: list[ParsedQuestionBlock] = []
    for index, match in enumerate(_question_matches(source_text), start=1):
        while next_instruction is not None and next_instruction[0] < source_offset + match.start():
            section_instruction = next_instruction[1]
            next_instruction = next(instructions, None)

        def original_field(name: str) -> str:
            start, end = match.span(name)
            return _clean_exam_text(chunk_text[source_offset + start : source_offset + end])

        stem = original_field("stem")
        if _looks_like_question_group_instruction(stem):
            section_instruction = stem
            continue
        choices = tuple(
            choice
            for choice in (
                f"{choice_index} {original_field(f'c{choice_index}')}"
                for choice_index in range(1, 5)
            )
            if len(choice) > 2
        )
        if not stem or len(choices) < 4 or _junk_question(stem, choices):
            continue
        source_excerpt = chunk_text[
            source_offset + match.start() : source_offset + match.end()
        ].strip()
        source_order = (page_number * 10_000) + (chunk_index * 1_000) + index
        blocks.append(
            ParsedQuestionBlock(
                source_order=source_order,
                source_question_number=match.group("number"),
                item_kind=item_kind,
                group_key=group_key,
                group_prompt=group_prompt[1] if is_grouped_set and group_prompt else None,
                stem=stem,
                choices=choices,
                source_excerpt=source_excerpt[:500],
                section_instruction=section_instruction,
            )
        )
    return blocks


def _matching_exam_text(text: str) -> str:
    """Keep offsets stable so every stored field can be sliced from the source."""
    original = text
    text = text.translate(str.maketrans("０１２３４５６７８９", "0123456789"))
    # Embedded full-width quantities are content, not recovered choice labels.
    for quantity in re.finditer(r"(?<=\S)[０-９]+(?=[人個箱倍番章年月日])", original):
        text = text[: quantity.start()] + quantity.group() + text[quantity.end() :]
    text = re.sub(r"(?<=問題)[ \t]*[ⅠIl|]", lambda m: m.group()[:-1] + "1", text)
    text = re.sub(
        r"(?m)(^[ \t]*|(?<=[。?？])[ \t]*)[ⅠIl|](?=[\s\d.．\u3040-\u9fff])",
        r"\g<1>1",
        text,
    )
    text = re.sub(r"[ⅠIl|](?=234)", "1", text)
    text = re.sub(r"ー(?=つ)", "一", text)
    return re.sub(r"(?<![A-Za-z])NI(?![A-Za-z])", "N1", text)


def _question_matches(text: str) -> Iterator[re.Match[str]]:
    position = 0
    inline = True
    while position < len(text):
        match = _INLINE_QUESTION_BLOCK_PATTERN.match(text, position) if inline else None
        if match is None:
            match = _QUESTION_BLOCK_PATTERN.search(text, position)
        if match is None:
            return
        spaced = _SPACED_QUESTION_BLOCK_PATTERN.match(text, match.start())
        if spaced is not None:
            match = spaced
        yield match
        position = match.end()
        # Preserve the established compact, single-line input format. Inline
        # question starts are allowed only immediately after a complete block
        # (or its next section prompt), never by searching inside prose.
        while position < len(text) and text[position] in " \t":
            position += 1
        prompt = _GROUP_PROMPT_PATTERN.match(text, position)
        if prompt is not None:
            position = prompt.end()
        inline = position < len(text) and text[position] not in "\r\n"


def _junk_question(stem: str, choices: tuple[str, ...]) -> bool:
    return _structural_junk(stem, choices) or _unusable_choice_cells(stem, choices)


def _structural_junk(stem: str, choices: tuple[str, ...]) -> bool:
    """Page furniture, listening rows, or two items merged into one block."""
    matching_stem = _matching_exam_text(stem)
    if re.match(
        r"(?:番(?:\s|$)|言語知識|日本語能力試験|N[1-5](?:\s|$)"
        r"|(?:解答(?:用紙|欄)|受験番号|氏名|(?:配点|得点)表)(?:[\s:：]|$)"
        r"|ページ\s*\d+(?:[\s/／]|$))", matching_stem
    ):
        return True
    # Listening sheets provide answer rows without a written question stem.
    if re.search(r"(?:^|\s)(?:\d+\s*番|質問\s*\d+)(?:\s|$)", matching_stem):
        return True
    # An unfinished annotation marker followed by numbered definitions is prose.
    if re.search(r"[（(]\s*注\s*$", stem):
        return True
    # A field containing another complete numbered item is a merged fragment.
    if any(
        _INLINE_QUESTION_BLOCK_PATTERN.search(_matching_exam_text(field))
        for field in (stem, *(choice[2:] for choice in choices))
    ):
        return True
    # A second first-choice marker after a sentence signals a lost question start.
    return any(
        re.search(r"[。?？]\s*1(?!\d)", _matching_exam_text(choice[2:]))
        for choice in choices
    )


def _unusable_choice_cells(stem: str, choices: tuple[str, ...]) -> bool:
    """Score markers and cells that cannot be shown as an answer, such as digits only."""
    score = r"[（(]?\s*\d+\s*[*＊×]\s*\d+\s*[）)]?"
    return bool(re.fullmatch(score, stem)) or any(
        len(choice[2:]) > 500
        or not any(character.isalpha() for character in choice[2:])
        or re.fullmatch(score, _matching_exam_text(choice[2:]))
        or re.match(
            rf"{_SECTION_START}.*(?:選びなさい|選んでください|答えてください|(?i:choose))",
            _matching_exam_text(choice[2:]),
        )
        for choice in choices
    )


def _section_instructions(text: str) -> list[tuple[int, str]]:
    matching_text = _matching_exam_text(text)
    headings = list(
        re.finditer(
            rf"(?m)^[ \t]*(?P<heading>{_SECTION_START}[^\r\n]*)",
            matching_text,
        )
    )
    instructions = {}
    for match in _GROUP_PROMPT_PATTERN.finditer(matching_text):
        end = next(
            (
                heading.start("heading")
                for heading in headings
                if match.start() < heading.start("heading") < match.end()
            ),
            match.end(),
        )
        instructions[match.start()] = _clean_exam_text(text[match.start() : end])
    # A section heading need not use the group prompt's "choose" wording.
    # Include wrapped instruction lines, stopping before a numbered item,
    # including one whose number is glued to its stem.
    for heading in headings:
        lines = []
        heading_lines = text[heading.start("heading") :].splitlines()
        for index, line in enumerate(heading_lines):
            if lines and (
                re.match(
                    rf"\s*(?:[（(]\d{{1,3}}[）)]|\d{{1,3}}(?:[.．](?!\d)|(?=\s|$))"
                    rf"|{_SECTION_START})",
                    _matching_exam_text(line),
                )
                or _GLUED_QUESTION_START.match(_matching_exam_text(line))
                or _QUESTION_BLOCK_PATTERN.match(
                    _matching_exam_text("\n".join(heading_lines[index:]))
                )
            ):
                break
            sentence, full_stop, _ = line.partition("。")
            lines.append(sentence + full_stop)
            if full_stop:
                break
        instructions[heading.start("heading")] = _clean_exam_text("\n".join(lines))
    # Unheaded instructions are also recognized by the existing parser.
    prefix_length = len(text) - len(_question_block_source_text(matching_text))
    if prefix_length and _looks_like_question_group_instruction(text[:prefix_length]):
        instructions.setdefault(0, _clean_exam_text(text[:prefix_length]))
    return sorted(instructions.items())


def _group_prompts(text: str) -> list[tuple[str, str]]:
    prompts: list[tuple[str, str]] = []
    for match in _GROUP_PROMPT_PATTERN.finditer(_matching_exam_text(text or "")):
        prompt = _clean_exam_text(text[match.start("prompt") : match.end("prompt")])
        if prompt:
            prompts.append((match.group("number"), prompt))
    return prompts


def _first_group_prompt(text: str) -> tuple[str, str] | None:
    prompts = _group_prompts(text)
    return prompts[0] if prompts else None


def _clean_exam_text(text: str) -> str:
    return " ".join((text or "").split()).strip(" -")


def _question_block_source_text(text: str) -> str:
    heading = re.match(rf"[ \t]*{_SECTION_START}[^。\r\n]*。[ \t]*", text)
    if heading is not None:
        return text[heading.end() :]
    first_item = re.search(
        r"(?m)^[ \t]*[（(]?\d{1,3}(?:[）).．]|\s|(?=[\u3040-\u9fff「『]))", text
    )
    prefix_end = first_item.start() if first_item else len(text)
    group_match = _GROUP_PROMPT_PATTERN.search(text or "")
    if group_match is not None and group_match.end() <= prefix_end:
        return (text or "")[group_match.end() :]
    instruction = re.match(
        r"^.*?(?:\u9078\u3073\u306a\u3055\u3044|choose)[?\u3002.]*\s*(?=\d{1,3}\s+)",
        text or "",
        flags=re.IGNORECASE | re.DOTALL,
    )
    if instruction is not None and instruction.end() <= prefix_end:
        return text[instruction.end() :]
    return text


def _looks_like_question_group_instruction(stem: str) -> bool:
    lowered = stem.lower()
    return (
        re.match(_SECTION_START, _matching_exam_text(stem)) is not None
        or "\u9078\u3073\u306a\u3055\u3044" in stem
        or re.match(r"(?:漢字の)?読み方.*選んでください", stem) is not None
        or (lowered.startswith("mondai") and "choose" in lowered and "?" not in lowered)
    )


def _prompt_is_grouped_question_set(prompt: str) -> bool:
    lowered = prompt.lower()
    grouped_markers = (
        "blank",
        "passage",
        "conversation",
        "dialogue",
        "\u6b21\u306e\u6587",
        "\u672c\u6587",
        "\u4f1a\u8a71",
        "\u7a7a\u6b04",
        "__",
    )
    return any(marker in lowered or marker in prompt for marker in grouped_markers)
