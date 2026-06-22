from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import subprocess
from zipfile import ZIP_DEFLATED, ZipFile


@dataclass(frozen=True, slots=True)
class RuntimeArtifactSpec:
    """Identity and filesystem paths for one zipped runtime artifact."""

    kind: str
    version: str
    target: str
    entrypoint: str
    source_path: Path
    archive_name: str
    zip_path: Path
    manifest_path: Path
    extra_files: tuple[tuple[Path, str], ...] = ()


def run_command(command: list[str], *, cwd: Path) -> None:
    """Run a build subprocess with check=True in the supplied working directory."""
    subprocess.run(command, cwd=cwd, check=True)


def write_runtime_artifact(spec: RuntimeArtifactSpec) -> tuple[Path, Path]:
    """Zip the runtime executable and write its JSON manifest."""
    spec.zip_path.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(spec.zip_path, "w", compression=ZIP_DEFLATED) as archive:
        archive.write(spec.source_path, spec.archive_name)
        for source_path, archive_name in spec.extra_files:
            archive.write(source_path, archive_name)
    manifest = runtime_manifest(spec)
    spec.manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return spec.zip_path, spec.manifest_path


def runtime_manifest(spec: RuntimeArtifactSpec) -> dict[str, object]:
    """Build the stable manifest shape consumed by desktop packaging."""
    return {
        "schema_version": 1,
        "kind": spec.kind,
        "version": spec.version,
        "target": spec.target,
        "entrypoint": spec.entrypoint,
        "artifact": {
            "file_name": spec.zip_path.name,
            "sha256": sha256_file(spec.zip_path),
            "bytes": spec.zip_path.stat().st_size,
            "url": artifact_url(spec.zip_path.name),
        },
    }


def artifact_url(file_name: str) -> str | None:
    base_url = os.environ.get("EXAM_PREP_RUNTIME_ASSET_BASE_URL")
    if not base_url:
        return None
    return f"{base_url.rstrip('/')}/{file_name}"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
