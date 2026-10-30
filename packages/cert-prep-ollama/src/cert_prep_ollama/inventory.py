"""Best-effort machine inventory collection for Ollama profile selection."""

from __future__ import annotations

from collections.abc import Iterable
import ctypes
from dataclasses import replace
import json
import os
import platform
import re
from pathlib import Path
import shutil
import subprocess
from typing import Any
from xml.etree import ElementTree

from cert_prep_contracts.hardware import (
    MachineAcceleratorSnapshot,
    MachineCpuSnapshot,
    MachineInventorySnapshot,
    MachineRamSnapshot,
    MachineStorageSnapshot,
)
from cert_prep_ollama._native_gpu_inventory import _native_gpu_accelerators


def collect_machine_inventory(
    *,
    model_storage_path: str | Path | None = None,
    timeout_seconds: float = 5.0,
) -> MachineInventorySnapshot:
    """Collect a timeout-bounded, best-effort local machine inventory."""

    warnings: list[str] = []
    storage_path = _storage_probe_path(model_storage_path)
    cpu = _cpu_snapshot(timeout_seconds)
    ram = _ram_snapshot(warnings)
    storage = _storage_snapshot(storage_path, warnings)
    accelerators = _accelerators(timeout_seconds, warnings)
    return MachineInventorySnapshot(
        platform=platform.system() or "unknown",
        platform_version=platform.version() or "",
        architecture=platform.machine() or "",
        cpu=cpu,
        ram=ram,
        storage=storage,
        accelerators=accelerators,
        warnings=tuple(dict.fromkeys(warnings)),
    )


def _cpu_snapshot(timeout_seconds: float) -> MachineCpuSnapshot:
    if os.name == "nt":
        windows_snapshot = _windows_cpu_snapshot(timeout_seconds)
        if windows_snapshot is not None:
            return windows_snapshot
    return MachineCpuSnapshot(
        architecture=platform.machine() or "",
        name=platform.processor() or None,
        logical_cores=os.cpu_count(),
    )


def _windows_cpu_snapshot(timeout_seconds: float) -> MachineCpuSnapshot | None:
    payload = _run_windows_powershell_json(
        "Get-CimInstance Win32_Processor | Select-Object -First 1 "
        "Name,NumberOfCores,NumberOfLogicalProcessors | ConvertTo-Json -Compress",
        timeout_seconds,
    )
    records = _records(payload)
    if not records:
        return None
    record = records[0]
    return MachineCpuSnapshot(
        architecture=platform.machine() or "",
        name=_string_or_none(record.get("Name")) or platform.processor() or None,
        physical_cores=_int_or_none(record.get("NumberOfCores")),
        logical_cores=(
            _int_or_none(record.get("NumberOfLogicalProcessors")) or os.cpu_count()
        ),
    )


def _ram_snapshot(warnings: list[str]) -> MachineRamSnapshot:
    if os.name == "nt":
        ram = _windows_ram_snapshot()
        if ram.total_bytes is None:
            warnings.append("Unable to collect RAM totals from Windows.")
        return ram
    ram = _posix_ram_snapshot()
    if ram.total_bytes is None:
        warnings.append("Unable to collect RAM totals from this platform.")
    return ram


def _windows_ram_snapshot() -> MachineRamSnapshot:
    class MEMORYSTATUSEX(ctypes.Structure):
        _fields_ = [
            ("dwLength", ctypes.c_ulong),
            ("dwMemoryLoad", ctypes.c_ulong),
            ("ullTotalPhys", ctypes.c_ulonglong),
            ("ullAvailPhys", ctypes.c_ulonglong),
            ("ullTotalPageFile", ctypes.c_ulonglong),
            ("ullAvailPageFile", ctypes.c_ulonglong),
            ("ullTotalVirtual", ctypes.c_ulonglong),
            ("ullAvailVirtual", ctypes.c_ulonglong),
            ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
        ]

    status = MEMORYSTATUSEX()
    status.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
    try:
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return MachineRamSnapshot()
    except Exception:
        return MachineRamSnapshot()
    return MachineRamSnapshot(
        total_bytes=int(status.ullTotalPhys),
        available_bytes=int(status.ullAvailPhys),
    )


def _posix_ram_snapshot() -> MachineRamSnapshot:
    total_bytes: int | None = None
    available_bytes = _linux_available_memory()
    try:
        pages = os.sysconf("SC_PHYS_PAGES")
        page_size = os.sysconf("SC_PAGE_SIZE")
        if isinstance(pages, int) and isinstance(page_size, int):
            total_bytes = pages * page_size
    except (AttributeError, OSError, ValueError):
        total_bytes = None
    return MachineRamSnapshot(total_bytes=total_bytes, available_bytes=available_bytes)


def _linux_available_memory() -> int | None:
    meminfo = Path("/proc/meminfo")
    if not meminfo.is_file():
        return None
    try:
        for line in meminfo.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith("MemAvailable:"):
                parts = line.split()
                if len(parts) >= 2 and parts[1].isdigit():
                    return int(parts[1]) * 1024
    except OSError:
        return None
    return None


def _storage_probe_path(model_storage_path: str | Path | None) -> Path:
    if model_storage_path is None:
        return Path.home()
    path = Path(model_storage_path).expanduser()
    if path.exists():
        return path
    for candidate in (path.parent, Path.home()):
        if candidate.exists():
            return candidate
    return Path.cwd()


def _storage_snapshot(path: Path, warnings: list[str]) -> MachineStorageSnapshot:
    try:
        usage = shutil.disk_usage(path)
    except OSError:
        warnings.append(f"Unable to collect disk usage for {path}.")
        return MachineStorageSnapshot(path=str(path), free_bytes=None, total_bytes=None)
    return MachineStorageSnapshot(
        path=str(path),
        free_bytes=int(usage.free),
        total_bytes=int(usage.total),
    )


def _accelerators(
    timeout_seconds: float,
    warnings: list[str],
) -> tuple[MachineAcceleratorSnapshot, ...]:
    sources = [_nvidia_smi_accelerators(timeout_seconds)]
    if os.name == "nt":
        sources.append(_windows_video_accelerators(timeout_seconds, warnings))
    sources.append(_native_gpu_accelerators(warnings))
    if os.name == "nt":
        sources.append(_windows_npu_accelerators(timeout_seconds, warnings))
    return _merge_accelerator_sources(sources, warnings)


def _nvidia_smi_accelerators(timeout_seconds: float) -> list[MachineAcceleratorSnapshot]:
    executable = shutil.which("nvidia-smi")
    if not executable:
        return []
    command = [
        executable,
        "--query-gpu=name,memory.total,driver_version,uuid,pci.device_id",
        "--format=csv,noheader,nounits",
    ]
    try:
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=max(timeout_seconds, 0.1),
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if completed.returncode != 0:
        return []

    accelerators: list[MachineAcceleratorSnapshot] = []
    for line in completed.stdout.splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 4 or not parts[0]:
            continue
        memory_mib = _int_or_none(parts[1])
        pci_id = _nvidia_pci_id(parts[4] if len(parts) > 4 else "")
        accelerators.append(
            MachineAcceleratorSnapshot(
                kind="gpu",
                vendor="nvidia",
                name=parts[0],
                memory_bytes=memory_mib * 1024 * 1024 if memory_mib is not None else None,
                driver_version=parts[2] or None,
                device_id=parts[3] or None,
                pci_vendor_id=pci_id[0],
                pci_device_id=pci_id[1],
            )
        )
    return accelerators


def _windows_video_accelerators(
    timeout_seconds: float,
    warnings: list[str],
) -> list[MachineAcceleratorSnapshot]:
    command = (
        "Get-CimInstance Win32_VideoController | "
        "Select-Object Name,AdapterRAM,DriverVersion,PNPDeviceID | "
        "ConvertTo-Json -Compress"
    )
    payload = _run_windows_powershell_json(command, timeout_seconds)
    if payload is None:
        warnings.append("Unable to collect Windows GPU inventory.")
        return []
    accelerators: list[MachineAcceleratorSnapshot] = []
    for item in _records(payload):
        name = _string_or_none(item.get("Name"))
        if not name:
            continue
        memory_bytes = _int_or_none(item.get("AdapterRAM"))
        pnp_id = _string_or_none(item.get("PNPDeviceID"))
        pci_id = _pnp_pci_id(pnp_id)
        accelerators.append(
            MachineAcceleratorSnapshot(
                kind="gpu",
                vendor=_vendor_from_name(name),
                name=name,
                memory_bytes=memory_bytes if memory_bytes and memory_bytes > 0 else None,
                driver_version=_string_or_none(item.get("DriverVersion")),
                device_id=pnp_id,
                pnp_device_id=pnp_id,
                pci_vendor_id=pci_id[0],
                pci_device_id=pci_id[1],
            )
        )
    return accelerators


# Regex patterns used by both the PowerShell pre-filter and the Python
# post-filter.  \b anchors prevent substring false-positives such as
# "USB Input Device" matching "IPU" or "NPU".
_NPU_NAME_RE = re.compile(r"\b(NPU|IPU)\b|Neural|AI Boost", re.IGNORECASE)
_NPU_CLASS_RE = re.compile(r"Neural", re.IGNORECASE)


def _is_npu_device(name: str, device_class: str) -> bool:
    """Return True when *name* or *device_class* looks like a known NPU /
    compute accelerator rather than a false-positive substring match."""
    return bool(_NPU_NAME_RE.search(name) or _NPU_CLASS_RE.search(device_class))


def _windows_npu_accelerators(
    timeout_seconds: float,
    warnings: list[str],
) -> list[MachineAcceleratorSnapshot]:
    roots = [
        _run_windows_pnputil_xml(device_class, timeout_seconds)
        for device_class in ("ComputeAccelerator", "Neural", "System")
    ]
    if all(root is not None for root in roots):
        return _npu_snapshots_from_pnputil(
            root for root in roots if root is not None
        )

    payload = _windows_npu_powershell_payload(timeout_seconds)
    if payload is None:
        warnings.append("Unable to collect Windows NPU inventory.")
        return []
    return _npu_snapshots_from_records(_records(payload))


def _run_windows_pnputil_xml(
    device_class: str,
    timeout_seconds: float,
) -> ElementTree.Element | None:
    try:
        completed = subprocess.run(
            [
                _resolve_windows_pnputil(),
                "/enum-devices",
                "/connected",
                "/class",
                device_class,
                "/drivers",
                "/format",
                "xml",
            ],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=max(timeout_seconds, 0.1),
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0 or not completed.stdout.strip():
        return None
    try:
        return ElementTree.fromstring(completed.stdout)
    except ElementTree.ParseError:
        return None


def _resolve_windows_pnputil() -> str:
    system_root = os.environ.get("SystemRoot") or os.environ.get("WINDIR")
    if system_root:
        candidate = Path(system_root) / "System32" / "pnputil.exe"
        if candidate.is_file():
            return str(candidate)
    return shutil.which("pnputil.exe") or "pnputil.exe"


def _npu_snapshots_from_pnputil(
    roots: Iterable[ElementTree.Element],
) -> list[MachineAcceleratorSnapshot]:
    records: list[dict[str, Any]] = []
    for root in roots:
        for device in root.findall("./Device"):
            records.append(
                {
                    "FriendlyName": device.findtext("./DeviceDescription"),
                    "Class": device.findtext("./ClassName"),
                    "InstanceId": device.get("InstanceId"),
                    "Manufacturer": device.findtext("./ManufacturerName"),
                    "DriverVersion": _pnputil_installed_driver_version(device),
                }
            )
    return _npu_snapshots_from_records(records)


def _pnputil_installed_driver_version(device: ElementTree.Element) -> str | None:
    installed_name = _string_or_none(device.findtext("./DriverName"))
    candidates = device.findall("./MatchingDrivers/DriverName")
    for candidate in candidates:
        candidate_name = _string_or_none(candidate.get("DriverName"))
        status = _string_or_none(candidate.findtext("./Status")) or ""
        if installed_name and candidate_name != installed_name:
            continue
        if not installed_name and "installed" not in status.casefold():
            continue
        value = _string_or_none(candidate.findtext("./DriverVersion"))
        versions = re.findall(r"\d+(?:\.\d+){2,}", value or "")
        if versions:
            return versions[-1]
    return None


def _windows_npu_powershell_payload(timeout_seconds: float) -> Any | None:
    # Fallback for Windows builds where PnPUtil XML output is unavailable.
    command = (
        "Get-PnpDevice -PresentOnly | "
        "Where-Object { "
        "$_.FriendlyName -match '\\b(NPU|IPU)\\b|Neural|AI Boost' -or "
        "$_.Class -match 'Neural' "
        "} | "
        "ForEach-Object { "
        "$driverVersion = (Get-PnpDeviceProperty -InstanceId $_.InstanceId "
        "-KeyName 'DEVPKEY_Device_DriverVersion' "
        "-ErrorAction SilentlyContinue).Data; "
        "[PSCustomObject]@{ "
        "FriendlyName = $_.FriendlyName; Class = $_.Class; "
        "InstanceId = $_.InstanceId; DriverVersion = $driverVersion "
        "} "
        "} | ConvertTo-Json -Compress"
    )
    return _run_windows_powershell_json(command, timeout_seconds)


def _npu_snapshots_from_records(
    records: list[dict[str, Any]],
) -> list[MachineAcceleratorSnapshot]:
    accelerators: list[MachineAcceleratorSnapshot] = []
    seen_ids: set[str] = set()
    for item in records:
        name = _string_or_none(item.get("FriendlyName"))
        if not name:
            continue
        device_class = _string_or_none(item.get("Class")) or ""
        if not _is_npu_device(name, device_class):
            continue
        device_id = _string_or_none(item.get("InstanceId"))
        dedupe_key = (device_id or f"{device_class}:{name}").casefold()
        if dedupe_key in seen_ids:
            continue
        seen_ids.add(dedupe_key)
        manufacturer = _string_or_none(item.get("Manufacturer"))
        accelerators.append(
            MachineAcceleratorSnapshot(
                kind="npu",
                vendor=_vendor_from_name(
                    " ".join(value for value in (manufacturer, name) if value)
                ),
                name=name,
                driver_version=_string_or_none(item.get("DriverVersion")),
                device_id=device_id,
            )
        )
    return accelerators


def _run_windows_powershell_json(command: str, timeout_seconds: float) -> Any | None:
    powershell = _resolve_windows_powershell()
    try:
        completed = subprocess.run(
            [powershell, "-NoProfile", "-NonInteractive", "-Command", command],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=max(timeout_seconds, 0.1),
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0:
        return None
    if not completed.stdout.strip():
        return []
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError:
        return None


def _resolve_windows_powershell() -> str:
    """Return a PowerShell executable path even when PATH is reduced."""

    for executable in ("powershell.exe", "powershell"):
        resolved = shutil.which(executable)
        if resolved:
            return resolved

    windows_dir = os.environ.get("SystemRoot") or os.environ.get("WINDIR") or r"C:\Windows"
    bundled = Path(windows_dir) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    if bundled.is_file():
        return str(bundled)
    return "powershell.exe"


def _records(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict):
        return [payload]
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    return []


def _pnp_pci_id(device_id: str | None) -> tuple[str | None, str | None]:
    match = re.search(r"VEN_([0-9a-f]{4})&DEV_([0-9a-f]{4})", device_id or "", re.IGNORECASE)
    return (match[1].lower(), match[2].lower()) if match else (None, None)


def _nvidia_pci_id(value: str) -> tuple[str | None, str | None]:
    if not re.fullmatch(r"0x[0-9a-f]{8}", value, re.IGNORECASE):
        return None, None
    # nvidia-smi packs device in the high word and vendor in the low word.
    return value[-4:].lower(), value[2:6].lower()


def _matching_gpu(left: MachineAcceleratorSnapshot, right: MachineAcceleratorSnapshot) -> bool:
    if left.kind.casefold() != "gpu" or right.kind.casefold() != "gpu":
        return False
    for attribute in ("vendor", "pci_vendor_id", "pci_device_id", "adapter_luid", "pnp_device_id"):
        left_value, right_value = getattr(left, attribute), getattr(right, attribute)
        if left_value and right_value and left_value.casefold() != right_value.casefold():
            return False
    if left.device_id and right.device_id:
        if left.device_id.casefold() == right.device_id.casefold():
            return True
        # Different IDs in the same namespace identify distinct physical devices.
        if left.device_id.startswith("GPU-") and right.device_id.startswith("GPU-"):
            return False
    same_pci = bool(
        left.pci_vendor_id and left.pci_device_id
        and left.pci_vendor_id == right.pci_vendor_id and left.pci_device_id == right.pci_device_id
    )
    def normalized(name: str) -> str:
        return re.sub(r"[^a-z0-9]", "", re.sub(r"\((?:r|tm)\)", "", name.casefold()))
    return same_pci or normalized(left.name) == normalized(right.name)


def _source_accelerator_matches(
    source: list[MachineAcceleratorSnapshot],
    merged: list[MachineAcceleratorSnapshot],
    warnings: list[str],
) -> list[tuple[MachineAcceleratorSnapshot, list[int]]]:
    matches: list[tuple[MachineAcceleratorSnapshot, list[int]]] = []
    seen: set[tuple[str, str, str]] = set()
    contenders: dict[int, list[int]] = {}
    for observation in source:
        if observation.device_id:
            key = (observation.kind.casefold(), observation.name.casefold(), observation.device_id)
            if key in seen:
                continue
            seen.add(key)
        candidates = [i for i, item in enumerate(merged) if _matching_gpu(item, observation)]
        if len(candidates) == 1:
            contenders.setdefault(candidates[0], []).append(len(matches))
        matches.append((observation, candidates))

    for index, positions in contenders.items():
        if len(positions) < 2:
            continue
        exact = [
            position for position in positions
            if any(
                (value := getattr(merged[index], attribute))
                and value.casefold() == (getattr(matches[position][0], attribute) or "").casefold()
                for attribute in ("device_id", "adapter_luid", "pnp_device_id")
            )
        ]
        if len(exact) != 1:
            identifiers = sorted(
                matches[position][0].device_id or matches[position][0].pnp_device_id
                or matches[position][0].name
                for position in positions
            )
            warnings.append(
                f"Ambiguous GPU identity for {merged[index].name}: {', '.join(identifiers)}; "
                "multiple observations match one adapter; backend identifiers left unassigned."
            )
        for position in positions:
            if len(exact) != 1 or position != exact[0]:
                matches[position] = (matches[position][0], [])
    # UUID order must not decide either the native join or the appended row order.
    return sorted(matches, key=lambda match: match[0].device_id or "")


def _merge_accelerator_sources(
    sources: Iterable[list[MachineAcceleratorSnapshot]], warnings: list[str],
) -> tuple[MachineAcceleratorSnapshot, ...]:
    """Merge sources in legacy priority order, using native classification evidence."""
    merged: list[MachineAcceleratorSnapshot] = []
    legacy_fields = ("memory_bytes", "driver_version", "device_id")
    field_priorities: list[dict[str, int]] = []
    # Native rows establish physical adapters even when two identical models make
    # backend identity ambiguous. Keep their LUIDs rather than creating extra GPUs.
    ordered = sorted(enumerate(sources), key=lambda entry: not any(
        item.classification_source == "native_dxgi" for item in entry[1]
    ))
    for source_index, source in ordered:
        # Match the whole source before mutating rows or appending observations.
        for observation, candidates in _source_accelerator_matches(source, merged, warnings):
            priority = (
                0 if observation.classification_source == "native_dxgi"
                else len(ordered) - source_index
            )
            if len(candidates) != 1:
                if candidates:
                    identifier = observation.device_id or observation.pnp_device_id or observation.name
                    warnings.append(
                        f"Ambiguous GPU identity for {observation.name}: {identifier}; "
                        "backend identifier left unassigned to avoid duplicate physical GPUs."
                    )
                    continue
                field_priorities.append({
                    field: priority for field in legacy_fields
                    if getattr(observation, field) is not None
                })
                merged.append(observation)
                continue
            index = candidates[0]
            previous = merged[index]
            native = observation if observation.classification_source == "native_dxgi" else previous
            # Preserve legacy source precedence: NVIDIA, then CIM, then native-only.
            legacy_values = {}
            for field in legacy_fields:
                value = getattr(observation, field)
                if value is not None and priority > field_priorities[index].get(field, -1):
                    legacy_values[field] = value
                    field_priorities[index][field] = priority
            merged[index] = replace(
                previous,
                vendor=previous.vendor or observation.vendor,
                **legacy_values,
                pnp_device_id=previous.pnp_device_id or observation.pnp_device_id,
                pci_vendor_id=previous.pci_vendor_id or observation.pci_vendor_id,
                pci_device_id=previous.pci_device_id or observation.pci_device_id,
                adapter_luid=previous.adapter_luid or observation.adapter_luid,
                classification=native.classification,
                classification_source=native.classification_source,
                dedicated_memory_bytes=native.dedicated_memory_bytes,
                shared_memory_bytes=native.shared_memory_bytes,
            )
    return tuple(
        replace(item, classification="unknown", classification_source="unknown")
        if item.kind.casefold() == "gpu" and item.classification_source != "native_dxgi"
        else item
        for item in merged
    )


def _vendor_from_name(name: str) -> str | None:
    normalized = name.lower()
    for vendor in ("nvidia", "amd", "intel", "qualcomm", "apple"):
        if vendor in normalized:
            return vendor
    return None


def _string_or_none(value: object) -> str | None:
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return None


def _int_or_none(value: object) -> int | None:
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


__all__ = ["collect_machine_inventory"]
