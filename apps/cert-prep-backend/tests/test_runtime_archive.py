from __future__ import annotations

import hashlib
from pathlib import Path
import stat
from urllib.error import HTTPError, URLError
from zipfile import ZipFile, ZipInfo

import pytest

from cert_prep_backend.api.errors import ProviderUnavailableError
from cert_prep_backend.domains.runtime_installations import archive as runtime_archive
from cert_prep_backend.domains.runtime_installations.manifest import (
    parse_ocr_runtime_manifest,
)
from cert_prep_backend.domains.runtime_installations.models import OcrRuntimeManifest
from cert_prep_contracts.runtime import RuntimeRequirementKind


def test_runtime_download_resumes_with_a_valid_range_response(
    tmp_path: Path,
    monkeypatch,
) -> None:
    content = b"verified-runtime"
    file_name = "resume-runtime.zip"
    download_dir = tmp_path / "cert-prep-runtime-downloads"
    download_dir.mkdir()
    partial = download_dir / f"{file_name}.part"
    partial.write_bytes(content[:8])
    requests = []

    def fake_urlopen(request, *, timeout):
        requests.append((request, timeout))
        return FakeResponse(
            content[8:],
            status=206,
            headers={"Content-Range": f"bytes 8-{len(content) - 1}/{len(content)}"},
        )

    monkeypatch.setattr(runtime_archive, "gettempdir", lambda: str(tmp_path))
    monkeypatch.setattr(runtime_archive, "urlopen", fake_urlopen)

    artifact = runtime_archive.resolve_ocr_runtime_artifact(
        manifest(file_name, content),
    )

    assert artifact.read_bytes() == content
    assert requests[0][0].get_header("Range") == "bytes=8-"
    assert requests[0][1] == runtime_archive.CONNECT_TIMEOUT_SECONDS
    assert not partial.exists()


def test_runtime_download_restarts_when_server_ignores_range(
    tmp_path: Path,
    monkeypatch,
) -> None:
    content = b"authoritative-full-runtime"
    file_name = "range-ignored-runtime.zip"
    download_dir = tmp_path / "cert-prep-runtime-downloads"
    download_dir.mkdir()
    partial = download_dir / f"{file_name}.part"
    partial.write_bytes(b"stale-prefix")
    requests = []

    def fake_urlopen(request, *, timeout):
        requests.append((request, timeout))
        return FakeResponse(content, status=200)

    monkeypatch.setattr(runtime_archive, "gettempdir", lambda: str(tmp_path))
    monkeypatch.setattr(runtime_archive, "urlopen", fake_urlopen)

    artifact = runtime_archive.resolve_ocr_runtime_artifact(
        manifest(file_name, content),
    )

    assert requests[0][0].get_header("Range") == "bytes=12-"
    assert artifact.read_bytes() == content
    assert not partial.exists()


def test_runtime_download_accepts_complete_partial_after_416(
    tmp_path: Path,
    monkeypatch,
) -> None:
    content = b"already-complete-runtime"
    file_name = "range-complete-runtime.zip"
    download_dir = tmp_path / "cert-prep-runtime-downloads"
    download_dir.mkdir()
    partial = download_dir / f"{file_name}.part"
    partial.write_bytes(content)
    attempts = 0

    def fake_urlopen(request, *, timeout):
        nonlocal attempts
        attempts += 1
        raise HTTPError(request.full_url, 416, "Range Not Satisfiable", {}, None)

    monkeypatch.setattr(runtime_archive, "gettempdir", lambda: str(tmp_path))
    monkeypatch.setattr(runtime_archive, "urlopen", fake_urlopen)

    artifact = runtime_archive.resolve_ocr_runtime_artifact(
        manifest(file_name, content),
    )

    assert attempts == 1
    assert artifact.read_bytes() == content
    assert not partial.exists()


def test_runtime_download_preserves_partial_after_network_exhaustion(
    tmp_path: Path,
    monkeypatch,
) -> None:
    file_name = "network-runtime.zip"
    download_dir = tmp_path / "cert-prep-runtime-downloads"
    download_dir.mkdir()
    partial = download_dir / f"{file_name}.part"
    partial.write_bytes(b"partial")
    monkeypatch.setattr(runtime_archive, "gettempdir", lambda: str(tmp_path))
    monkeypatch.setattr(
        runtime_archive,
        "urlopen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(URLError("offline")),
    )
    monkeypatch.setattr(runtime_archive.time, "sleep", lambda _seconds: None)

    with pytest.raises(ProviderUnavailableError, match="after 5 attempts"):
        runtime_archive.resolve_ocr_runtime_artifact(
            manifest(file_name, b"partial-and-more"),
        )

    assert partial.read_bytes() == b"partial"


def test_runtime_download_cancellation_removes_partial(
    tmp_path: Path,
    monkeypatch,
) -> None:
    content = b"cancel-runtime"
    file_name = "cancel-runtime.zip"
    monkeypatch.setattr(runtime_archive, "gettempdir", lambda: str(tmp_path))
    monkeypatch.setattr(
        runtime_archive,
        "urlopen",
        lambda *_args, **_kwargs: FakeResponse(content, status=200),
    )

    with pytest.raises(CancelRequested):
        runtime_archive.resolve_ocr_runtime_artifact(
            manifest(file_name, content),
            on_progress=lambda _completed: (_ for _ in ()).throw(CancelRequested()),
        )

    partial = tmp_path / "cert-prep-runtime-downloads" / f"{file_name}.part"
    assert not partial.exists()


def test_local_runtime_file_url_requires_explicit_dev_opt_in(
    tmp_path: Path,
    monkeypatch,
) -> None:
    artifact = tmp_path / "dist" / "dev-runtime.zip"
    artifact.parent.mkdir()
    artifact.write_bytes(b"dev-runtime")
    manifest_path = tmp_path / "resources" / "windowsml-ocr-runtime-manifest.json"
    manifest_path.parent.mkdir()
    payload = {
        "kind": "windowsml_ocr",
        "version": "0.1.0-alpha.1",
        "target": "x86_64-pc-windows-msvc",
        "entrypoint": "ocr.exe",
        "artifact": {
            "file_name": artifact.name,
            "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
            "bytes": artifact.stat().st_size,
            "url": artifact.as_uri(),
        },
    }

    with pytest.raises(ProviderUnavailableError, match="local files require"):
        parse_ocr_runtime_manifest(payload, manifest_path)

    monkeypatch.setenv(runtime_archive.ALLOW_LOCAL_OCR_RUNTIME_URL_ENV, "true")
    parsed = parse_ocr_runtime_manifest(payload, manifest_path)

    assert runtime_archive.resolve_ocr_runtime_artifact(parsed) == artifact.resolve()


@pytest.mark.parametrize(
    "entrypoint",
    [
        "../outside.exe",
        "/outside.exe",
        r"C:\outside.exe",
        r"\\server\share\outside.exe",
        "bin/runtime.exe:payload",
    ],
)
def test_runtime_manifest_rejects_unsafe_entrypoint(
    tmp_path: Path,
    entrypoint: str,
) -> None:
    payload = {
        "kind": "windowsml_ocr",
        "version": "0.1.0-alpha.1",
        "target": "x86_64-pc-windows-msvc",
        "entrypoint": entrypoint,
        "artifact": {
            "file_name": "runtime.zip",
            "sha256": "0" * 64,
            "bytes": 1,
            "url": (
                "https://github.com/example/cert-prep/releases/download/"
                "cert-prep-v0.1.0-alpha.1/runtime.zip"
            ),
        },
    }

    with pytest.raises(ProviderUnavailableError, match="safe relative path"):
        parse_ocr_runtime_manifest(payload, tmp_path / "manifest.json")


@pytest.mark.parametrize(
    "member_name",
    ["../escape.txt", r"..\escape.txt", "/root.txt", "bin/runtime.exe:payload"],
)
def test_runtime_zip_rejects_traversal_and_absolute_members(
    tmp_path: Path,
    member_name: str,
) -> None:
    artifact = tmp_path / "unsafe.zip"
    with ZipFile(artifact, "w") as archive:
        archive.writestr(member_name, "unsafe")

    with pytest.raises(ProviderUnavailableError, match="unsafe path"):
        runtime_archive.extract_zip_safely(artifact, tmp_path / "runtime")


def test_runtime_zip_rejects_symlink_members(tmp_path: Path) -> None:
    artifact = tmp_path / "symlink.zip"
    link = ZipInfo("runtime-link")
    link.create_system = 3
    link.external_attr = (stat.S_IFLNK | 0o777) << 16
    with ZipFile(artifact, "w") as archive:
        archive.writestr(link, "outside")

    with pytest.raises(ProviderUnavailableError, match="symlink"):
        runtime_archive.extract_zip_safely(artifact, tmp_path / "runtime")


def test_runtime_zip_rejects_case_insensitive_duplicate_paths(tmp_path: Path) -> None:
    artifact = tmp_path / "duplicate.zip"
    with ZipFile(artifact, "w") as archive:
        archive.writestr("bin/Runtime.exe", "first")
        archive.writestr("bin/runtime.exe", "second")

    with pytest.raises(ProviderUnavailableError, match="duplicate path"):
        runtime_archive.extract_zip_safely(artifact, tmp_path / "runtime")


def test_runtime_zip_enforces_entry_and_expanded_size_limits(
    tmp_path: Path,
    monkeypatch,
) -> None:
    artifact = tmp_path / "bounded.zip"
    with ZipFile(artifact, "w") as archive:
        archive.writestr("one.txt", "1")
        archive.writestr("two.txt", "22")

    monkeypatch.setattr(runtime_archive, "MAX_RUNTIME_ARCHIVE_ENTRIES", 1)
    with pytest.raises(ProviderUnavailableError, match="too many entries"):
        runtime_archive.extract_zip_safely(artifact, tmp_path / "entries")

    monkeypatch.setattr(runtime_archive, "MAX_RUNTIME_ARCHIVE_ENTRIES", 10)
    monkeypatch.setattr(runtime_archive, "MAX_EXTRACTED_RUNTIME_BYTES", 2)
    with pytest.raises(ProviderUnavailableError, match="safety limit"):
        runtime_archive.extract_zip_safely(artifact, tmp_path / "bytes")


class CancelRequested(RuntimeError):
    pass


class FakeResponse:
    def __init__(self, content: bytes, *, status: int, headers=None) -> None:
        self._content = content
        self._offset = 0
        self.status = status
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *_args) -> None:
        return None

    def getcode(self) -> int:
        return self.status

    def geturl(self) -> str:
        return "https://release-assets.githubusercontent.com/runtime.zip"

    def read(self, size: int) -> bytes:
        chunk = self._content[self._offset : self._offset + size]
        self._offset += len(chunk)
        return chunk


def manifest(file_name: str, content: bytes) -> OcrRuntimeManifest:
    return OcrRuntimeManifest(
        kind=RuntimeRequirementKind.WINDOWSML_OCR,
        version="0.1.0-alpha.1",
        target="x86_64-pc-windows-msvc",
        file_name=file_name,
        sha256=hashlib.sha256(content).hexdigest(),
        bytes=len(content),
        entrypoint="cert-prep-ocr-windowsml-runtime.exe",
        url=(
            "https://github.com/example/cert-prep/releases/download/"
            f"cert-prep-v0.1.0-alpha.1/{file_name}"
        ),
    )
