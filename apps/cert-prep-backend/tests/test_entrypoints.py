from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

from fastapi.testclient import TestClient

from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings


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


def test_backend_sidecar_pyinstaller_command_keeps_uvicorn_app_import() -> None:
    build_sidecar = _load_script_module("build_sidecar")

    command = build_sidecar._pyinstaller_command("lite")

    hidden_imports = [
        command[index + 1]
        for index, value in enumerate(command)
        if value == "--hidden-import"
    ]
    assert "cert_prep_backend.api.app" in hidden_imports


def test_app_lifespan_closes_closeable_ocr_provider(tmp_path: Path) -> None:
    ocr_provider = CloseableOcrProvider()
    llm_provider = CloseableLlmProvider()

    with TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            llm_provider=llm_provider,
            ocr_provider=ocr_provider,
            streaming_draft_generation_async_jobs=False,
        )
    ) as client:
        assert client.get("/health").status_code == 200

    assert llm_provider.close_calls == 1
    assert ocr_provider.close_calls == 1


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


class CloseableOcrProvider:
    page_workers = 1

    def __init__(self) -> None:
        self.close_calls = 0

    def close(self) -> None:
        self.close_calls += 1


class CloseableLlmProvider:
    provider = "test-llm"
    model = "test-model"

    def __init__(self) -> None:
        self.close_calls = 0

    def close(self) -> None:
        self.close_calls += 1
