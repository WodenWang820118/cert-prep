from __future__ import annotations

import argparse
from collections.abc import Iterable
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import stat
from typing import Any
from zipfile import ZipFile, ZipInfo


DEFAULT_DECLARATION = Path(__file__).with_name("ocr-runtime-payload-declaration.json")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
MAX_PIPELINE_BYTES = 1_000_000


class PayloadInventoryError(ValueError):
    """The packaged runtime does not match its fail-closed payload declaration."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def collect_runtime_payloads(
    *,
    runtime_manifest: Path,
    runtime_root: Path,
    declaration_path: Path = DEFAULT_DECLARATION,
) -> dict[str, Any]:
    manifest = _read_json(runtime_manifest, "runtime manifest")
    declaration = _read_json(declaration_path, "payload declaration")
    expected_entries, source_artifacts, component = _validate_declaration(declaration)
    artifact_path = _validate_runtime_manifest(
        manifest=manifest,
        runtime_root=runtime_root,
        declaration=declaration,
    )

    with ZipFile(artifact_path) as archive:
        infos = _validated_archive_files(archive)
        actual_names = set(infos)
        expected_names = {declaration["entrypoint"], *expected_entries}
        if actual_names != expected_names:
            unexpected = sorted(actual_names - expected_names)
            missing = sorted(expected_names - actual_names)
            detail = []
            if unexpected:
                detail.append(f"undeclared entries: {', '.join(unexpected)}")
            if missing:
                detail.append(f"missing entries: {', '.join(missing)}")
            raise PayloadInventoryError(
                "OCR runtime ZIP does not exactly match the payload declaration ("
                + "; ".join(detail)
                + ")."
            )

        pipeline = _read_pipeline(archive, infos["pipeline.json"])
        _validate_pipeline(
            pipeline,
            expected_entries=expected_entries,
            source_artifacts=source_artifacts,
        )
        entrypoint = _inventory_entry(
            archive,
            infos[declaration["entrypoint"]],
        )
        entries = [_inventory_entry(archive, infos[name]) for name in expected_entries]

    artifact = manifest["artifact"]
    public_sources = [
        {key: value for key, value in source.items() if key != "payloadEntries"}
        for source in source_artifacts
    ]
    return {
        "schemaVersion": 1,
        "artifact": {
            "kind": manifest["kind"],
            "fileName": artifact["file_name"],
            "bytes": artifact["bytes"],
            "sha256": artifact["sha256"].lower(),
            "manifestSha256": sha256_file(runtime_manifest),
        },
        "entrypoint": entrypoint,
        "entries": entries,
        "components": [
            {
                **component,
                "licenseTexts": [],
                "sourceArtifacts": public_sources,
                "files": entries,
            }
        ],
    }


def _read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise PayloadInventoryError(f"Could not read {label}: {path}.") from exc
    if not isinstance(value, dict):
        raise PayloadInventoryError(f"{label.capitalize()} must be a JSON object.")
    return value


def _validate_declaration(
    declaration: dict[str, Any],
) -> tuple[list[str], list[dict[str, Any]], dict[str, Any]]:
    if declaration.get("schemaVersion") != 1:
        raise PayloadInventoryError("Payload declaration schemaVersion must be 1.")
    artifact_kind = declaration.get("artifactKind")
    entrypoint = declaration.get("entrypoint")
    raw_entries = declaration.get("payloadEntries")
    raw_sources = declaration.get("sourceArtifacts")
    component = declaration.get("component")
    if (
        artifact_kind != "windowsml_ocr"
        or not _is_safe_archive_name(entrypoint)
        or not isinstance(raw_entries, list)
        or not isinstance(raw_sources, list)
        or not isinstance(component, dict)
    ):
        raise PayloadInventoryError("OCR payload declaration shape is invalid.")

    entries = [str(value) for value in raw_entries]
    if (
        len(entries) != len(set(entries))
        or any(not _is_safe_archive_name(value) for value in entries)
        or entrypoint in entries
        or "pipeline.json" not in entries
    ):
        raise PayloadInventoryError("Declared OCR payload entries are invalid.")

    source_artifacts: list[dict[str, Any]] = []
    source_kinds: set[str] = set()
    source_covered_entries: set[str] = set()
    for raw_source in raw_sources:
        if not isinstance(raw_source, dict):
            raise PayloadInventoryError("Declared OCR source artifact is invalid.")
        source = dict(raw_source)
        payload_entries = source.get("payloadEntries")
        source_kind = source.get("kind")
        if (
            source_kind not in {"det", "rec"}
            or source_kind in source_kinds
            or not isinstance(source.get("model_name"), str)
            or not source["model_name"]
            or not str(source.get("url", "")).startswith(
                "https://paddle-model-ecology.bj.bcebos.com/paddlex/"
            )
            or not SHA256_PATTERN.fullmatch(str(source.get("sha256", "")).lower())
            or not isinstance(source.get("bytes"), int)
            or source["bytes"] <= 0
            or not isinstance(source.get("archive_root"), str)
            or not source["archive_root"]
            or not isinstance(payload_entries, list)
        ):
            raise PayloadInventoryError("Declared OCR source artifact is invalid.")
        normalized_payload_entries = [str(value) for value in payload_entries]
        if any(value not in entries for value in normalized_payload_entries):
            raise PayloadInventoryError(
                "OCR source artifact refers to an undeclared payload entry."
            )
        overlap = source_covered_entries.intersection(normalized_payload_entries)
        if overlap:
            raise PayloadInventoryError(
                "OCR source artifacts overlap payload entries: "
                + ", ".join(sorted(overlap))
                + "."
            )
        source["payloadEntries"] = normalized_payload_entries
        source_kinds.add(source_kind)
        source_covered_entries.update(normalized_payload_entries)
        source_artifacts.append(source)

    # pipeline.json is generated locally from both source records. All remaining
    # model, config, and dictionary files must map to exactly one official source.
    source_payload_entries = set(entries) - {"pipeline.json"}
    if (
        source_kinds != {"det", "rec"}
        or source_covered_entries != source_payload_entries
    ):
        raise PayloadInventoryError(
            "Every model, config, and dictionary payload must map to one source artifact."
        )

    required_component_fields = {
        "ecosystem": "generic",
        "license": "Apache-2.0",
    }
    if any(
        component.get(key) != value for key, value in required_component_fields.items()
    ):
        raise PayloadInventoryError("OCR payload component metadata is invalid.")
    if any(
        not isinstance(component.get(key), str) or not component[key]
        for key in ("name", "version", "purl")
    ):
        raise PayloadInventoryError("OCR payload component identity is invalid.")
    repositories = component.get("sourceRepositories")
    evidence = component.get("licenseEvidence")
    if repositories != [
        "https://github.com/PaddlePaddle/PaddleOCR",
        "https://github.com/PaddlePaddle/PaddleX",
    ] or evidence != [
        "https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/v3.7.0/LICENSE",
        "https://raw.githubusercontent.com/PaddlePaddle/PaddleX/v3.7.1/LICENSE",
    ]:
        raise PayloadInventoryError(
            "OCR payload component must retain official PaddleOCR/PaddleX sources."
        )
    return entries, source_artifacts, dict(component)


def _validate_runtime_manifest(
    *,
    manifest: dict[str, Any],
    runtime_root: Path,
    declaration: dict[str, Any],
) -> Path:
    artifact = manifest.get("artifact")
    if (
        manifest.get("schema_version") != 1
        or manifest.get("kind") != declaration["artifactKind"]
        or manifest.get("entrypoint") != declaration["entrypoint"]
        or not isinstance(artifact, dict)
    ):
        raise PayloadInventoryError("OCR runtime manifest identity is invalid.")
    file_name = artifact.get("file_name")
    artifact_bytes = artifact.get("bytes")
    artifact_sha256 = str(artifact.get("sha256", "")).lower()
    if (
        not isinstance(file_name, str)
        or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*\.zip", file_name) is None
        or not isinstance(artifact_bytes, int)
        or artifact_bytes <= 0
        or not SHA256_PATTERN.fullmatch(artifact_sha256)
    ):
        raise PayloadInventoryError("OCR runtime artifact metadata is invalid.")
    artifact_path = runtime_root.resolve() / file_name
    if not artifact_path.is_file():
        raise PayloadInventoryError(
            f"OCR runtime artifact is missing: {artifact_path}."
        )
    if artifact_path.stat().st_size != artifact_bytes:
        raise PayloadInventoryError("OCR runtime artifact byte count is invalid.")
    if sha256_file(artifact_path) != artifact_sha256:
        raise PayloadInventoryError("OCR runtime artifact SHA-256 is invalid.")
    return artifact_path


def _validated_archive_files(archive: ZipFile) -> dict[str, ZipInfo]:
    infos: dict[str, ZipInfo] = {}
    for info in archive.infolist():
        if (
            info.is_dir()
            or not _is_safe_archive_name(info.filename)
            or info.flag_bits & 0x1
            or stat.S_ISLNK(info.external_attr >> 16)
        ):
            raise PayloadInventoryError(
                f"OCR runtime ZIP contains an unsafe entry: {info.filename}."
            )
        if info.filename in infos:
            raise PayloadInventoryError(
                f"OCR runtime ZIP contains a duplicate entry: {info.filename}."
            )
        if info.file_size <= 0:
            raise PayloadInventoryError(
                f"OCR runtime ZIP contains an empty entry: {info.filename}."
            )
        infos[info.filename] = info
    return infos


def _is_safe_archive_name(value: object) -> bool:
    if not isinstance(value, str) or not value or "\\" in value:
        return False
    path = PurePosixPath(value)
    return not path.is_absolute() and all(
        part not in {"", ".", ".."} for part in path.parts
    )


def _read_pipeline(archive: ZipFile, info: ZipInfo) -> dict[str, Any]:
    if info.file_size > MAX_PIPELINE_BYTES:
        raise PayloadInventoryError("OCR runtime pipeline.json is unexpectedly large.")
    try:
        value = json.loads(archive.read(info).decode("utf-8-sig"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise PayloadInventoryError("OCR runtime pipeline.json is invalid.") from exc
    if not isinstance(value, dict):
        raise PayloadInventoryError("OCR runtime pipeline.json must be an object.")
    return value


def _validate_pipeline(
    pipeline: dict[str, Any],
    *,
    expected_entries: list[str],
    source_artifacts: list[dict[str, Any]],
) -> None:
    expected_sources = [
        {key: value for key, value in source.items() if key != "payloadEntries"}
        for source in source_artifacts
    ]
    runtime_contract = pipeline.get("runtime_contract")
    required_files = (
        runtime_contract.get("required_files")
        if isinstance(runtime_contract, dict)
        else None
    )
    if (
        pipeline.get("schema_version") != 1
        or pipeline.get("model_family") != "PP-OCRv6_medium"
        or pipeline.get("source") != "PaddleX official inference models"
        or pipeline.get("source_artifacts") != expected_sources
        or required_files != expected_entries
    ):
        raise PayloadInventoryError(
            "OCR runtime pipeline source or required-file contract is invalid."
        )


def _inventory_entry(archive: ZipFile, info: ZipInfo) -> dict[str, Any]:
    digest = hashlib.sha256()
    with archive.open(info, "r") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return {
        "path": info.filename,
        "bytes": info.file_size,
        "sha256": digest.hexdigest(),
    }


def write_inventory(output: Path, inventory: dict[str, Any]) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(inventory, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def main(argv: Iterable[str] | None = None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-manifest", type=Path, required=True)
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--declaration", type=Path, default=DEFAULT_DECLARATION)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    inventory = collect_runtime_payloads(
        runtime_manifest=args.runtime_manifest,
        runtime_root=args.runtime_root,
        declaration_path=args.declaration,
    )
    write_inventory(args.output, inventory)


if __name__ == "__main__":
    main()
