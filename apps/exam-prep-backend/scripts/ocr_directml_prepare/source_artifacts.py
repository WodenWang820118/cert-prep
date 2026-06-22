from __future__ import annotations

import hashlib
from pathlib import Path
import shutil
import tarfile
import tempfile
from urllib.request import urlopen

from .model_types import DownloadFn, SourceArtifact


def ensure_source_artifact(
    artifact: SourceArtifact,
    *,
    sources_dir: Path,
    allow_download: bool,
    download_fn: DownloadFn,
) -> dict[str, object]:
    archive_path = sources_dir / artifact.filename
    if archive_path.exists() and verify_source_archive(archive_path, artifact):
        return source_artifact_report(artifact, archive_path, state="present")

    if archive_path.exists() and not allow_download:
        return source_artifact_report(
            artifact,
            archive_path,
            state="checksum_mismatch",
            blocker="source_checksum_mismatch",
        )
    if not allow_download:
        return source_artifact_report(
            artifact,
            archive_path,
            state="missing",
            blocker="source_archive_missing",
        )

    archive_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        prefix=f"{artifact.kind}-",
        suffix=".download",
        dir=archive_path.parent,
        delete=False,
    ) as temp_file:
        temp_path = Path(temp_file.name)
    try:
        download_fn(artifact.url, temp_path)
        if not verify_source_archive(temp_path, artifact):
            return source_artifact_report(
                artifact,
                temp_path,
                state="checksum_mismatch",
                blocker="source_checksum_mismatch",
            )
        temp_path.replace(archive_path)
    finally:
        if temp_path.exists():
            temp_path.unlink()

    return source_artifact_report(artifact, archive_path, state="present")


def source_artifact_report(
    artifact: SourceArtifact,
    archive_path: Path,
    *,
    state: str,
    blocker: str | None = None,
) -> dict[str, object]:
    exists = archive_path.exists()
    return {
        "kind": artifact.kind,
        "model_name": artifact.model_name,
        "url": artifact.url,
        "path": str(archive_path),
        "state": state,
        "blocker": blocker,
        "expected_sha256": artifact.sha256,
        "actual_sha256": sha256_file(archive_path) if exists else None,
        "expected_bytes": artifact.byte_size,
        "actual_bytes": archive_path.stat().st_size if exists else 0,
    }


def verify_source_archive(path: Path, artifact: SourceArtifact) -> bool:
    return (
        path.is_file()
        and path.stat().st_size == artifact.byte_size
        and sha256_file(path).lower() == artifact.sha256
    )


def download_file(url: str, target: Path) -> None:
    with urlopen(url, timeout=60) as response, target.open("wb") as output:
        shutil.copyfileobj(response, output)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def extract_source_artifact(
    artifact: SourceArtifact,
    *,
    sources_dir: Path,
) -> dict[str, object]:
    archive_path = sources_dir / artifact.filename
    extracted_dir = sources_dir / "extracted"
    model_source_dir = extracted_dir / artifact.archive_root
    if not verify_source_archive(archive_path, artifact):
        return {
            "kind": artifact.kind,
            "state": "skipped",
            "reason": "source_archive_not_verified",
            "source_dir": str(model_source_dir),
            "files": [],
        }

    extracted_dir.mkdir(parents=True, exist_ok=True)
    try:
        safe_extract_tar(
            archive_path=archive_path,
            destination=extracted_dir,
            expected_root=artifact.archive_root,
        )
    except Exception as exc:
        return {
            "kind": artifact.kind,
            "state": "failed",
            "reason": str(exc),
            "source_dir": str(model_source_dir),
            "files": [],
        }

    files = sorted(
        str(path.relative_to(model_source_dir))
        for path in model_source_dir.rglob("*")
        if path.is_file()
    )
    required = {"inference.yml", "inference.json", "inference.pdiparams"}
    missing = sorted(required - set(files))
    return {
        "kind": artifact.kind,
        "state": "ready" if not missing else "failed",
        "reason": None if not missing else "extracted_required_files_missing",
        "source_dir": str(model_source_dir),
        "files": files,
        "missing": missing,
    }


def safe_extract_tar(
    *,
    archive_path: Path,
    destination: Path,
    expected_root: str,
) -> None:
    destination_root = destination.resolve()
    with tarfile.open(archive_path, "r:*") as archive:
        members = archive.getmembers()
        for member in members:
            member_name = member.name.replace("\\", "/")
            if member_name.startswith("/") or ".." in Path(member_name).parts:
                raise ValueError(f"unsafe archive member path: {member.name}")
            if member.issym() or member.islnk():
                raise ValueError(f"refusing archive link member: {member.name}")
            if member_name != expected_root and not member_name.startswith(f"{expected_root}/"):
                raise ValueError(f"unexpected archive root: {member.name}")
            resolved = (destination / member_name).resolve()
            if destination_root not in (resolved, *resolved.parents):
                raise ValueError(f"archive member escapes destination: {member.name}")
        archive.extractall(destination, members=members, filter="data")
