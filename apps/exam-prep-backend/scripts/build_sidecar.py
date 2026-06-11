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
    args = parser.parse_args()

    _run(_pyinstaller_command(args.lane))


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


if __name__ == "__main__":
    main()
