from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from exam_prep_backend.config import Settings
from exam_prep_backend.domains.runtime_installations.models import OcrRuntimeManifest, utcnow
from exam_prep_backend.errors import ProviderUnavailableError


def load_ocr_runtime_source_manifest(settings: Settings) -> OcrRuntimeManifest:
    """Load the configured PaddleOCR runtime artifact manifest from disk."""

    manifest_path = settings.ocr_runtime_manifest_path
    if manifest_path is None or not manifest_path.is_file():
        raise ProviderUnavailableError("PaddleOCR runtime manifest is not configured.")
    return parse_ocr_runtime_manifest(
        json.loads(manifest_path.read_text(encoding="utf-8")),
        manifest_path,
    )


def parse_ocr_runtime_manifest(payload: dict[str, Any], manifest_path: Path) -> OcrRuntimeManifest:
    """Validate manifest JSON and return runtime artifact metadata."""

    artifact = payload.get("artifact")
    if not isinstance(artifact, dict):
        raise ProviderUnavailableError("PaddleOCR runtime manifest is missing artifact metadata.")
    try:
        return OcrRuntimeManifest(
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
            f"PaddleOCR runtime manifest is invalid: {manifest_path}"
        ) from exc


def write_installed_ocr_manifest(runtime_dir: Path, manifest: OcrRuntimeManifest) -> None:
    """Record the manifest metadata for an installed PaddleOCR runtime."""

    payload = {
        "schema_version": 1,
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
