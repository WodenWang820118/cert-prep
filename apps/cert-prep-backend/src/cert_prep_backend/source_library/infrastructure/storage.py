from __future__ import annotations

import hashlib
from pathlib import Path

from cert_prep_backend.platform.config import Settings
from cert_prep_backend.platform.errors import InvalidSourceError
from cert_prep_backend.source_library.domain.document import AUDIO_MEDIA_TYPES
from cert_prep_backend.source_library.infrastructure.source_preparation import (
    PreparedSource,
    prepare_source,
)


def sha256_hex(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def store_source_file(
    settings: Settings,
    project_id: str,
    sha256: str,
    content: bytes,
    *,
    canonical_suffix: str,
) -> Path:
    """Store original source bytes using a content-derived file suffix."""

    project_upload_dir = settings.data_dir / "uploads" / project_id
    project_upload_dir.mkdir(parents=True, exist_ok=True)
    path = project_upload_dir / f"{sha256}{canonical_suffix}"
    if not path.exists():
        path.write_bytes(content)
    return path


class LocalSourceFileStore:
    """Original source files under the data directory, one upload folder per project."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def resolve(self, project_id: str, storage_path: str) -> Path:
        """The stored file; it must lie in the project's folder and be within the upload limit."""

        expected_root = (self._settings.data_dir / "uploads" / project_id).resolve()
        try:
            source_path = Path(storage_path).resolve(strict=True)
            source_path.relative_to(expected_root)
            stat = source_path.stat()
        except (OSError, ValueError) as exc:
            raise InvalidSourceError("The stored source file is unavailable.") from exc
        source_limit = (
            self._settings.max_audio_upload_bytes
            if source_path.suffix.lower() in AUDIO_MEDIA_TYPES
            else self._settings.max_upload_bytes
        )
        if not source_path.is_file() or stat.st_size <= 0 or stat.st_size > source_limit:
            raise InvalidSourceError("The stored source file is unavailable.")
        return source_path

    def prepare(
        self,
        content: bytes,
        *,
        max_pdf_pages: int,
        max_image_pixels: int,
        filename: str | None,
    ) -> PreparedSource:
        """Validate an upload envelope before capture review stores it."""

        return prepare_source(
            content,
            max_pdf_pages=max_pdf_pages,
            max_image_pixels=max_image_pixels,
            filename=filename,
        )

    def store(
        self,
        *,
        project_id: str,
        sha256: str,
        content: bytes,
        canonical_suffix: str,
    ) -> str:
        """Store original bytes and return the path capture review records on the document."""

        return str(
            store_source_file(
                self._settings,
                project_id,
                sha256,
                content,
                canonical_suffix=canonical_suffix,
            )
        )

    def sha256(self, source_path: Path) -> str:
        digest = hashlib.sha256()
        try:
            with source_path.open("rb") as source:
                while chunk := source.read(1024 * 1024):
                    digest.update(chunk)
        except OSError as exc:
            raise InvalidSourceError("The stored source file is unavailable.") from exc
        return digest.hexdigest()

    def read_bytes(self, storage_path: str) -> bytes:
        """The stored upload. Missing files raise the same OSError as a direct read."""

        return Path(storage_path).read_bytes()

    def byte_size(self, storage_path: str) -> int:
        """The stored upload's size. Missing files raise the same OSError as a direct stat."""

        return Path(storage_path).stat().st_size

    def verified_path(self, project_id: str, storage_path: str, expected_sha256: str) -> Path:
        source_path = self.resolve(project_id, storage_path)
        if self.sha256(source_path) != expected_sha256:
            raise InvalidSourceError("The stored source file failed integrity verification.")
        return source_path

    def verified_content(self, project_id: str, storage_path: str, expected_sha256: str) -> bytes:
        content = self.resolve(project_id, storage_path).read_bytes()
        if sha256_hex(content) != expected_sha256:
            raise InvalidSourceError("The stored source file failed integrity verification.")
        return content
