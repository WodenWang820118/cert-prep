from __future__ import annotations

from pathlib import Path

import pytest

from cert_prep_ollama import inventory
from cert_prep_ollama.inventory import (
    _is_npu_device,
    _resolve_windows_powershell,
    _windows_cpu_snapshot,
)


# -- genuine NPU / accelerator names ------------------------------------------


@pytest.mark.parametrize(
    "name,device_class",
    [
        ("Intel(R) AI Boost", "Neural"),
        ("Intel(R) NPU", "System"),
        ("AMD IPU Device", "Neural"),
        ("Qualcomm Neural Processing Unit", "Neural"),
        ("Neural Engine", "Neural"),
        ("NPU Accelerator", "System"),
        ("IPU Compute Accelerator", "System"),
        ("AI Boost", "Neural"),
    ],
)
def test_accepts_known_npu_names(name: str, device_class: str) -> None:
    assert _is_npu_device(name, device_class) is True


# -- false-positives that the old regex accepted ------------------------------


@pytest.mark.parametrize(
    "name,device_class",
    [
        ("USB Input Device", "HIDClass"),
        ("USB Input Device", "USB"),
        ("HID-compliant input device", "HIDClass"),
        ("Intel(R) Core(TM) i7-10750H CPU", "Processor"),
        ("AMD Ryzen 7 5800X 8-Core Processor", "Processor"),
        ("Processor", "Processor"),
        ("Standard SATA AHCI Controller", "SCSIAdapter"),
        ("Generic USB Hub", "USB"),
        ("High Definition Audio Device", "MEDIA"),
        ("System CMOS/real time clock", "System"),
    ],
)
def test_rejects_false_positives(name: str, device_class: str) -> None:
    assert _is_npu_device(name, device_class) is False


# -- edge cases ---------------------------------------------------------------


def test_neural_class_without_name_match_is_accepted() -> None:
    # Class "Neural" alone is a strong enough signal.
    assert _is_npu_device("Some Unknown Device", "Neural") is True


def test_ai_boost_matches_regardless_of_class() -> None:
    assert _is_npu_device("AI Boost Engine", "System") is True


def test_case_insensitivity() -> None:
    assert _is_npu_device("intel neural compute stick", "neural") is True
    assert _is_npu_device("USB INPUT DEVICE", "HIDCLASS") is False
    assert _is_npu_device("amd ipu device", "system") is True


def test_resolves_windows_powershell_when_path_is_reduced(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    powershell = (
        tmp_path
        / "Windows"
        / "System32"
        / "WindowsPowerShell"
        / "v1.0"
        / "powershell.exe"
    )
    powershell.parent.mkdir(parents=True)
    powershell.write_text("", encoding="utf-8")

    monkeypatch.setattr(inventory.shutil, "which", lambda _name: None)
    monkeypatch.setenv("SystemRoot", str(tmp_path / "Windows"))
    monkeypatch.delenv("WINDIR", raising=False)

    assert _resolve_windows_powershell() == str(powershell)


def test_windows_cpu_snapshot_uses_marketing_name_for_hardware_policy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        inventory,
        "_run_windows_powershell_json",
        lambda _command, _timeout: {
            "Name": "AMD Ryzen AI 9 H 365 w/ Radeon 880M",
            "NumberOfCores": 10,
            "NumberOfLogicalProcessors": 20,
        },
    )

    snapshot = _windows_cpu_snapshot(1)

    assert snapshot is not None
    assert snapshot.name == "AMD Ryzen AI 9 H 365 w/ Radeon 880M"
    assert snapshot.physical_cores == 10
    assert snapshot.logical_cores == 20


def test_windows_npu_snapshot_uses_the_installed_device_driver(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    compute_accelerator_xml = inventory.ElementTree.fromstring(
        """
        <PnpUtil>
          <Device InstanceId="PCI\\VEN_1022&amp;DEV_17F0\\1">
            <DeviceDescription>NPU Compute Accelerator Device</DeviceDescription>
            <ClassName>ComputeAccelerator</ClassName>
            <ManufacturerName>AMD</ManufacturerName>
            <DriverName>oem509.inf</DriverName>
            <MatchingDrivers>
              <DriverName DriverName="oem509.inf">
                <DriverVersion>10/10/2025 32.0.203.314</DriverVersion>
                <Status>BestRanked/Installed</Status>
              </DriverName>
              <DriverName DriverName="oem23.inf">
                <DriverVersion>08/21/2024 2.1.0.0</DriverVersion>
                <Status>BestRanked/Installed/Extension</Status>
              </DriverName>
            </MatchingDrivers>
          </Device>
        </PnpUtil>
        """
    )
    empty_xml = inventory.ElementTree.fromstring("<PnpUtil />")
    monkeypatch.setattr(
        inventory,
        "_run_windows_pnputil_xml",
        lambda device_class, _timeout: (
            compute_accelerator_xml
            if device_class == "ComputeAccelerator"
            else empty_xml
        ),
    )
    warnings: list[str] = []

    snapshots = inventory._windows_npu_accelerators(1, warnings)

    assert warnings == []
    assert len(snapshots) == 1
    assert snapshots[0].vendor == "amd"
    assert snapshots[0].driver_version == "32.0.203.314"
    assert snapshots[0].device_id == "PCI\\VEN_1022&DEV_17F0\\1"
