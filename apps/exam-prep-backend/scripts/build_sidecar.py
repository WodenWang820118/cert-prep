from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


BACKEND_ROOT = Path(__file__).resolve().parents[1]
SIDECAR_ENTRY = BACKEND_ROOT / "src" / "exam_prep_backend" / "sidecar.py"
DIST_DIR = BACKEND_ROOT / "dist"
BUILD_DIR = BACKEND_ROOT / "build"
EXE_PATH = DIST_DIR / "exam-prep-backend.exe"
RUNTIME_OUTPUT_DIR = DIST_DIR / "backend-runtime"
LITE_EXCLUDES = [
    "cv2",
    "modelscope",
    "paddle",
    "paddleocr",
    "paddlex",
    "pandas",
    "shapely",
    "exam_prep_backend.domains.source_documents.adapters.diagnostics",
    "exam_prep_backend.domains.source_documents.adapters.paddle",
    "exam_prep_backend.domains.source_documents.adapters.paddle_runtime",
]

COMMON_COLLECT_ALL = ["paddle", "paddleocr", "paddlex"]
COMMON_METADATA = ["paddleocr", "paddlex"]
OCR_CORE_METADATA = [
    "imagesize",
    "opencv-contrib-python",
    "pyclipper",
    "pypdfium2",
    "python-bidi",
    "shapely",
]
LANE_METADATA = {
    "cpu": "paddlepaddle",
    "gpu": "paddlepaddle-gpu",
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lane", choices=["lite", *sorted(LANE_METADATA)], default="lite")
    parser.add_argument("--target", default="x86_64-pc-windows-msvc")
    parser.add_argument("--version", default="0.1.0")
    args = parser.parse_args()

    _run(_pyinstaller_command(args.lane))
    if args.lane == "lite":
        _write_runtime_artifact(target=args.target, version=args.version)


def _pyinstaller_command(lane: str) -> list[str]:
    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--name",
        "exam-prep-backend",
        "--onefile",
        str(SIDECAR_ENTRY),
        "--distpath",
        str(DIST_DIR),
        "--workpath",
        str(BUILD_DIR),
        "--specpath",
        str(BUILD_DIR),
    ]
    for package_name in COMMON_COLLECT_ALL:
        if lane != "lite":
            command.extend(["--collect-all", package_name])
    if lane == "lite":
        for module_name in LITE_EXCLUDES:
            command.extend(["--exclude-module", module_name])
    else:
        for distribution_name in [LANE_METADATA[lane], *COMMON_METADATA, *OCR_CORE_METADATA]:
            command.extend(["--copy-metadata", distribution_name])
    return command


def _run(command: list[str]) -> None:
    subprocess.run(command, cwd=BACKEND_ROOT, check=True)


def _write_runtime_artifact(*, target: str, version: str) -> None:
    RUNTIME_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    zip_path = RUNTIME_OUTPUT_DIR / f"exam-prep-backend-runtime-{target}.zip"
    with ZipFile(zip_path, "w", compression=ZIP_DEFLATED) as archive:
        archive.write(EXE_PATH, EXE_PATH.name)
    manifest = _manifest(zip_path=zip_path, target=target, version=version)
    manifest_path = RUNTIME_OUTPUT_DIR / "backend-runtime-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote backend runtime artifact to {zip_path}")
    print(f"Wrote backend runtime manifest to {manifest_path}")


def _manifest(*, zip_path: Path, target: str, version: str) -> dict[str, object]:
    return {
        "schema_version": 1,
        "kind": "python_backend",
        "version": version,
        "target": target,
        "entrypoint": EXE_PATH.name,
        "artifact": {
            "file_name": zip_path.name,
            "sha256": _sha256(zip_path),
            "bytes": zip_path.stat().st_size,
            "url": _artifact_url(zip_path.name),
        },
    }


def _artifact_url(file_name: str) -> str | None:
    base_url = os.environ.get("EXAM_PREP_RUNTIME_ASSET_BASE_URL")
    if not base_url:
        return None
    return f"{base_url.rstrip('/')}/{file_name}"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


if __name__ == "__main__":
    main()
