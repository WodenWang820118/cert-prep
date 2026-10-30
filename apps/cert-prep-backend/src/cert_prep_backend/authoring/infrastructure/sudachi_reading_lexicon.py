"""Sudachi's core dictionary as a lazy, thread-safe reading lexicon."""

import logging
import re
from threading import Lock
from typing import TYPE_CHECKING

from cert_prep_backend.authoring.domain.reading_solver import ReadingSpan

if TYPE_CHECKING:
    from sudachipy import Dictionary, Tokenizer


_LOGGER = logging.getLogger(__name__)
_KANJI = re.compile(r"[㐀-鿿々]")


class SudachiReadingLexicon:
    def __init__(self) -> None:
        self._lock = Lock()
        self._dictionary: Dictionary | None = None
        self._tokenizer: Tokenizer | None = None
        self._unavailable = False

    def kanji_span_readings(self, text: str) -> tuple[ReadingSpan, ...]:
        # Materialize every surface/reading under the lock: both the tokenizer
        # and its token buffers must remain private to this call.
        with self._lock:
            if self._unavailable:
                return ()
            try:
                from sudachipy import Dictionary, SplitMode

                if self._tokenizer is None:
                    self._dictionary = Dictionary(dict="core")
                    self._tokenizer = self._dictionary.tokenizer()
                assert self._dictionary is not None
                spans: set[ReadingSpan] = set()
                surfaces: set[str] = set()
                for mode in (SplitMode.A, SplitMode.C):
                    tokens = list(self._tokenizer.tokenize(text, mode))
                    for start in range(len(tokens)):
                        for end in range(start + 1, min(start + 4, len(tokens)) + 1):
                            surface = "".join(token.surface() for token in tokens[start:end])
                            if _KANJI.search(surface):
                                surfaces.add(surface)
                                # Numeric readings are context-sensitive even when
                                # Sudachi emits one token (三百 -> サンヒャク).
                                if end == start + 1 and tokens[start].part_of_speech()[1] != "数詞":
                                    spans.add(ReadingSpan(surface, tokens[start].reading_form()))
                # Lookup also finds entries for spans split across morphemes.
                # It normalizes its input, so retain only exact surface matches.
                for surface in sorted(surfaces):
                    for entry in self._dictionary.lookup(surface):
                        if entry.surface() == surface and entry.part_of_speech()[1] != "数詞":
                            spans.add(ReadingSpan(surface, entry.reading_form()))
                return tuple(sorted(spans, key=lambda span: (span.surface, span.reading)))
            except Exception:
                self._unavailable = True
                _LOGGER.warning(
                    "Sudachi reading lexicon unavailable; using model answer inference.",
                    exc_info=True,
                )
                return ()
