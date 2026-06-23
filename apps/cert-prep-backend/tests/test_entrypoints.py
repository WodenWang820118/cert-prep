from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

from cert_prep_backend.api.app import create_app


BACKEND_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = BACKEND_ROOT / "scripts"


def test_app_factory_import_path_is_available() -> None:
    assert callable(create_app)


def test_pyinstaller_entry_paths_exist() -> None:
    build_sidecar = _load_script_module("build_sidecar")
    build_ocr_runtime = _load_script_module("build_ocr_runtime")

    assert build_sidecar.SIDECAR_ENTRY.is_file()
    assert build_sidecar.SIDECAR_ENTRY == (
        BACKEND_ROOT / "src" / "cert_prep_backend" / "entrypoints" / "sidecar.py"
    )
    assert build_ocr_runtime.RUNTIME_ENTRY.is_file()
    assert build_ocr_runtime.RUNTIME_ENTRY == (
        BACKEND_ROOT / "src" / "cert_prep_backend" / "entrypoints" / "ocr_runtime.py"
    )


def _load_script_module(name: str) -> ModuleType:
    script_path = SCRIPTS_DIR / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, script_path)
    assert spec is not None
    assert spec.loader is not None

    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(SCRIPTS_DIR))
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(str(SCRIPTS_DIR))
    return module
