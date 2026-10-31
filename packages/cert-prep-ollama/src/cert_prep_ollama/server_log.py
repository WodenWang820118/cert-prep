"""Ollama server log parsing for device discovery, scheduler, and runtime verification."""

from __future__ import annotations

from collections import deque
from collections.abc import Sequence
from dataclasses import dataclass
import re
from threading import Lock


@dataclass(frozen=True, slots=True)
class DiscoveredDevice:
    """Device discovered by Ollama's inference compute enumeration."""

    library: str
    id: str
    filter_id: str | None
    name: str
    description: str
    pci_id: str | None
    type: str
    total: int | None
    available: int | None
    libdirs: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class DroppedDevice:
    """Integrated GPU dropped by Ollama unless OLLAMA_IGPU_ENABLE=1 is set."""

    id: str
    library: str
    compute: str | None = None
    name: str | None = None
    description: str | None = None
    pci_id: str | None = None
    reason: str | None = None


@dataclass(frozen=True, slots=True)
class VisibleDevicesOverride:
    """Record of a visible-devices environment variable override seen by Ollama."""

    variable: str | None = None
    value: str | None = None
    raw: str | None = None


@dataclass(frozen=True, slots=True)
class SchedulerSelection:
    """Device selected by Ollama's scheduler for a model execution."""

    library: str
    name: str
    description: str
    integrated: bool
    id: str
    filter_id: str


@dataclass(frozen=True, slots=True)
class ModelLoadStarted:
    """Boundary marker for a model load invocation."""

    trigger: str = ""


@dataclass(frozen=True, slots=True)
class RunnerDevice:
    """Actual device initialized by llama-server for model execution."""

    device_name: str
    description: str
    pci_bus: str | None


@dataclass(frozen=True, slots=True)
class BackendLoaded:
    """Backend dynamic library loaded by llama-server (directory token only, never path)."""

    library: str
    token: str


@dataclass(frozen=True, slots=True)
class LayerOffload:
    """Model layer offloading counts reported by llama-server."""

    offloaded_layers: int
    total_layers: int


@dataclass(frozen=True, slots=True)
class RunnerStarted:
    """Model runner readiness and startup duration."""

    duration_seconds: float


LogRecord = (
    DiscoveredDevice
    | DroppedDevice
    | VisibleDevicesOverride
    | SchedulerSelection
    | ModelLoadStarted
    | RunnerDevice
    | BackendLoaded
    | LayerOffload
    | RunnerStarted
)

MAX_LINE_LENGTH = 8192
MAX_RECORD_HISTORY = 512

_LOGFMT_PATTERN = re.compile(r'([a-zA-Z0-9_]+)=(?:"((?:\\.|[^"\\])*)"|([^\s]*))')
_RUNNER_DEVICE_PATTERN = re.compile(
    r"llama_prepare_model_devices:\s+using device\s+([^\s]+)\s+\((.*?)\)\s+\((.*?)\)"
)
_BACKEND_LOADED_PATTERN = re.compile(
    r"load_backend:\s+loaded\s+(\w+)\s+backend from\s+(.*)"
)
_LAYER_OFFLOAD_PATTERN = re.compile(
    r"load_tensors:\s+offloaded\s+(\d+)/(\d+)\s+layers to GPU"
)
_RUNNER_STARTED_PATTERN = re.compile(
    r"llama-server started in\s+([\d.]+)\s+seconds"
)


def parse_bytes(val: str | None) -> int | None:
    """Parse a size with unit (e.g. '12.2 GiB', '0 B') into bytes."""
    if not val:
        return None
    val_clean = val.strip().strip('"')
    if not val_clean:
        return None
    match = re.match(r"^([\d.]+)\s*([A-Za-z]+)?$", val_clean)
    if not match:
        return None
    number = float(match.group(1))
    unit = (match.group(2) or "B").upper()
    multipliers = {
        "B": 1,
        "KIB": 1024,
        "KB": 1000,
        "MIB": 1024**2,
        "MB": 1000**2,
        "GIB": 1024**3,
        "GB": 1000**3,
        "TIB": 1024**4,
        "TB": 1000**4,
    }
    return int(number * multipliers.get(unit, 1))


def _parse_logfmt_fields(line: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for match in _LOGFMT_PATTERN.finditer(line):
        key = match.group(1)
        if match.group(2) is not None:
            val = match.group(2).replace(r'\"', '"').replace(r"\\", "\\")
        else:
            val = match.group(3) or ""
        fields[key] = val
    return fields


def _extract_lib_token(raw_path: str) -> str:
    parts = [p for p in re.split(r"[\\/]", raw_path.strip()) if p]
    if len(parts) >= 2:
        return parts[-2]
    return parts[0] if parts else "unknown"


def parse_log_line(line: str) -> LogRecord | None:
    """Parse one raw line of Ollama server logs into a structured record."""
    if len(line) > MAX_LINE_LENGTH:
        return None

    # 1. llama_prepare_model_devices: using device ...
    if "llama_prepare_model_devices: using device" in line:
        match = _RUNNER_DEVICE_PATTERN.search(line)
        if match:
            dev_name = match.group(1).strip()
            desc = match.group(2).strip()
            bus_raw = match.group(3).strip()
            pci_bus = None if bus_raw.lower() == "unknown id" else bus_raw
            return RunnerDevice(device_name=dev_name, description=desc, pci_bus=pci_bus)

    # 2. load_backend: loaded ... backend from ...
    if "load_backend: loaded" in line:
        match = _BACKEND_LOADED_PATTERN.search(line)
        if match:
            lib = match.group(1).strip()
            token = _extract_lib_token(match.group(2))
            return BackendLoaded(library=lib, token=token)

    # 3. load_tensors: offloaded ... layers to GPU
    if "load_tensors: offloaded" in line:
        match = _LAYER_OFFLOAD_PATTERN.search(line)
        if match:
            return LayerOffload(
                offloaded_layers=int(match.group(1)),
                total_layers=int(match.group(2)),
            )

    # 4. llama-server started in ... seconds
    if "llama-server started in" in line:
        match = _RUNNER_STARTED_PATTERN.search(line)
        if match:
            return RunnerStarted(duration_seconds=float(match.group(1)))

    # 5. Logfmt structured lines
    if "msg=" in line:
        fields = _parse_logfmt_fields(line)
        msg = fields.get("msg", "")

        # inference compute
        if msg == "inference compute":
            libdirs_str = fields.get("libdirs", "")
            libdirs = tuple(
                d.strip() for d in libdirs_str.split(",") if d.strip()
            )
            pci_id = fields.get("pci_id") or None
            return DiscoveredDevice(
                library=fields.get("library", ""),
                id=fields.get("id", ""),
                filter_id=fields.get("filter_id"),
                name=fields.get("name", ""),
                description=fields.get("description", ""),
                pci_id=pci_id,
                type=fields.get("type", ""),
                total=parse_bytes(fields.get("total")),
                available=parse_bytes(fields.get("available")),
                libdirs=libdirs,
            )

        # dropping integrated GPU
        if msg.startswith("dropping integrated GPU"):
            return DroppedDevice(
                id=fields.get("id", ""),
                library=fields.get("library", ""),
                compute=fields.get("compute"),
                name=fields.get("name"),
                description=fields.get("description"),
                pci_id=fields.get("pci_id") or None,
                reason=msg,
            )

        # user overrode visible devices
        if msg == "user overrode visible devices":
            var_name: str | None = None
            var_val: str | None = None
            for key, val in fields.items():
                if key != "msg" and (
                    key.endswith("_VISIBLE_DEVICES") or "VISIBLE_DEVICES" in key
                ):
                    var_name = key
                    var_val = val
                    break
            raw = f"{var_name}={var_val}" if var_name is not None else None
            return VisibleDevicesOverride(
                variable=var_name,
                value=var_val,
                raw=raw,
            )

        # selecting single GPU for llama-server model
        if msg == "selecting single GPU for llama-server model":
            return SchedulerSelection(
                library=fields.get("library", ""),
                name=fields.get("name", ""),
                description=fields.get("description", ""),
                integrated=fields.get("integrated", "").lower() == "true",
                id=fields.get("id", ""),
                filter_id=fields.get("filter_id", ""),
            )

        # Model load boundary triggers
        if msg in ("starting llama-server", "using llama-server for model"):
            return ModelLoadStarted(trigger=msg)

    return None


class OllamaLogParser:
    """Thread-safe stream parser for Ollama server logs."""

    def __init__(self, maxlen: int = MAX_RECORD_HISTORY) -> None:
        self._lock = Lock()
        self._records: deque[LogRecord] = deque(maxlen=maxlen)
        self._buffer: str = ""
        self._discarding_overlong: bool = False

    def feed(self, text_chunk: str) -> Sequence[LogRecord]:
        """Feed a chunk of stdout/stderr log text and return newly parsed records."""
        new_records: list[LogRecord] = []
        with self._lock:
            self._buffer += text_chunk

            if self._discarding_overlong:
                if "\n" in self._buffer:
                    _, self._buffer = self._buffer.split("\n", 1)
                    self._discarding_overlong = False
                else:
                    self._buffer = ""

            while "\n" in self._buffer:
                line, self._buffer = self._buffer.split("\n", 1)
                line = line.rstrip("\r")
                if len(line) > MAX_LINE_LENGTH:
                    continue

                record = parse_log_line(line)
                if record is not None:
                    self._records.append(record)
                    new_records.append(record)

            # Prevent un-newline'd buffer from growing past MAX_LINE_LENGTH
            if len(self._buffer) > MAX_LINE_LENGTH:
                self._buffer = ""
                self._discarding_overlong = True

        return tuple(new_records)

    def records(self) -> tuple[LogRecord, ...]:
        """Return all retained log records."""
        with self._lock:
            return tuple(self._records)

    def discovered_devices(self) -> tuple[DiscoveredDevice, ...]:
        """Return all discovered device records currently retained."""
        with self._lock:
            return tuple(
                r for r in self._records if isinstance(r, DiscoveredDevice)
            )

    def latest_load(self) -> tuple[LogRecord, ...]:
        """Return the records after the last load boundary (ModelLoadStarted)."""
        with self._lock:
            records_list = list(self._records)
            last_boundary_idx: int | None = None
            for idx in range(len(records_list) - 1, -1, -1):
                if isinstance(records_list[idx], ModelLoadStarted):
                    last_boundary_idx = idx
                    break
            if last_boundary_idx is None:
                return ()

            post_boundary = records_list[last_boundary_idx + 1:]

            # Include the nearest SchedulerSelection before the last boundary,
            # unless a RunnerDevice, LayerOffload, or RunnerStarted record lies
            # between that selection and the boundary.
            selected_before: SchedulerSelection | None = None
            for idx in range(last_boundary_idx - 1, -1, -1):
                rec = records_list[idx]
                if isinstance(rec, (RunnerDevice, LayerOffload, RunnerStarted)):
                    break
                if isinstance(rec, SchedulerSelection):
                    selected_before = rec
                    break

            if selected_before is not None:
                return (selected_before, *post_boundary)
            return tuple(post_boundary)


__all__ = [
    "BackendLoaded",
    "DiscoveredDevice",
    "DroppedDevice",
    "LayerOffload",
    "LogRecord",
    "ModelLoadStarted",
    "OllamaLogParser",
    "RunnerDevice",
    "RunnerStarted",
    "SchedulerSelection",
    "VisibleDevicesOverride",
    "parse_bytes",
    "parse_log_line",
]
