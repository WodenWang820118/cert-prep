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
REPO_ROOT = BACKEND_ROOT.parents[1]
RUNTIME_ENTRY = (
    BACKEND_ROOT / "src" / "cert_prep_backend" / "entrypoints" / "ocr_runtime.py"
)
WINDOWSML_RUNTIME_ENTRY = (
    REPO_ROOT
    / "packages"
    / "cert-prep-ocr-windowsml"
    / "src"
    / "cert_prep_ocr_windowsml"
    / "runtime_cli.py"
)
DIST_DIR = BACKEND_ROOT / "dist"
BUILD_DIR = BACKEND_ROOT / "build"
OUTPUT_DIR = DIST_DIR / "ocr-runtime"
WINDOWSML_OUTPUT_DIR = DIST_DIR / "ocr-windowsml-runtime"
EXE_NAME = "cert-prep-ocr-runtime.exe"
WINDOWSML_EXE_NAME = "cert-prep-ocr-windowsml-runtime.exe"
PADDLE_EXE_PATH = DIST_DIR / EXE_NAME
WINDOWSML_EXE_PATH = DIST_DIR / WINDOWSML_EXE_NAME
PADDLE_COLLECT_ALL = ["paddle", "paddleocr", "paddlex"]
PADDLE_METADATA = [
    "imagesize",
    "opencv-contrib-python",
    "paddleocr",
    "paddlex",
    "pyclipper",
    "pypdfium2",
    "python-bidi",
    "shapely",
]
WINDOWSML_COLLECT_ALL = [
    "bidi",
    "cv2",
    "cert_prep_ocr_windowsml",
    "imagesize",
    "onnx",
    "PIL",
    "onnxruntime",
    "modelscope",
    "paddleocr",
    "paddlex",
    "pyclipper",
    "pypdfium2",
    "shapely",
]
WINDOWSML_METADATA = [
    "imagesize",
    "numpy",
    "onnx",
    "onnxruntime-windowsml",
    "opencv-contrib-python",
    "modelscope",
    "paddleocr",
    "paddlex",
    "pillow",
    "pyclipper",
    "pypdfium2",
    "python-bidi",
    "shapely",
]
WINDOWSML_EXCLUDES = [
    "_pytest",
    "cert_prep_backend.domains.runtime_installations",
    "cert_prep_backend.domains.source_documents.adapters.external_paddle",
    "cert_prep_backend.domains.source_documents.adapters.ollama",
    "cert_prep_backend.domains.source_documents.adapters.paddle",
    "cert_prep_backend.domains.source_documents.adapters.paddle_runtime",
    "cert_prep_backend.domains.source_documents.adapters.paddle_text",
    "paddle",
    "pluggy",
    "pytest",
    "shapely.conftest",
    "shapely.testing",
    "shapely.tests",
]
LANE_METADATA = {
    "cpu": "paddlepaddle",
    "gpu": "paddlepaddle-gpu",
    "windowsml": "onnxruntime-windowsml",
}
WINDOWSML_MODEL_FILES = (
    "det/inference.onnx",
    "det/inference.yml",
    "rec/inference.onnx",
    "rec/inference.yml",
    "rec/ppocr_keys_v1.txt",
    "pipeline.json",
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lane", choices=sorted(LANE_METADATA), default="gpu")
    parser.add_argument("--target", default="x86_64-pc-windows-msvc")
    parser.add_argument("--version", default="0.1.0")
    parser.add_argument(
        "--windowsml-model-dir",
        type=Path,
        default=BACKEND_ROOT / ".benchmarks" / "ocr-windowsml-models",
    )
    args = parser.parse_args()

    if args.lane == "windowsml":
        _build_windowsml_runtime(args)
        return
    _build_paddle_runtime(args)


def _build_paddle_runtime(args: argparse.Namespace) -> None:
    _run(_pyinstaller_command(args.lane))
    _run([str(PADDLE_EXE_PATH), "--ocr-self-test", "--device", "auto"])
    zip_path = OUTPUT_DIR / f"cert-prep-ocr-runtime-{args.target}.zip"
    manifest_path = OUTPUT_DIR / "ocr-runtime-manifest.json"
    write_runtime_artifact(
        RuntimeArtifactSpec(
            kind="paddle_ocr",
            version=args.version,
            target=args.target,
            entrypoint=EXE_NAME,
            source_path=PADDLE_EXE_PATH,
            archive_name=EXE_NAME,
            zip_path=zip_path,
            manifest_path=manifest_path,
        )
    )
    print(f"Wrote OCR runtime artifact to {zip_path}")
    print(f"Wrote OCR runtime manifest to {manifest_path}")


def _build_windowsml_runtime(args: argparse.Namespace) -> None:
    model_files = _windowsml_model_files(args.windowsml_model_dir)
    _run(_pyinstaller_command(args.lane))
    _run(
        [
            str(WINDOWSML_EXE_PATH),
            "--provider",
            "windowsml",
            "--model-dir",
            str(args.windowsml_model_dir),
            "--ocr-self-test",
        ]
    )
    zip_path = WINDOWSML_OUTPUT_DIR / f"cert-prep-ocr-windowsml-runtime-{args.target}.zip"
    manifest_path = WINDOWSML_OUTPUT_DIR / "windowsml-ocr-runtime-manifest.json"
    write_runtime_artifact(
        RuntimeArtifactSpec(
            kind="windowsml_ocr",
            version=args.version,
            target=args.target,
            entrypoint=WINDOWSML_EXE_NAME,
            source_path=WINDOWSML_EXE_PATH,
            archive_name=WINDOWSML_EXE_NAME,
            zip_path=zip_path,
            manifest_path=manifest_path,
            extra_files=tuple(
                (path, path.relative_to(args.windowsml_model_dir).as_posix())
                for path in model_files
            ),
        )
    )
    print(f"Wrote WindowsML OCR runtime artifact to {zip_path}")
    print(f"Wrote WindowsML OCR runtime manifest to {manifest_path}")


def _pyinstaller_command(lane: str) -> list[str]:
    exe_base_name = {
        "windowsml": "cert-prep-ocr-windowsml-runtime",
    }.get(lane, "cert-prep-ocr-runtime")
    entrypoint = {
        "windowsml": WINDOWSML_RUNTIME_ENTRY,
    }.get(lane, RUNTIME_ENTRY)
    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--name",
        exe_base_name,
        "--onefile",
        str(entrypoint),
        "--distpath",
        str(DIST_DIR),
        "--workpath",
        str(BUILD_DIR),
        "--specpath",
        str(BUILD_DIR),
    ]
    if lane == "windowsml":
        collect_all = WINDOWSML_COLLECT_ALL
        metadata = WINDOWSML_METADATA
    else:
        collect_all = PADDLE_COLLECT_ALL
        metadata = [
            LANE_METADATA[lane],
            *PADDLE_METADATA,
        ]
    for package_name in collect_all:
        command.extend(["--collect-all", package_name])
    for distribution_name in metadata:
        command.extend(["--copy-metadata", distribution_name])
    if lane == "windowsml":
        for module_name in WINDOWSML_EXCLUDES:
            command.extend(["--exclude-module", module_name])
    return command


def _windowsml_model_files(model_dir: Path) -> list[Path]:
    missing = [name for name in WINDOWSML_MODEL_FILES if not (model_dir / name).is_file()]
    if missing:
        raise SystemExit(f"Missing WindowsML OCR model files: {', '.join(missing)}")
    return [model_dir / name for name in WINDOWSML_MODEL_FILES]


def _run(command: list[str]) -> None:
    run_command(command, cwd=BACKEND_ROOT)


if __name__ == "__main__":
    main()
