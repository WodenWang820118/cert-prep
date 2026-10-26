"""Domain names come from the glossary (DDD plan section 5).

The OpenAPI enum check against the concept set (decision D12) joins with the first context
whose model has enums.
"""

from __future__ import annotations

import inspect

from semantic_layers import documented_contexts, glossary_code_names, modules_of


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
