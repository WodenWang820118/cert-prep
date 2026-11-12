from __future__ import annotations

import sys
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from build_backend_runtime import (  # noqa: E402
    _pyinstaller_command,
)


def test_pyinstaller_command_collects_capture_contract_package_data() -> None:
    command = _pyinstaller_command()

    collect_data_index = command.index("--collect-data")
    assert command[collect_data_index + 1] == "capture_runtime_client"


def test_pyinstaller_command_includes_sudachi_native_module_and_dictionary() -> None:
    command = _pyinstaller_command()
    pairs = set(zip(command, command[1:]))
    assert {
        ("--hidden-import", "sudachipy.sudachipy"),
        ("--hidden-import", "sudachidict_core"),
        ("--collect-binaries", "sudachipy"),
        ("--collect-data", "sudachipy"),
        ("--collect-data", "sudachidict_core"),
    } <= pairs
