"""Best-effort machine inventory collection for Ollama profile selection."""

from __future__ import annotations

import ctypes
import json
import os
import platform
import re
from pathlib import Path
import shutil
import subprocess
from typing import Any

from cert_prep_contracts.hardware import (
    MachineAcceleratorSnapshot,
    MachineCpuSnapshot,
    MachineInventorySnapshot,
    MachineRamSnapshot,
    MachineStorageSnapshot,
)


def collect_machine_inventory(
    *,
    model_storage_path: str | Path | None = None,
    timeout_seconds: float = 5.0,
) -> MachineInventorySnapshot:
    """Collect a timeout-bounded, best-effort local machine inventory."""

    warnings: list[str] = []
    storage_path = _storage_probe_path(model_storage_path)
    cpu = _cpu_snapshot()
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


def _cpu_snapshot() -> MachineCpuSnapshot:
    return MachineCpuSnapshot(
        architecture=platform.machine() or "",
        name=platform.processor() or None,
        logical_cores=os.cpu_count(),
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
    accelerators: list[MachineAcceleratorSnapshot] = []
    accelerators.extend(_nvidia_smi_accelerators(timeout_seconds))
    if os.name == "nt":
        accelerators.extend(_windows_video_accelerators(timeout_seconds, warnings))
        accelerators.extend(_windows_npu_accelerators(timeout_seconds, warnings))
    return _dedupe_accelerators(accelerators)


def _nvidia_smi_accelerators(timeout_seconds: float) -> list[MachineAcceleratorSnapshot]:
    executable = shutil.which("nvidia-smi")
    if not executable:
        return []
    command = [
        executable,
        "--query-gpu=name,memory.total,driver_version,uuid",
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
        accelerators.append(
            MachineAcceleratorSnapshot(
                kind="gpu",
                vendor="nvidia",
                name=parts[0],
                memory_bytes=memory_mib * 1024 * 1024 if memory_mib is not None else None,
                driver_version=parts[2] or None,
                device_id=parts[3] or None,
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
        accelerators.append(
            MachineAcceleratorSnapshot(
                kind="gpu",
                vendor=_vendor_from_name(name),
                name=name,
                memory_bytes=memory_bytes if memory_bytes and memory_bytes > 0 else None,
                driver_version=_string_or_none(item.get("DriverVersion")),
                device_id=_string_or_none(item.get("PNPDeviceID")),
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
    # NOTE: the PowerShell filter mirrors _is_npu_device so that we don't
    # pull back every PnP device; the Python-side check is a safety net.
    command = (
        "Get-PnpDevice -PresentOnly | "
        "Where-Object { "
        "$_.FriendlyName -match '\\b(NPU|IPU)\\b|Neural|AI Boost' -or "
        "$_.Class -match 'Neural' "
        "} | "
        "Select-Object FriendlyName,Class,InstanceId | ConvertTo-Json -Compress"
    )
    payload = _run_windows_powershell_json(command, timeout_seconds)
    if payload is None:
        warnings.append("Unable to collect Windows NPU inventory.")
        return []
    accelerators: list[MachineAcceleratorSnapshot] = []
    for item in _records(payload):
        name = _string_or_none(item.get("FriendlyName"))
        if not name:
            continue
        device_class = _string_or_none(item.get("Class")) or ""
        if not _is_npu_device(name, device_class):
            continue
        accelerators.append(
            MachineAcceleratorSnapshot(
                kind="npu",
                vendor=_vendor_from_name(name),
                name=name,
                device_id=_string_or_none(item.get("InstanceId")),
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


def _dedupe_accelerators(
    accelerators: list[MachineAcceleratorSnapshot],
) -> tuple[MachineAcceleratorSnapshot, ...]:
    seen: set[tuple[str, str, str | None]] = set()
    deduped: list[MachineAcceleratorSnapshot] = []
    for accelerator in accelerators:
        key = (accelerator.kind.lower(), accelerator.name.lower(), accelerator.device_id)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(accelerator)
    return tuple(deduped)


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
