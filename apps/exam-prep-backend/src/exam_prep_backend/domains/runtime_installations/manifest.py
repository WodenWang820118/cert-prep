from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from exam_prep_backend.config import Settings
from exam_prep_backend.domains.runtime_installations.models import (
    OcrRuntimeManifest,
    RuntimeRequirementKind,
    utcnow,
)
from exam_prep_backend.errors import ProviderUnavailableError


def load_ocr_runtime_source_manifest(
    settings: Settings,
    *,
    kind: RuntimeRequirementKind = RuntimeRequirementKind.PADDLE_OCR,
) -> OcrRuntimeManifest:
    """Load the configured OCR runtime artifact manifest from disk."""

    manifest_path = _manifest_path(settings, kind)
    if manifest_path is None or not manifest_path.is_file():
        raise ProviderUnavailableError(f"{_label(kind)} runtime manifest is not configured.")
    return parse_ocr_runtime_manifest(
        json.loads(manifest_path.read_text(encoding="utf-8")),
        manifest_path,
        expected_kind=kind,
    )


def parse_ocr_runtime_manifest(
    payload: dict[str, Any],
    manifest_path: Path,
    *,
    expected_kind: RuntimeRequirementKind | None = None,
) -> OcrRuntimeManifest:
    """Validate manifest JSON and return runtime artifact metadata."""

    kind = _manifest_kind(payload)
    if expected_kind is not None and kind != expected_kind:
        raise ProviderUnavailableError(
            f"{_label(expected_kind)} runtime manifest has wrong kind: {kind.value}."
        )
    artifact = payload.get("artifact")
    if not isinstance(artifact, dict):
        raise ProviderUnavailableError(f"{_label(kind)} runtime manifest is missing artifact metadata.")
    try:
        return OcrRuntimeManifest(
            kind=kind,
            version=str(payload["version"]),
            target=str(payload["target"]),
            file_name=str(artifact["file_name"]),
            sha256=str(artifact["sha256"]),
            bytes=int(artifact["bytes"]),
            entrypoint=str(payload["entrypoint"]),
            url=str(artifact["url"]) if artifact.get("url") else None,
            base_dir=manifest_path.parent,
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ProviderUnavailableError(
            f"{_label(kind)} runtime manifest is invalid: {manifest_path}"
        ) from exc


def write_installed_ocr_manifest(runtime_dir: Path, manifest: OcrRuntimeManifest) -> None:
    """Record the manifest metadata for an installed OCR runtime."""

    payload = {
        "schema_version": 1,
        "kind": manifest.kind.value,
        "version": manifest.version,
        "target": manifest.target,
        "entrypoint": manifest.entrypoint,
        "artifact": {
            "file_name": manifest.file_name,
            "sha256": manifest.sha256,
            "bytes": manifest.bytes,
            "url": manifest.url,
        },
        "installed_at": utcnow().isoformat(),
    }
    (runtime_dir / "runtime-manifest.json").write_text(
        json.dumps(payload, indent=2) + "\n",
        encoding="utf-8",
    )


def _manifest_path(settings: Settings, kind: RuntimeRequirementKind) -> Path | None:
    if kind == RuntimeRequirementKind.DIRECTML_OCR:
        return settings.directml_ocr_runtime_manifest_path
    return settings.ocr_runtime_manifest_path


def _manifest_kind(payload: dict[str, Any]) -> RuntimeRequirementKind:
    raw = payload.get("kind") or RuntimeRequirementKind.PADDLE_OCR.value
    try:
        return RuntimeRequirementKind(str(raw))
    except ValueError as exc:
        raise ProviderUnavailableError(f"OCR runtime manifest has unsupported kind: {raw}") from exc


def _label(kind: RuntimeRequirementKind) -> str:
    if kind == RuntimeRequirementKind.DIRECTML_OCR:
        return "AMD DirectML OCR"
    return "PaddleOCR"
