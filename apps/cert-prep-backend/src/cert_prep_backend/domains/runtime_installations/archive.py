from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
import os
from pathlib import Path, PurePosixPath
import re
import stat
from tempfile import gettempdir
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, url2pathname, urlopen
from zipfile import ZipFile

from cert_prep_backend.api.errors import ProviderUnavailableError
from cert_prep_backend.domains.runtime_installations.models import OcrRuntimeManifest


CONNECT_TIMEOUT_SECONDS = 15
READ_IDLE_TIMEOUT_SECONDS = 60
MAX_DOWNLOAD_ATTEMPTS = 5
RETRY_BACKOFF_SECONDS = (1, 2, 4, 8)
DOWNLOAD_CHUNK_BYTES = 1024 * 1024
MAX_RUNTIME_ARCHIVE_ENTRIES = 10_000
MAX_EXTRACTED_RUNTIME_BYTES = 1024 * 1024 * 1024
ALLOW_LOCAL_OCR_RUNTIME_URL_ENV = "CERT_PREP_ALLOW_LOCAL_OCR_RUNTIME_URL"
ALLOWED_DOWNLOAD_HOSTS = frozenset(
    {
        "github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
    }
)


class _IncompleteDownloadError(OSError):
    pass


def resolve_ocr_runtime_artifact(
    manifest: OcrRuntimeManifest,
    *,
    on_progress: Callable[[int], None] | None = None,
) -> Path:
    """Resolve only a manifest-adjacent archive or a verified HTTPS release asset."""

    if manifest.base_dir is not None:
        bundled = manifest.base_dir.resolve() / manifest.file_name
        if bundled.is_file():
            return bundled
    if not manifest.url:
        raise ProviderUnavailableError(f"OCR runtime artifact was not found: {manifest.file_name}")
    if urlparse(manifest.url).scheme.casefold() == "file":
        return _resolve_local_dev_artifact(manifest.url)
    _validate_manifest_release_url(manifest.url)

    download_dir = Path(gettempdir()) / "cert-prep-runtime-downloads"
    download_dir.mkdir(parents=True, exist_ok=True)
    target = download_dir / manifest.file_name
    partial = target.with_name(f"{target.name}.part")
    if target.is_file():
        try:
            verify_file_hash(target, manifest.sha256, expected_bytes=manifest.bytes)
            return target
        except ProviderUnavailableError:
            target.unlink(missing_ok=True)

    try:
        _download_with_resume(
            manifest.url,
            partial,
            expected_bytes=manifest.bytes,
            on_progress=on_progress,
        )
    except ProviderUnavailableError:
        # Preserve a network-interrupted .part across app restarts.
        raise
    except BaseException:
        # User cancellation must clear partial bytes.
        partial.unlink(missing_ok=True)
        raise
    try:
        verify_file_hash(partial, manifest.sha256, expected_bytes=manifest.bytes)
        os.replace(partial, target)
    except BaseException:
        # Integrity mismatches are never resumable.
        partial.unlink(missing_ok=True)
        raise
    return target


def _download_with_resume(
    url: str,
    partial: Path,
    *,
    expected_bytes: int,
    on_progress: Callable[[int], None] | None,
) -> None:
    last_error: BaseException | None = None
    for attempt in range(MAX_DOWNLOAD_ATTEMPTS):
        retry_after: float | None = None
        try:
            _download_attempt(
                url,
                partial,
                expected_bytes=expected_bytes,
                on_progress=on_progress,
            )
            return
        except HTTPError as exc:
            last_error = exc
            retry_after = _retry_after_seconds(exc.headers.get("Retry-After"))
            if exc.code == 416:
                if partial.is_file() and partial.stat().st_size == expected_bytes:
                    return
                partial.unlink(missing_ok=True)
        except (URLError, TimeoutError, OSError) as exc:
            last_error = exc
        if attempt >= MAX_DOWNLOAD_ATTEMPTS - 1:
            break
        delay = retry_after if retry_after is not None else RETRY_BACKOFF_SECONDS[attempt]
        time.sleep(max(0.0, delay))
    raise ProviderUnavailableError(
        f"OCR runtime download failed after {MAX_DOWNLOAD_ATTEMPTS} attempts: {last_error}"
    ) from last_error


def _download_attempt(
    url: str,
    partial: Path,
    *,
    expected_bytes: int,
    on_progress: Callable[[int], None] | None,
) -> None:
    offset = partial.stat().st_size if partial.is_file() else 0
    if offset > expected_bytes:
        partial.unlink(missing_ok=True)
        offset = 0
    headers = {
        "Accept": "application/octet-stream",
        "User-Agent": "cert-prep/0.1.0-alpha.1",
    }
    if offset > 0:
        headers["Range"] = f"bytes={offset}-"
    request = Request(url, headers=headers)
    with urlopen(request, timeout=CONNECT_TIMEOUT_SECONDS) as response:
        _validate_release_url(response.geturl())
        _set_read_idle_timeout(response)
        status_code = int(getattr(response, "status", response.getcode()))
        if status_code == 206:
            content_range = str(response.headers.get("Content-Range", ""))
            if not content_range.startswith(f"bytes {offset}-"):
                raise _IncompleteDownloadError(
                    "OCR runtime server returned an invalid Content-Range."
                )
            mode = "ab"
        elif status_code == 200:
            # Range was ignored; restart from the authoritative full response.
            offset = 0
            mode = "wb"
        else:
            raise _IncompleteDownloadError(f"OCR runtime server returned HTTP {status_code}.")

        completed = offset
        with partial.open(mode) as output:
            while chunk := response.read(DOWNLOAD_CHUNK_BYTES):
                output.write(chunk)
                completed += len(chunk)
                if completed > expected_bytes:
                    raise _IncompleteDownloadError(
                        "OCR runtime download exceeded the manifest byte count."
                    )
                if on_progress is not None:
                    on_progress(completed)
        if completed != expected_bytes:
            raise _IncompleteDownloadError(
                f"OCR runtime download is incomplete: {completed}/{expected_bytes} bytes."
            )


def verify_file_hash(path: Path, sha256: str, *, expected_bytes: int) -> None:
    """Verify archive size and SHA-256 before installing a runtime artifact."""

    digest = hashlib.sha256()
    total = 0
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(DOWNLOAD_CHUNK_BYTES), b""):
            total += len(chunk)
            digest.update(chunk)
    if total != expected_bytes:
        raise ProviderUnavailableError(
            f"OCR runtime artifact size mismatch: expected {expected_bytes}, found {total}."
        )
    actual = digest.hexdigest()
    if actual.casefold() != sha256.casefold():
        raise ProviderUnavailableError("OCR runtime artifact checksum mismatch.")


def extract_zip_safely(artifact: Path, destination: Path) -> None:
    """Extract regular files/directories while rejecting traversal and symlinks."""

    root = destination.resolve()
    destination.mkdir(parents=True, exist_ok=True)
    with ZipFile(artifact) as archive:
        members = archive.infolist()
        if len(members) > MAX_RUNTIME_ARCHIVE_ENTRIES:
            raise ProviderUnavailableError("OCR runtime archive has too many entries.")
        expanded_bytes = sum(member.file_size for member in members)
        if expanded_bytes > MAX_EXTRACTED_RUNTIME_BYTES:
            raise ProviderUnavailableError("OCR runtime archive expands beyond the safety limit.")
        seen_paths: set[str] = set()
        for member in members:
            normalized_name = member.filename.replace("\\", "/")
            relative = PurePosixPath(normalized_name)
            if (
                relative.is_absolute()
                or not relative.parts
                or ".." in relative.parts
                or any(":" in part for part in relative.parts)
                or _zip_member_is_symlink(member.external_attr)
            ):
                raise ProviderUnavailableError(
                    "OCR runtime artifact contains an unsafe path or symlink."
                )
            normalized_key = "/".join(relative.parts).casefold()
            if normalized_key in seen_paths:
                raise ProviderUnavailableError("OCR runtime artifact contains a duplicate path.")
            seen_paths.add(normalized_key)
            target = root.joinpath(*relative.parts).resolve()
            if not target.is_relative_to(root):
                raise ProviderUnavailableError("OCR runtime artifact contains an unsafe path.")
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(member) as source, target.open("xb") as output:
                while chunk := source.read(DOWNLOAD_CHUNK_BYTES):
                    output.write(chunk)


def _validate_release_url(url: str) -> None:
    parsed = urlparse(url)
    if (
        parsed.scheme.casefold() != "https"
        or (parsed.hostname or "").casefold() not in ALLOWED_DOWNLOAD_HOSTS
        or parsed.username
        or parsed.password
    ):
        raise ProviderUnavailableError(
            "OCR runtime URL must use an allowlisted GitHub HTTPS release host."
        )


def _resolve_local_dev_artifact(url: str) -> Path:
    parsed = urlparse(url)
    if (
        not local_file_urls_enabled()
        or parsed.scheme.casefold() != "file"
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.netloc.casefold() not in {"", "localhost"}
    ):
        raise ProviderUnavailableError(
            "Local OCR runtime URLs are allowed only in an explicit developer run."
        )
    path = Path(url2pathname(parsed.path)).resolve()
    if not path.is_file():
        raise ProviderUnavailableError(f"OCR runtime artifact was not found: {path.name}")
    return path


def local_file_urls_enabled() -> bool:
    return os.environ.get(ALLOW_LOCAL_OCR_RUNTIME_URL_ENV, "").strip().casefold() == "true"


def _validate_manifest_release_url(url: str) -> None:
    _validate_release_url(url)
    parsed = urlparse(url)
    if (
        (parsed.hostname or "").casefold() != "github.com"
        or parsed.query
        or parsed.fragment
        or re.fullmatch(
            r"/[^/]+/[^/]+/releases/download/[^/]+/[^/]+\.zip",
            parsed.path,
        )
        is None
    ):
        raise ProviderUnavailableError(
            "OCR runtime manifest URL must be a versioned GitHub Release ZIP URL."
        )


def _set_read_idle_timeout(response) -> None:
    try:
        response.fp.raw._sock.settimeout(READ_IDLE_TIMEOUT_SECONDS)  # noqa: SLF001
    except (AttributeError, OSError):
        # Some test/stdlib response wrappers do not expose the socket. The
        # connection timeout remains fail-closed in that compatibility path.
        pass


def _retry_after_seconds(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        try:
            retry_at = parsedate_to_datetime(value)
            if retry_at.tzinfo is None:
                retry_at = retry_at.replace(tzinfo=timezone.utc)
            return max(0.0, (retry_at - datetime.now(timezone.utc)).total_seconds())
        except (TypeError, ValueError, OverflowError):
            return None


def _zip_member_is_symlink(external_attr: int) -> bool:
    return stat.S_IFMT(external_attr >> 16) == stat.S_IFLNK
