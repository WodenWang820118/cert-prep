from __future__ import annotations

import argparse
import json
import re
from importlib import metadata
from pathlib import Path
from typing import NamedTuple


CLASSIFIER_LICENSES = {
    "License :: OSI Approved :: Apache Software License": "Apache-2.0",
    "License :: OSI Approved :: BSD License": "BSD-3-Clause",
    "License :: OSI Approved :: ISC License (ISCL)": "ISC",
    "License :: OSI Approved :: MIT License": "MIT",
    "License :: OSI Approved :: Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
    "License :: OSI Approved :: Python Software Foundation License": "Python-2.0",
}

LICENSE_ALIASES = {
    "apache 2.0": "Apache-2.0",
    "apache license 2.0": "Apache-2.0",
    "apache license v2.0": "Apache-2.0",
    "apache software license": "Apache-2.0",
    "bsd": "BSD-3-Clause",
    "3-clause bsd license": "BSD-3-Clause",
    "bsd 3-clause": "BSD-3-Clause",
    "bsd license": "BSD-3-Clause",
    "isc license": "ISC",
    "mit license": "MIT",
    "python software foundation license": "Python-2.0",
    # pypdfium2 ships these named license texts under dist-info/licenses/LICENSES.
    "bsd-3-clause, apache-2.0, dependency licenses": (
        "BSD-3-Clause AND Apache-2.0 AND CC-BY-4.0"
    ),
    "gplv2-or-later with a special exception which allows to use pyinstaller to build "
    "and distribute non-free programs (including commercial ones)": (
        "GPL-2.0-or-later WITH Bootloader-exception"
    ),
}

WORKSPACE_ROOT = Path(__file__).resolve().parents[2]
PRIMARY_LICENSE_FILE = re.compile(
    r"^(?:licen[cs]e|copying)(?:[._-].*)?$", re.IGNORECASE
)
SUPPLEMENTAL_LICENSE_FILE = re.compile(
    r"^(?:notice|copyright)(?:[._-].*)?$", re.IGNORECASE
)
MAX_LICENSE_TEXT_BYTES = 1_000_000
VERSIONED_LICENSE_OVERRIDES = {
    ("pyinstaller", "6.20.0"): {
        "license": "GPL-2.0-or-later WITH Bootloader-exception",
        "evidence": (
            "https://github.com/pyinstaller/pyinstaller/blob/v6.20.0/COPYING.txt"
        ),
    },
    ("python-bidi", "0.6.10"): {
        "license": "LGPL-3.0-or-later",
        "evidence": (
            "https://github.com/MeirKriheli/python-bidi/blob/v0.6.10/bidi/algorithm.py"
        ),
    },
    ("python-dateutil", "2.9.0.post0"): {
        "license": "BSD-3-Clause OR Apache-2.0",
        "evidence": ("https://github.com/dateutil/dateutil/blob/2.9.0.post0/LICENSE"),
    },
}


class IncludedDistribution(NamedTuple):
    name: str
    normalized_name: str
    version: str


def parse_included_distribution(value: str) -> IncludedDistribution:
    match = re.fullmatch(
        r"(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)==(?P<version>[^=\s]+)",
        value.strip(),
    )
    if match is None:
        raise ValueError(
            "Included distributions must use an exact name==version requirement."
        )
    name = match.group("name")
    return IncludedDistribution(
        name=name,
        normalized_name=normalize_distribution_name(name),
        version=match.group("version"),
    )


def normalize_distribution_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def declared_license(distribution: metadata.Distribution) -> str | None:
    name = distribution.metadata.get("Name", "")
    if name.lower().startswith("cert-prep-"):
        return "MIT"

    override = versioned_license_override(distribution)
    if override is not None:
        return override["license"]

    expression = distribution.metadata.get("License-Expression")
    if expression and expression.strip():
        return expression.strip()

    raw_license = (distribution.metadata.get("License") or "").strip()
    if raw_license:
        alias = LICENSE_ALIASES.get(raw_license.lower())
        if alias:
            return alias
        if (
            len(raw_license) <= 160
            and "\n" not in raw_license
            and "\r" not in raw_license
        ):
            return raw_license

    classifier_licenses = {
        CLASSIFIER_LICENSES[classifier]
        for classifier in distribution.metadata.get_all("Classifier", [])
        if classifier in CLASSIFIER_LICENSES
    }
    if len(classifier_licenses) == 1:
        return classifier_licenses.pop()
    if classifier_licenses:
        return " OR ".join(sorted(classifier_licenses))
    return None


def versioned_license_override(
    distribution: metadata.Distribution,
) -> dict[str, str] | None:
    name = (distribution.metadata.get("Name") or "").lower()
    version = str(getattr(distribution, "version", ""))
    return VERSIONED_LICENSE_OVERRIDES.get((name, version))


def bundled_license_texts(
    distribution: metadata.Distribution,
) -> list[dict[str, str | bool]]:
    name = distribution.metadata.get("Name", "")
    if name.lower().startswith("cert-prep-"):
        return [_read_license_text(WORKSPACE_ROOT / "LICENSE", "LICENSE", primary=True)]

    candidates: list[tuple[Path, str, bool]] = []
    declared_files = {
        str(value).replace("\\", "/")
        for value in distribution.metadata.get_all("License-File", [])
    }
    for entry in distribution.files or []:
        entry_name = Path(str(entry)).name
        normalized = str(entry).replace("\\", "/")
        declared = any(
            normalized == declared_file
            or normalized.endswith(f"/licenses/{declared_file}")
            for declared_file in declared_files
        )
        if (
            declared
            or PRIMARY_LICENSE_FILE.match(entry_name)
            or SUPPLEMENTAL_LICENSE_FILE.match(entry_name)
        ):
            candidates.append(
                (
                    Path(distribution.locate_file(entry)),
                    entry_name,
                    declared or bool(PRIMARY_LICENSE_FILE.match(entry_name)),
                )
            )

    primary = [item for item in candidates if item[2]]
    if not primary:
        return []

    output: list[dict[str, str | bool]] = []
    seen: set[str] = set()
    for path, entry_name, is_primary in [*primary, *candidates]:
        try:
            key = str(path.resolve()).lower()
            if key in seen or not path.is_file():
                continue
            seen.add(key)
            output.append(
                _read_license_text(
                    path,
                    entry_name,
                    primary=is_primary,
                )
            )
        except (OSError, UnicodeError):
            continue
    return output


def _read_license_text(
    path: Path, name: str, *, primary: bool
) -> dict[str, str | bool]:
    size = path.stat().st_size
    if size <= 0 or size > MAX_LICENSE_TEXT_BYTES:
        raise OSError(f"License text has an invalid size: {path}")
    text = path.read_text(encoding="utf-8", errors="replace").strip()
    if not text:
        raise OSError(f"License text is empty: {path}")
    return {"name": name, "text": text + "\n", "primary": primary}


def pyinstaller_archive_index(executable: Path) -> tuple[set[str], set[str]]:
    from PyInstaller.archive.readers import CArchiveReader

    archive = CArchiveReader(str(executable))
    entries = {str(name).replace("\\", "/").lower() for name in archive.toc}
    modules: set[str] = set()
    for name in archive.toc:
        if not str(name).endswith(".pyz"):
            continue
        embedded = archive.open_embedded_archive(name)
        modules.update(str(module).lower() for module in embedded.toc)
    return modules, entries


def distribution_top_level_modules(distribution: metadata.Distribution) -> set[str]:
    output: set[str] = set()
    top_level = distribution.read_text("top_level.txt")
    if top_level:
        output.update(
            line.strip().lower()
            for line in top_level.splitlines()
            if line.strip().isidentifier()
        )
    for entry in distribution.files or []:
        normalized = str(entry).replace("\\", "/")
        root = normalized.split("/", 1)[0]
        if root in {"..", "."} or root.endswith((".dist-info", ".data")):
            continue
        candidate = root.split(".", 1)[0].lower()
        if candidate.isidentifier():
            output.add(candidate)
    return output


def distribution_is_in_archive(
    distribution: metadata.Distribution,
    archive_modules: set[str],
    archive_entries: set[str],
) -> bool:
    for top_level in distribution_top_level_modules(distribution):
        if any(
            module == top_level or module.startswith(f"{top_level}.")
            for module in archive_modules
        ):
            return True
        if any(
            entry.startswith(f"{top_level}/") or entry.startswith(f"{top_level}.")
            for entry in archive_entries
        ):
            return True

    name = re.sub(
        r"[-_.]+", "_", distribution.metadata.get("Name") or distribution.name
    ).lower()
    return any(
        entry.split("/", 1)[0].startswith(f"{name}-")
        and ".dist-info" in entry.split("/", 1)[0]
        for entry in archive_entries
    )


def collect_components(
    executable: Path,
    included_distributions: tuple[str, ...] = (),
) -> list[dict[str, object]]:
    archive_modules, archive_entries = pyinstaller_archive_index(executable)
    included = {
        item.normalized_name: item
        for item in map(parse_included_distribution, included_distributions)
    }
    if len(included) != len(included_distributions):
        raise ValueError("Included distribution requirements must be unique.")
    components = []
    seen: set[tuple[str, str]] = set()
    included_versions: dict[str, set[str]] = {name: set() for name in included}
    satisfied_includes: set[str] = set()
    for distribution in metadata.distributions():
        name = distribution.metadata.get("Name") or distribution.name
        normalized_name = normalize_distribution_name(name)
        included_requirement = included.get(normalized_name)
        if included_requirement is not None:
            included_versions[normalized_name].add(distribution.version)
        explicitly_included = (
            included_requirement is not None
            and distribution.version == included_requirement.version
        )
        if not explicitly_included and not distribution_is_in_archive(
            distribution, archive_modules, archive_entries
        ):
            continue
        version = distribution.version
        key = (name.lower(), version)
        if key in seen:
            continue
        seen.add(key)
        license_expression = declared_license(distribution)
        license_texts = bundled_license_texts(distribution)
        if explicitly_included and (
            license_expression is None
            or not any(item.get("primary") is True for item in license_texts)
        ):
            raise RuntimeError(
                "Explicitly included distribution is missing its license expression "
                f"or complete primary license text: {name}=={version}."
            )
        component: dict[str, object] = {
            "name": name,
            "version": version,
            "license": license_expression,
            "licenseTexts": license_texts,
        }
        override = versioned_license_override(distribution)
        if override is not None:
            component["licenseEvidence"] = override["evidence"]
        components.append(component)
        if explicitly_included:
            satisfied_includes.add(normalized_name)

    missing = sorted(set(included) - satisfied_includes)
    if missing:
        details = []
        for name in missing:
            requirement = included[name]
            installed = sorted(included_versions[name])
            suffix = (
                f"; installed versions: {', '.join(installed)}" if installed else ""
            )
            details.append(f"{requirement.name}=={requirement.version}{suffix}")
        raise RuntimeError(
            "Required explicitly included distributions were not found at the exact "
            f"version: {'; '.join(details)}."
        )
    return sorted(components, key=lambda item: (item["name"].lower(), item["version"]))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--pyinstaller-executable", type=Path, required=True)
    parser.add_argument(
        "--include-distribution",
        action="append",
        default=[],
        help=(
            "Include build tooling that is not visible as an embedded Python module; "
            "must use an exact name==version requirement."
        ),
    )
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(
            collect_components(
                args.pyinstaller_executable,
                tuple(args.include_distribution),
            ),
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
