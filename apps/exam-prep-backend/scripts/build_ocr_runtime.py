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
DIRECTML_RUNTIME_ENTRY = BACKEND_ROOT / "src" / "exam_prep_backend" / "ocr_directml_runtime.py"
DIST_DIR = BACKEND_ROOT / "dist"
BUILD_DIR = BACKEND_ROOT / "build"
OUTPUT_DIR = DIST_DIR / "ocr-runtime"
DIRECTML_OUTPUT_DIR = DIST_DIR / "ocr-directml-runtime"
EXE_NAME = "exam-prep-ocr-runtime.exe"
DIRECTML_EXE_NAME = "exam-prep-ocr-directml-runtime.exe"
PADDLE_EXE_PATH = DIST_DIR / EXE_NAME
DIRECTML_EXE_PATH = DIST_DIR / DIRECTML_EXE_NAME
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
DIRECTML_COLLECT_ALL = [
    "bidi",
    "cv2",
    "imagesize",
    "PIL",
    "onnxruntime",
    "modelscope",
    "paddleocr",
    "paddlex",
    "pyclipper",
    "pypdfium2",
    "shapely",
]
DIRECTML_METADATA = [
    "imagesize",
    "numpy",
    "onnxruntime-directml",
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
DIRECTML_EXCLUDES = [
    "_pytest",
    "exam_prep_backend.domains.runtime_installations",
    "exam_prep_backend.domains.source_documents.adapters.external_paddle",
    "exam_prep_backend.domains.source_documents.adapters.ollama",
    "exam_prep_backend.domains.source_documents.adapters.paddle",
    "exam_prep_backend.domains.source_documents.adapters.paddle_runtime",
    "exam_prep_backend.domains.source_documents.adapters.paddle_text",
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
    "directml": "onnxruntime-directml",
}
DIRECTML_MODEL_FILES = (
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
        "--directml-model-dir",
        type=Path,
        default=BACKEND_ROOT / ".benchmarks" / "ocr-directml-models",
    )
    args = parser.parse_args()

    if args.lane == "directml":
        _build_directml_runtime(args)
        return
    _build_paddle_runtime(args)


def _build_paddle_runtime(args: argparse.Namespace) -> None:
    _run(_pyinstaller_command(args.lane))
    _run([str(PADDLE_EXE_PATH), "--ocr-self-test", "--device", "auto"])
    zip_path = OUTPUT_DIR / f"exam-prep-ocr-runtime-{args.target}.zip"
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


def _build_directml_runtime(args: argparse.Namespace) -> None:
    model_files = _directml_model_files(args.directml_model_dir)
    _run(_pyinstaller_command(args.lane))
    _run(
        [
            str(DIRECTML_EXE_PATH),
            "--provider",
            "directml",
            "--model-dir",
            str(args.directml_model_dir),
            "--ocr-self-test",
        ]
    )
    zip_path = DIRECTML_OUTPUT_DIR / f"exam-prep-ocr-directml-runtime-{args.target}.zip"
    manifest_path = DIRECTML_OUTPUT_DIR / "directml-ocr-runtime-manifest.json"
    write_runtime_artifact(
        RuntimeArtifactSpec(
            kind="directml_ocr",
            version=args.version,
            target=args.target,
            entrypoint=DIRECTML_EXE_NAME,
            source_path=DIRECTML_EXE_PATH,
            archive_name=DIRECTML_EXE_NAME,
            zip_path=zip_path,
            manifest_path=manifest_path,
            extra_files=tuple(
                (path, path.relative_to(args.directml_model_dir).as_posix())
                for path in model_files
            ),
        )
    )
    print(f"Wrote DirectML OCR runtime artifact to {zip_path}")
    print(f"Wrote DirectML OCR runtime manifest to {manifest_path}")


def _pyinstaller_command(lane: str) -> list[str]:
    exe_base_name = {
        "directml": "exam-prep-ocr-directml-runtime",
    }.get(lane, "exam-prep-ocr-runtime")
    entrypoint = {
        "directml": DIRECTML_RUNTIME_ENTRY,
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
    if lane == "directml":
        collect_all = DIRECTML_COLLECT_ALL
        metadata = DIRECTML_METADATA
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
    if lane == "directml":
        for module_name in DIRECTML_EXCLUDES:
            command.extend(["--exclude-module", module_name])
    return command


def _directml_model_files(model_dir: Path) -> list[Path]:
    missing = [name for name in DIRECTML_MODEL_FILES if not (model_dir / name).is_file()]
    if missing:
        raise SystemExit(f"Missing DirectML OCR model files: {', '.join(missing)}")
    return [model_dir / name for name in DIRECTML_MODEL_FILES]


def _run(command: list[str]) -> None:
    run_command(command, cwd=BACKEND_ROOT)


if __name__ == "__main__":
    main()
