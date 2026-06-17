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
RUNTIME_ENTRY = BACKEND_ROOT / "src" / "exam_prep_backend" / "ocr_runtime.py"
DIST_DIR = BACKEND_ROOT / "dist"
BUILD_DIR = BACKEND_ROOT / "build"
OUTPUT_DIR = DIST_DIR / "ocr-runtime"
EXE_NAME = "exam-prep-ocr-runtime.exe"
EXE_PATH = DIST_DIR / EXE_NAME
COMMON_COLLECT_ALL = ["paddle", "paddleocr", "paddlex"]
COMMON_METADATA = [
    "imagesize",
    "opencv-contrib-python",
    "paddleocr",
    "paddlex",
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
    parser.add_argument("--lane", choices=sorted(LANE_METADATA), default="gpu")
    parser.add_argument("--target", default="x86_64-pc-windows-msvc")
    parser.add_argument("--version", default="0.1.0")
    args = parser.parse_args()

    _run(_pyinstaller_command(args.lane))
    _run([str(EXE_PATH), "--ocr-self-test", "--device", "auto"])
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    zip_path = OUTPUT_DIR / f"exam-prep-ocr-runtime-{args.target}.zip"
    with ZipFile(zip_path, "w", compression=ZIP_DEFLATED) as archive:
        archive.write(EXE_PATH, EXE_NAME)
    manifest = _manifest(
        zip_path=zip_path,
        version=args.version,
        target=args.target,
    )
    manifest_path = OUTPUT_DIR / "ocr-runtime-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote OCR runtime artifact to {zip_path}")
    print(f"Wrote OCR runtime manifest to {manifest_path}")


def _pyinstaller_command(lane: str) -> list[str]:
    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--name",
        "exam-prep-ocr-runtime",
        "--onefile",
        str(RUNTIME_ENTRY),
        "--distpath",
        str(DIST_DIR),
        "--workpath",
        str(BUILD_DIR),
        "--specpath",
        str(BUILD_DIR),
    ]
    for package_name in COMMON_COLLECT_ALL:
        command.extend(["--collect-all", package_name])
    for distribution_name in [LANE_METADATA[lane], *COMMON_METADATA]:
        command.extend(["--copy-metadata", distribution_name])
    return command


def _manifest(*, zip_path: Path, version: str, target: str) -> dict[str, object]:
    return {
        "schema_version": 1,
        "kind": "paddle_ocr",
        "version": version,
        "target": target,
        "entrypoint": EXE_NAME,
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


def _run(command: list[str]) -> None:
    subprocess.run(command, cwd=BACKEND_ROOT, check=True)


if __name__ == "__main__":
    main()
