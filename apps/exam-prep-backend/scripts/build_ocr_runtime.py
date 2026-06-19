from __future__ import annotations

import argparse
import sys
from pathlib import Path

from runtime_build.artifacts import (
    RuntimeArtifactSpec,
    run_command,
    write_runtime_artifact,
)


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
    zip_path = OUTPUT_DIR / f"exam-prep-ocr-runtime-{args.target}.zip"
    manifest_path = OUTPUT_DIR / "ocr-runtime-manifest.json"
    write_runtime_artifact(
        RuntimeArtifactSpec(
            kind="paddle_ocr",
            version=args.version,
            target=args.target,
            entrypoint=EXE_NAME,
            source_path=EXE_PATH,
            archive_name=EXE_NAME,
            zip_path=zip_path,
            manifest_path=manifest_path,
        )
    )
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


def _run(command: list[str]) -> None:
    run_command(command, cwd=BACKEND_ROOT)


if __name__ == "__main__":
    main()
