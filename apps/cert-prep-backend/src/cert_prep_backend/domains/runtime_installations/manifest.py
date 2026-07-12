from __future__ import annotations

import json
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
from typing import Any
from urllib.parse import urlparse

from cert_prep_backend.api.errors import ProviderUnavailableError
from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.runtime_installations.archive import (
    ALLOW_LOCAL_OCR_RUNTIME_URL_ENV,
    local_file_urls_enabled,
)
from cert_prep_backend.domains.runtime_installations.models import (
    OcrRuntimeManifest,
    utcnow,
)
from cert_prep_contracts.runtime import RuntimeRequirementKind


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
        raise ProviderUnavailableError(
            f"{_label(kind)} runtime manifest is missing artifact metadata."
        )
    try:
        file_name = str(artifact["file_name"])
        sha256 = str(artifact["sha256"])
        expected_bytes = int(artifact["bytes"])
        url = str(artifact["url"]) if artifact.get("url") else None
        entrypoint = str(payload["entrypoint"])
        _validate_artifact_metadata(
            file_name=file_name,
            sha256=sha256,
            expected_bytes=expected_bytes,
            url=url,
            entrypoint=entrypoint,
        )
        return OcrRuntimeManifest(
            kind=kind,
            version=str(payload["version"]),
            target=str(payload["target"]),
            file_name=file_name,
            sha256=sha256,
            bytes=expected_bytes,
            entrypoint=entrypoint,
            url=url,
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
    if kind == RuntimeRequirementKind.WINDOWSML_OCR:
        return settings.windowsml_ocr_runtime_manifest_path
    return settings.ocr_runtime_manifest_path


def _manifest_kind(payload: dict[str, Any]) -> RuntimeRequirementKind:
    raw = payload.get("kind") or RuntimeRequirementKind.PADDLE_OCR.value
    try:
        return RuntimeRequirementKind(str(raw))
    except ValueError as exc:
        raise ProviderUnavailableError(f"OCR runtime manifest has unsupported kind: {raw}") from exc


def _label(kind: RuntimeRequirementKind) -> str:
    if kind == RuntimeRequirementKind.WINDOWSML_OCR:
        return "WindowsML OCR"
    return "PaddleOCR"


def _validate_artifact_metadata(
    *,
    file_name: str,
    sha256: str,
    expected_bytes: int,
    url: str | None,
    entrypoint: str,
) -> None:
    if (
        Path(file_name).name != file_name
        or PureWindowsPath(file_name).name != file_name
        or ":" in file_name
        or not file_name.casefold().endswith(".zip")
    ):
        raise ProviderUnavailableError(
            "OCR runtime artifact file_name must be a plain ZIP file name."
        )
    normalized_entrypoint = entrypoint.replace("\\", "/")
    posix_entrypoint = PurePosixPath(normalized_entrypoint)
    windows_entrypoint = PureWindowsPath(entrypoint)
    if (
        not entrypoint.strip()
        or entrypoint.endswith(("/", "\\"))
        or posix_entrypoint.is_absolute()
        or windows_entrypoint.is_absolute()
        or windows_entrypoint.drive
        or not posix_entrypoint.parts
        or ".." in posix_entrypoint.parts
        or any(":" in part for part in posix_entrypoint.parts)
    ):
        raise ProviderUnavailableError("OCR runtime entrypoint must be a safe relative path.")
    if re.fullmatch(r"[0-9a-fA-F]{64}", sha256) is None or expected_bytes <= 0:
        raise ProviderUnavailableError("OCR runtime artifact digest or byte count is invalid.")
    if url is None:
        return
    parsed = urlparse(url)
    if (
        parsed.scheme.casefold() == "file"
        and local_file_urls_enabled()
        and not parsed.username
        and not parsed.password
        and not parsed.query
        and not parsed.fragment
        and parsed.netloc.casefold() in {"", "localhost"}
    ):
        return
    if (
        parsed.scheme.casefold() != "https"
        or (parsed.hostname or "").casefold() != "github.com"
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or re.fullmatch(
            r"/[^/]+/[^/]+/releases/download/[^/]+/[^/]+\.zip",
            parsed.path,
        )
        is None
    ):
        raise ProviderUnavailableError(
            "OCR runtime artifact URL must be a versioned GitHub Release ZIP URL; "
            f"local files require {ALLOW_LOCAL_OCR_RUNTIME_URL_ENV}=true."
        )
