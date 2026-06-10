from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
SIDECAR_ENTRY = BACKEND_ROOT / "src" / "exam_prep_backend" / "sidecar.py"
DIST_DIR = BACKEND_ROOT / "dist"
BUILD_DIR = BACKEND_ROOT / "build"
EXE_PATH = DIST_DIR / "exam-prep-backend.exe"

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
    parser.add_argument("--lane", choices=sorted(LANE_METADATA), required=True)
    args = parser.parse_args()

    _run(_pyinstaller_command(args.lane))
    _run([str(EXE_PATH), "--ocr-self-test"])


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
        command.extend(["--collect-all", package_name])
    for distribution_name in [LANE_METADATA[lane], *COMMON_METADATA, *OCR_CORE_METADATA]:
        command.extend(["--copy-metadata", distribution_name])
    return command


def _run(command: list[str]) -> None:
    subprocess.run(command, cwd=BACKEND_ROOT, check=True)


if __name__ == "__main__":
    main()
