from __future__ import annotations

from collections.abc import Iterable
from typing import Any


def extract_prediction_text(predictions: Any) -> str:
    texts: list[str] = []
    seen: set[str] = set()
    for text in _walk_prediction_texts(predictions):
        normalized = " ".join(text.split())
        if normalized and normalized not in seen:
            seen.add(normalized)
            texts.append(normalized)
    return "\n".join(texts)


def _walk_prediction_texts(value: Any) -> list[str]:
    if value is None or isinstance(value, str):
        return []
    if isinstance(value, dict):
        direct: list[str] = []
        for key in ("rec_texts", "texts"):
            item = value.get(key)
            if isinstance(item, list):
                direct.extend(text for text in item if isinstance(text, str))
        for key in ("rec_text", "text"):
            item = value.get(key)
            if isinstance(item, str):
                direct.append(item)
        if direct:
            return direct
        return _walk_many(value.values())
    if isinstance(value, list | tuple):
        return _walk_many(value)
    if isinstance(value, Iterable):
        return _walk_many(value)
    if hasattr(value, "json"):
        try:
            return _walk_prediction_texts(value.json)
        except Exception:
            pass
    if hasattr(value, "to_dict"):
        try:
            return _walk_prediction_texts(value.to_dict())
        except Exception:
            pass
    if hasattr(value, "__dict__"):
        return _walk_prediction_texts(vars(value))
    return []


def _walk_many(values) -> list[str]:
    nested: list[str] = []
    for item in values:
        nested.extend(_walk_prediction_texts(item))
    return nested
