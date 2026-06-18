from __future__ import annotations

import hashlib
import os
from pathlib import Path
from urllib.request import urlretrieve
from zipfile import ZipFile

from exam_prep_backend.domains.runtime_installations.models import OcrRuntimeManifest
from exam_prep_backend.errors import ProviderUnavailableError


def resolve_ocr_runtime_artifact(manifest: OcrRuntimeManifest) -> Path:
    """Find or download the PaddleOCR runtime archive described by the manifest."""

    candidates = [
        (manifest.base_dir / manifest.file_name) if manifest.base_dir is not None else None,
        Path(manifest.file_name),
        Path.cwd() / manifest.file_name,
        Path.home() / "Downloads" / manifest.file_name,
    ]
    for candidate in candidates:
        if candidate is not None and candidate.is_file():
            return candidate.resolve()
    if manifest.url:
        download_dir = Path(os.environ.get("TEMP", Path.cwd())) / "exam-prep-runtime-downloads"
        download_dir.mkdir(parents=True, exist_ok=True)
        target = download_dir / manifest.file_name
        urlretrieve(manifest.url, target)
        return target
    raise ProviderUnavailableError(
        f"PaddleOCR runtime artifact was not found: {manifest.file_name}"
    )


def verify_file_hash(path: Path, sha256: str, *, expected_bytes: int) -> None:
    """Verify archive size and SHA-256 before installing a runtime artifact."""

    digest = hashlib.sha256()
    total = 0
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            total += len(chunk)
            digest.update(chunk)
    if total != expected_bytes:
        raise ProviderUnavailableError(
            f"OCR runtime artifact size mismatch: expected {expected_bytes}, found {total}."
        )
    actual = digest.hexdigest()
    if actual.lower() != sha256.lower():
        raise ProviderUnavailableError("OCR runtime artifact checksum mismatch.")


def extract_zip_safely(artifact: Path, destination: Path) -> None:
    """Extract a zip archive only when all members stay under the destination."""

    destination.mkdir(parents=True, exist_ok=True)
    with ZipFile(artifact) as archive:
        for member in archive.infolist():
            target = (destination / member.filename).resolve()
            if not str(target).startswith(str(destination.resolve())):
                raise ProviderUnavailableError("OCR runtime artifact contains an unsafe path.")
        archive.extractall(destination)
