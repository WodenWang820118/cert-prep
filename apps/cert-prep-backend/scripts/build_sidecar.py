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
SIDECAR_ENTRY = (
    BACKEND_ROOT / "src" / "cert_prep_backend" / "entrypoints" / "sidecar.py"
)
DIST_DIR = BACKEND_ROOT / "dist"
BUILD_DIR = BACKEND_ROOT / "build"
EXE_PATH = DIST_DIR / "cert-prep-backend.exe"
RUNTIME_OUTPUT_DIR = DIST_DIR / "backend-runtime"
LITE_EXCLUDES = [
    "cv2",
    "modelscope",
    "paddle",
    "paddleocr",
    "paddlex",
    "pandas",
    "shapely",
    "cert_prep_backend.domains.source_documents.adapters.diagnostics",
    "cert_prep_backend.domains.source_documents.adapters.paddle",
    "cert_prep_backend.domains.source_documents.adapters.paddle_runtime",
]

COMMON_COLLECT_ALL = ["paddle", "paddleocr", "paddlex"]
COMMON_METADATA = ["paddleocr", "paddlex"]
COMMON_HIDDEN_IMPORTS = [
    "cert_prep_backend.api.app",
]
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
        "cert-prep-backend",
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
    for module_name in COMMON_HIDDEN_IMPORTS:
        command.extend(["--hidden-import", module_name])
    if lane == "lite":
        for module_name in LITE_EXCLUDES:
            command.extend(["--exclude-module", module_name])
    else:
        for distribution_name in [LANE_METADATA[lane], *COMMON_METADATA, *OCR_CORE_METADATA]:
            command.extend(["--copy-metadata", distribution_name])
    return command


def _run(command: list[str]) -> None:
    run_command(command, cwd=BACKEND_ROOT)


def _write_runtime_artifact(*, target: str, version: str) -> None:
    zip_path = RUNTIME_OUTPUT_DIR / f"cert-prep-backend-runtime-{target}.zip"
    manifest_path = RUNTIME_OUTPUT_DIR / "backend-runtime-manifest.json"
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
