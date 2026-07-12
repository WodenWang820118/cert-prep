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
BACKEND_ENTRY = (
    BACKEND_ROOT / "src" / "cert_prep_backend" / "entrypoints" / "backend_runtime.py"
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

COMMON_HIDDEN_IMPORTS = [
    "cert_prep_backend.api.app",
]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", default="x86_64-pc-windows-msvc")
    parser.add_argument("--version", default="0.1.0-alpha.1")
    args = parser.parse_args()

    _run(_pyinstaller_command())
    _write_runtime_artifact(target=args.target, version=args.version)


def _pyinstaller_command() -> list[str]:
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
    for module_name in LITE_EXCLUDES:
        command.extend(["--exclude-module", module_name])
    return command


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
