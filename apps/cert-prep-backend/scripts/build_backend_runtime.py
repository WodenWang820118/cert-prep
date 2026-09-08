from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import re
import sys
import zipfile
from pathlib import Path, PurePosixPath

from runtime_build.artifacts import (
    RuntimeArtifactSpec,
    run_command,
    write_runtime_artifact,
)


BACKEND_ROOT = Path(__file__).resolve().parents[1]
BACKEND_ENTRY = (
    BACKEND_ROOT / "src" / "cert_prep_backend" / "entrypoints" / "backend_runtime.py"
)
DIST_DIR = BACKEND_ROOT / "dist"
BUILD_DIR = BACKEND_ROOT / "build"
EXE_PATH = DIST_DIR / "cert-prep-backend.exe"
RUNTIME_OUTPUT_DIR = DIST_DIR / "backend-runtime"
PROVENANCE_PATH = DIST_DIR / "capture-runtime-provenance.json"
LITE_EXCLUDES: list[str] = []

COMMON_HIDDEN_IMPORTS = [
    "cert_prep_backend.api.app",
]

COLLECT_BINARY_PACKAGES: list[str] = []

# ``capture_runtime_client`` loads its private generated schemas through
# ``importlib.resources`` at import time. PyInstaller collects the Python
# modules automatically, but package data must be declared explicitly or the
# packaged backend exits before it can expose its readiness endpoint.
COLLECT_DATA_PACKAGES: list[str] = ["capture_runtime_client"]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", default="x86_64-pc-windows-msvc")
    parser.add_argument("--version", default="0.1.0-alpha.1")
    parser.add_argument(
        "--capture-runtime-root",
        help="Exact local Capture Runtime root to bind into a candidate backend.",
    )
    parser.add_argument(
        "--capture-runtime-python-wheel",
        help="Exact Capture Runtime Python wheel to bind into a candidate backend.",
    )
    args = parser.parse_args()

    provenance_path = _prepare_provenance(
        capture_runtime_root=args.capture_runtime_root,
        capture_runtime_python_wheel=args.capture_runtime_python_wheel,
    )
    _run(_pyinstaller_command(provenance_path))
    _write_runtime_artifact(target=args.target, version=args.version)


def _pyinstaller_command(provenance_path: Path | None = None) -> list[str]:
    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--name",
        "cert-prep-backend",
        "--onefile",
        str(BACKEND_ENTRY),
        "--distpath",
        str(DIST_DIR),
        "--workpath",
        str(BUILD_DIR),
        "--specpath",
        str(BUILD_DIR),
    ]
    for module_name in COMMON_HIDDEN_IMPORTS:
        command.extend(["--hidden-import", module_name])
    for package_name in COLLECT_BINARY_PACKAGES:
        command.extend(["--collect-binaries", package_name])
    for package_name in COLLECT_DATA_PACKAGES:
        command.extend(["--collect-data", package_name])
    if provenance_path is not None:
        command.extend(
            [
                "--add-data",
                f"{provenance_path}{os.pathsep}cert_prep_backend",
            ]
        )
    for module_name in LITE_EXCLUDES:
        command.extend(["--exclude-module", module_name])
    return command


def _prepare_provenance(
    *, capture_runtime_root: str | None, capture_runtime_python_wheel: str | None
) -> Path | None:
    if bool(capture_runtime_root) != bool(capture_runtime_python_wheel):
        raise SystemExit(
            "--capture-runtime-root and --capture-runtime-python-wheel must be supplied together."
        )
    if not capture_runtime_root:
        PROVENANCE_PATH.unlink(missing_ok=True)
        return None
    candidate = _candidate_provenance(
        Path(capture_runtime_root).resolve(),
        Path(capture_runtime_python_wheel).resolve(),
    )
    DIST_DIR.mkdir(parents=True, exist_ok=True)
    PROVENANCE_PATH.write_text(
        json.dumps(candidate, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return PROVENANCE_PATH


def _candidate_provenance(runtime_root: Path, wheel_path: Path) -> dict[str, object]:
    if not runtime_root.is_dir():
        raise SystemExit(f"Capture Runtime candidate root is missing: {runtime_root}")
    wheel = _inspect_python_wheel(wheel_path)
    _assert_installed_python_candidate(wheel, wheel_path)

    manifest_path = runtime_root / "capture-runtime-manifest.json"
    manifest = _read_json_object(manifest_path, "Capture Runtime manifest")
    _require_exact(manifest, "runtimeVersion", "0.4.2", "Capture Runtime manifest")
    runtime_file = _safe_file_name(manifest.get("fileName"), "Capture Runtime fileName")
    core_path = runtime_root / runtime_file
    core_bytes = _read_hashed_file(
        core_path,
        manifest.get("bytes"),
        manifest.get("sha256"),
        "Capture Runtime executable",
    )

    catalog_path = runtime_root / "capture-engine-catalog.json"
    catalog = _read_json_object(catalog_path, "Capture Runtime engine catalog")
    _require_exact(catalog, "runtimeVersion", "0.4.2", "Capture Runtime engine catalog")
    requirements = catalog.get("requirements")
    if not isinstance(requirements, list):
        raise SystemExit("Capture Runtime engine catalog has no requirements.")
    artifacts = [
        item.get("artifacts")
        for item in requirements
        if isinstance(item, dict) and item.get("requirementId") == "windowsml-ocr"
    ]
    if len(artifacts) != 1 or not isinstance(artifacts[0], list) or len(artifacts[0]) != 1:
        raise SystemExit("Capture Runtime engine catalog has no unique WindowsML OCR worker.")
    worker = artifacts[0][0]
    if not isinstance(worker, dict):
        raise SystemExit("Capture Runtime OCR worker catalog entry is invalid.")
    worker_name = _safe_file_name(worker.get("fileName"), "OCR worker fileName")
    worker_path = runtime_root / worker_name
    worker_bytes = _read_hashed_file(
        worker_path,
        worker.get("bytes"),
        worker.get("sha256"),
        "OCR worker archive",
    )
    files_manifest_name = worker_name.removesuffix(".zip") + "-files.json"
    files_manifest_path = runtime_root / files_manifest_name
    _read_hashed_file(
        files_manifest_path,
        None,
        worker.get("filesManifestSha256"),
        "OCR worker files manifest",
    )
    files_manifest = _read_json_object(
        files_manifest_path, "OCR worker files manifest"
    )
    files = files_manifest.get("files")
    if not isinstance(files, list):
        raise SystemExit("OCR worker files manifest has no files list.")
    executable = next(
        (item for item in files if isinstance(item, dict) and item.get("path") == "capture-engine-ocr.exe"),
        None,
    )
    if not isinstance(executable, dict):
        raise SystemExit("OCR worker files manifest omitted capture-engine-ocr.exe.")
    worker_executable_sha256 = _digest(executable.get("sha256"), "OCR worker executable SHA-256")

    return {
        "schema_version": 1,
        "status": "bound",
        "runtime_version": "0.4.2",
        "runtime_core_sha256": core_bytes[1],
        "runtime_core_bytes": core_bytes[0],
        "runtime_manifest_identity_sha256": _canonical_sha256(manifest),
        "worker_archive_sha256": worker_bytes[1],
        "worker_archive_bytes": worker_bytes[0],
        "worker_executable_sha256": worker_executable_sha256,
        "contract_set_sha256": wheel["contract_set_sha256"],
        "python_wheel": wheel,
    }


def _inspect_python_wheel(path: Path) -> dict[str, object]:
    if not path.is_file() or path.stat().st_size <= 0:
        raise SystemExit(f"Capture Runtime Python wheel is missing: {path}")
    if not re.fullmatch(r"capture[_-]runtime[_-]client-0\.4\.2-.+\.whl", path.name):
        raise SystemExit("Capture Runtime Python wheel must be the 0.4.2 client package.")
    wheel_bytes = path.read_bytes()
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            if len(names) != len(set(names)):
                raise SystemExit("Capture Runtime Python wheel contains duplicate entries.")
            metadata_names = [name for name in names if name.endswith(".dist-info/METADATA")]
            if len(metadata_names) != 1:
                raise SystemExit("Capture Runtime Python wheel has no unique METADATA entry.")
            metadata = archive.read(metadata_names[0]).decode("utf-8")
            package_name = _metadata_field(metadata, "Name")
            package_version = _metadata_field(metadata, "Version")
            if package_name != "capture-runtime-client" or package_version != "0.4.2":
                raise SystemExit("Capture Runtime Python wheel package identity is invalid.")
            generated = archive.read(
                "capture_runtime_client/private/generated_models.py"
            ).decode("utf-8")
            if not re.search(r"^\s*class\s+OcrComputePreflightV2\s*\(", generated, re.MULTILINE):
                raise SystemExit("Capture Runtime Python wheel omitted OcrComputePreflightV2.")
            if not re.search(r"^\s*worker_sha256\s*:", generated, re.MULTILINE):
                raise SystemExit("Capture Runtime Python wheel omitted worker_sha256.")
            if not re.search(r"^\s*pdf_page_numbers\s*:", generated, re.MULTILINE):
                raise SystemExit("Capture Runtime Python wheel omitted pdf_page_numbers.")
            contract = archive.read("capture_runtime_client/private/assets/contract-set.json")
            contract_digest = _sha256(contract)
            declared_digest = archive.read(
                "capture_runtime_client/private/assets/contract-set.sha256"
            ).decode("utf-8").strip()
            if declared_digest != contract_digest:
                raise SystemExit("Capture Runtime Python wheel contract digest is invalid.")
    except KeyError as error:
        raise SystemExit(f"Capture Runtime Python wheel omitted {error.args[0]}.") from error
    except (OSError, UnicodeError, zipfile.BadZipFile) as error:
        raise SystemExit("Capture Runtime Python wheel is invalid.") from error

    return {
        "file_name": path.name,
        "sha256": _sha256(wheel_bytes),
        "bytes": len(wheel_bytes),
        "package_name": "capture-runtime-client",
        "package_version": "0.4.2",
        "contract_set_sha256": contract_digest,
        "generated_models": {"worker_sha256": True, "pdf_page_numbers": True},
    }


def _assert_installed_python_candidate(wheel: dict[str, object], wheel_path: Path) -> None:
    try:
        distribution = importlib.metadata.distribution("capture-runtime-client")
        installed_version = distribution.version
        import capture_runtime_client
        from importlib.resources import files

        generated = files("capture_runtime_client").joinpath(
            "private", "generated_models.py"
        ).read_text(encoding="utf-8")
        contract = files("capture_runtime_client").joinpath(
            "private", "assets", "contract-set.json"
        ).read_bytes()
    except (ImportError, OSError, UnicodeError, importlib.metadata.PackageNotFoundError) as error:
        raise SystemExit("The build environment does not contain capture-runtime-client 0.4.2.") from error
    del capture_runtime_client
    if installed_version != "0.4.2" or not re.search(
        r"^\s*worker_sha256\s*:", generated, re.MULTILINE
    ) or not re.search(r"^\s*pdf_page_numbers\s*:", generated, re.MULTILINE):
        raise SystemExit("The installed Python client is not the candidate 0.4.2 generated model.")
    if _sha256(contract) != wheel["contract_set_sha256"]:
        raise SystemExit("The installed Python client contract differs from the candidate wheel.")

    installed_files = distribution.files
    if installed_files is None:
        raise SystemExit("The installed Python client has no file inventory.")
    _assert_installed_wheel_source(distribution, installed_files, wheel_path)
    try:
        with zipfile.ZipFile(wheel_path) as archive:
            wheel_members = [
                name
                for name in archive.namelist()
                if not name.endswith("/")
            ]
            if any(
                not name
                or "\\" in name
                or PurePosixPath(name).is_absolute()
                or ".." in PurePosixPath(name).parts
                for name in wheel_members
            ):
                raise SystemExit("Capture Runtime Python wheel contains an unsafe member path.")
            installed_member_names = {
                str(member).replace("\\", "/")
                for member in installed_files
            }
            unexpected_installed_members = {
                member
                for member in installed_member_names - set(wheel_members)
                if not any(part.endswith(".dist-info") for part in PurePosixPath(member).parts)
            }
            if unexpected_installed_members or not set(wheel_members) <= installed_member_names:
                raise SystemExit(
                    "The installed Python client files do not exactly match the candidate wheel."
                )
            for member_name in wheel_members:
                # Installers rewrite RECORD with their own metadata entries;
                # every payload file and the candidate RECORD inventory are
                # still checked through the member set and byte comparison.
                if member_name.endswith(".dist-info/RECORD"):
                    continue
                installed_path = distribution.locate_file(PurePosixPath(member_name))
                if not installed_path.is_file() or installed_path.read_bytes() != archive.read(member_name):
                    raise SystemExit(
                        "The installed Python client files do not exactly match the candidate wheel."
                    )
    except (OSError, UnicodeError, zipfile.BadZipFile) as error:
        raise SystemExit("The installed Python client could not be compared with the candidate wheel.") from error


def _assert_installed_wheel_source(
    distribution: importlib.metadata.Distribution,
    installed_files: list[importlib.metadata.PackagePath] | tuple[importlib.metadata.PackagePath, ...],
    _wheel_path: Path,
) -> None:
    dist_info_member = next(
        (
            str(member).replace("\\", "/").split("/", 1)[0]
            for member in installed_files
            if str(member).replace("\\", "/").endswith(".dist-info/RECORD")
        ),
        None,
    )
    if not dist_info_member:
        raise SystemExit("The installed Python client has no distribution metadata.")
    distribution_root = Path(distribution.locate_file(PurePosixPath("")))
    if not distribution_root.is_dir() or distribution_root.is_symlink() or distribution_root.is_junction():
        raise SystemExit("The installed Python client distribution root is not a regular directory.")
    resolved_root = distribution_root.resolve()
    direct_url_path = distribution.locate_file(
        PurePosixPath(dist_info_member) / "direct_url.json"
    )
    if direct_url_path.exists():
        raise SystemExit("The installed Python client must not contain direct_url.json.")
    for member in installed_files:
        member_name = str(member).replace("\\", "/")
        installed_path = distribution.locate_file(PurePosixPath(member_name))
        if not installed_path.is_file() or installed_path.is_symlink() or installed_path.is_junction():
            raise SystemExit("The installed Python client contains a link or non-file member.")
        try:
            installed_path.resolve(strict=True).relative_to(resolved_root)
        except (OSError, ValueError) as error:
            raise SystemExit(
                "The installed Python client member resolves outside its environment."
            ) from error
        current = distribution_root
        for part in PurePosixPath(member_name).parts:
            current /= part
            if current.is_symlink() or current.is_junction():
                raise SystemExit("The installed Python client contains a sibling junction or symlink.")


def _read_json_object(path: Path, label: str) -> dict[str, object]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"{label} is invalid: {path}") from error
    if not isinstance(value, dict):
        raise SystemExit(f"{label} must be a JSON object: {path}")
    return value


def _read_hashed_file(
    path: Path, expected_bytes: object, expected_sha256: object, label: str
) -> tuple[int, str]:
    if not path.is_file():
        raise SystemExit(f"{label} is missing: {path}")
    content = path.read_bytes()
    actual_bytes = len(content)
    actual_sha256 = _sha256(content)
    if expected_bytes is not None and (
        isinstance(expected_bytes, bool)
        or not isinstance(expected_bytes, int)
        or actual_bytes != expected_bytes
    ):
        raise SystemExit(f"{label} byte count does not match its manifest.")
    if actual_sha256 != _digest(expected_sha256, f"{label} SHA-256"):
        raise SystemExit(f"{label} SHA-256 does not match its manifest.")
    return actual_bytes, actual_sha256


def _safe_file_name(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or Path(value).name != value:
        raise SystemExit(f"{label} is invalid.")
    return value


def _digest(value: object, label: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value):
        raise SystemExit(f"{label} is invalid.")
    return value


def _require_exact(value: dict[str, object], key: str, expected: object, label: str) -> None:
    if value.get(key) != expected:
        raise SystemExit(f"{label} {key} must be {expected!r}.")


def _metadata_field(metadata: str, field: str) -> str:
    match = re.search(rf"^{re.escape(field)}:\s*(.+)$", metadata, re.MULTILINE)
    if not match:
        raise SystemExit(f"Capture Runtime Python wheel metadata omitted {field}.")
    return match.group(1).strip()


def _canonical_sha256(value: object) -> str:
    canonical = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return _sha256(canonical.encode("utf-8"))


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _run(command: list[str]) -> None:
    run_command(command, cwd=BACKEND_ROOT)


def _write_runtime_artifact(*, target: str, version: str) -> None:
    zip_path = RUNTIME_OUTPUT_DIR / f"cert-prep-backend-runtime-{version}-{target}.zip"
    manifest_path = RUNTIME_OUTPUT_DIR / "backend-runtime-manifest.json"
    for stale_path in RUNTIME_OUTPUT_DIR.glob("cert-prep-backend-runtime-*.zip"):
        if stale_path != zip_path:
            stale_path.unlink()
    write_runtime_artifact(
        RuntimeArtifactSpec(
            kind="python_backend",
            version=version,
            target=target,
            entrypoint=EXE_PATH.name,
            source_path=EXE_PATH,
            archive_name=EXE_PATH.name,
            zip_path=zip_path,
            manifest_path=manifest_path,
        )
    )
    print(f"Wrote backend runtime artifact to {zip_path}")
    print(f"Wrote backend runtime manifest to {manifest_path}")


if __name__ == "__main__":
    main()
