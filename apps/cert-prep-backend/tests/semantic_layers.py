"""What the semantic-layering tests read (DDD plan section 5, decision D11).

A context takes part once it has docs/domain/<context>.md; step C4 writes that page when it
gives the context its domain model, so each C4 PR adds one context to these checks.
"""

from __future__ import annotations

import importlib
import pkgutil
import re
from pathlib import Path
from types import ModuleType

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
SOURCE_ROOT = REPOSITORY_ROOT / "apps" / "cert-prep-backend" / "src" / "cert_prep_backend"
DOMAIN_DOCS = REPOSITORY_ROOT / "docs" / "domain"
GLOSSARY = REPOSITORY_ROOT / ".agents" / "PLANS" / "ddd-refactor" / "glossary.md"
_CODE_NAME = re.compile(r"`([A-Za-z_][A-Za-z0-9_]*)`")


def documented_contexts() -> list[str]:
    return sorted(
        page.stem
        for page in DOMAIN_DOCS.glob("*.md")
        if page.name != "README.md" and (SOURCE_ROOT / page.stem).is_dir()
    )


def modules_of(package_name: str) -> list[ModuleType]:
    package = importlib.import_module(package_name)
    modules = [package]
    for info in pkgutil.walk_packages(package.__path__, prefix=f"{package_name}."):
        modules.append(importlib.import_module(info.name))
    return modules


def glossary_code_names() -> set[str]:
    """Every name in the code-name column of the glossary's tables."""

    names: set[str] = set()
    for line in GLOSSARY.read_text(encoding="utf-8").splitlines():
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if line.lstrip().startswith("|") and len(cells) >= 2:
            names.update(_CODE_NAME.findall(cells[1]))
    return names


def documented_use_cases(context: str) -> set[str]:
    """The code names in the use-case table of docs/domain/<context>.md."""

    text = (DOMAIN_DOCS / f"{context}.md").read_text(encoding="utf-8")
    section = text.split("\n## 用例", 1)[1].split("\n## ", 1)[0]
    names: set[str] = set()
    for line in section.splitlines():
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if line.lstrip().startswith("|") and len(cells) >= 2:
            names.update(_CODE_NAME.findall(cells[1]))
    return names
