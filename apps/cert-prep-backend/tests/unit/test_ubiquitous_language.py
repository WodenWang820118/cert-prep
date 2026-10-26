"""Domain names come from the glossary, and API enum values from the concept set (DDD plan
section 5, decisions D11 and D12)."""

from __future__ import annotations

from collections import Counter
from enum import Enum
import inspect
import json
from pathlib import Path

from cert_prep_backend.api.app import create_app
from cert_prep_backend.platform.config import Settings
from semantic_layers import REPOSITORY_ROOT, documented_contexts, glossary_code_names, modules_of

VOCABULARY = REPOSITORY_ROOT / "packages" / "cert-prep-contracts" / "vocabulary" / "cert-prep-vocabulary-v1.json"


def _concepts() -> list[dict]:
    return json.loads(VOCABULARY.read_text(encoding="utf-8"))["concepts"]


def _domain_enums() -> dict[str, type[Enum]]:
    enums: dict[str, type[Enum]] = {}
    for context in documented_contexts():
        for module in modules_of(f"cert_prep_backend.{context}.domain"):
            for name, value in vars(module).items():
                if inspect.isclass(value) and issubclass(value, Enum) and value.__module__ == module.__name__:
                    enums[name] = value
    return enums


def test_some_context_is_checked() -> None:
    assert "projects" in documented_contexts()


def test_public_domain_classes_are_named_in_the_glossary() -> None:
    names = glossary_code_names()
    missing: dict[str, list[str]] = {}
    for context in documented_contexts():
        for module in modules_of(f"cert_prep_backend.{context}.domain"):
            for name, value in vars(module).items():
                if (
                    not name.startswith("_")
                    and inspect.isclass(value)
                    and value.__module__ == module.__name__
                    and name not in names
                ):
                    missing.setdefault(context, []).append(name)

    assert missing == {}, "add these names to the glossary or rename them"


def test_concepts_have_unique_ids_and_mappings() -> None:
    concepts = _concepts()
    ids = Counter(concept["id"] for concept in concepts)
    mappings = Counter(
        (concept["enum"]["enumId"], concept["enum"]["value"]) for concept in concepts if "enum" in concept
    )

    assert [concept_id for concept_id, count in ids.items() if count > 1] == []
    assert [mapping for mapping, count in mappings.items() if count > 1] == []
    assert all(concept["label"] and concept["codeName"] for concept in concepts)


def test_every_api_enum_value_of_a_modelled_context_maps_to_one_concept(tmp_path: Path) -> None:
    schemas = (
        create_app(settings=Settings(data_dir=tmp_path, api_token="t", llm_provider="fake"))
        .openapi()["components"]["schemas"]
    )
    domain_enums = _domain_enums()
    api_values = {
        (enum_id, value)
        for enum_id, schema in schemas.items()
        if enum_id in domain_enums and "enum" in schema
        for value in schema["enum"]
    }
    mapped = {
        (concept["enum"]["enumId"], concept["enum"]["value"])
        for concept in _concepts()
        if "enum" in concept and not concept.get("retired")
    }

    assert sorted(api_values - mapped) == [], "add concepts for these enum values"
    assert sorted(
        mapping for mapping in mapped if mapping[0] in domain_enums and mapping not in api_values
    ) == [], "these concepts map to values the API no longer has; retire them"
