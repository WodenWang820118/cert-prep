from __future__ import annotations

import sys
from importlib.metadata import PackagePath
from pathlib import Path
from types import SimpleNamespace


SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from build_backend_runtime import (  # noqa: E402
    _assert_installed_wheel_source,
    _pyinstaller_command,
)


def test_pyinstaller_command_collects_capture_contract_package_data() -> None:
    command = _pyinstaller_command()

    collect_data_index = command.index("--collect-data")
    assert command[collect_data_index + 1] == "capture_runtime_client"


def test_index_installed_candidate_without_direct_url_metadata_is_accepted(
    tmp_path: Path,
) -> None:
    site_packages = tmp_path / "site-packages"
    dist_info = site_packages / "capture_runtime_client-0.4.2.dist-info"
    package = site_packages / "capture_runtime_client"
    package.mkdir(parents=True)
    dist_info.mkdir()
    members = (
        "capture_runtime_client/__init__.py",
        "capture_runtime_client-0.4.2.dist-info/METADATA",
        "capture_runtime_client-0.4.2.dist-info/RECORD",
    )
    for member in members:
        path = site_packages.joinpath(*member.split("/"))
        path.write_bytes(b"candidate-index-install")

    def locate_file(member: object) -> Path:
        return site_packages.joinpath(*str(member).replace("\\", "/").split("/"))

    distribution = SimpleNamespace(
        files=tuple(PackagePath(member) for member in members),
        locate_file=locate_file,
    )

    _assert_installed_wheel_source(
        distribution,
        tuple(PackagePath(member) for member in members),
        tmp_path / "capture_runtime_client-0.4.2-py3-none-any.whl",
    )
