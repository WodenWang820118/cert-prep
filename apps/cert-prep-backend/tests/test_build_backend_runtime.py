from __future__ import annotations

import sys
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from build_backend_runtime import _pyinstaller_command  # noqa: E402


def test_pyinstaller_command_collects_capture_contract_package_data() -> None:
    command = _pyinstaller_command()

    collect_data_index = command.index("--collect-data")
    assert command[collect_data_index + 1] == "capture_contracts"
