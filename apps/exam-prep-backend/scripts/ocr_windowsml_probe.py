from __future__ import annotations

import argparse
from collections.abc import Sequence
from datetime import UTC, datetime
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
from typing import Any


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


BACKEND_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = BACKEND_ROOT / ".benchmarks"
DEFAULT_MODEL_DIR = BACKEND_ROOT / ".benchmarks" / "ocr-windowsml-models"
COMMAND_TIMEOUT_SECONDS = 10.0
REQUIRED_MODEL_FILES = (
    "det/inference.onnx",
    "det/inference.yml",
    "rec/inference.onnx",
    "rec/inference.yml",
    "rec/ppocr_keys_v1.txt",
    "pipeline.json",
)
OPTIONAL_MODEL_FILES = ()


def default_output_path() -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return DEFAULT_OUTPUT_DIR / f"ocr-windowsml-probe-{stamp}.json"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=default_output_path())
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    parser.add_argument(
        "--fail-if-blocked",
        action="store_true",
        help="Exit non-zero only when WindowsML itself is unavailable.",
    )
    parser.add_argument(
        "--fail-if-not-ready",
        action="store_true",
        help="Exit non-zero unless WindowsML and all required model artifacts are present.",
    )
    return parser.parse_args(argv)


def build_report(model_dir: Path = DEFAULT_MODEL_DIR) -> dict[str, Any]:
    providers_snapshot = onnxruntime_provider_snapshot()
    windows_video_controllers = windows_video_controller_snapshot()
    dxgi_adapters = dxgi_adapter_snapshot()
    artifacts = inspect_model_artifacts(model_dir)
    status = classify_windowsml_status(
        providers=providers_snapshot.get("providers", []),
        import_error=providers_snapshot.get("import_error"),
        model_artifacts=artifacts,
        windows_video_controllers=windows_video_controllers,
        dxgi_adapters=dxgi_adapters,
    )
    return {
        "schema_version": 1,
        "generated_at": datetime.now(UTC).isoformat(),
        "mode": {
            "name": "ocr_windowsml_probe",
            "goal": (
                "Verify whether ONNX Runtime WindowsML can host the AMD iGPU "
                "PaddleOCR 3.7 PP-OCRv6 runtime."
            ),
            "does_not_pull_models": True,
            "does_not_change_runtime_defaults": True,
            "does_not_run_ocr_inference": True,
        },
        "host": {
            "platform": platform.platform(),
            "python_version": platform.python_version(),
        },
        "windows_video_controllers": windows_video_controllers,
        "dxgi_adapters": dxgi_adapters,
        "onnxruntime": providers_snapshot,
        "model_contract": {
            "description": "PaddleOCR 3.7 PP-OCRv6 ONNXRuntime artifact contract.",
            "required_files": list(REQUIRED_MODEL_FILES),
            "optional_files": list(OPTIONAL_MODEL_FILES),
        },
        "model_artifacts": artifacts,
        "status": status,
    }


def onnxruntime_provider_snapshot() -> dict[str, Any]:
    try:
        import onnxruntime as ort  # type: ignore[import-not-found]
    except Exception as exc:
        return {
            "available": False,
            "import_error": str(exc),
            "providers": [],
        }

    try:
        providers = list(ort.get_available_providers())
    except Exception as exc:
        return {
            "available": True,
            "provider_error": str(exc),
            "providers": [],
        }

    return {
        "available": True,
        "version": getattr(ort, "__version__", None),
        "providers": providers,
    }


def inspect_model_artifacts(model_dir: Path) -> dict[str, Any]:
    required = [model_file_state(model_dir / name, name=name) for name in REQUIRED_MODEL_FILES]
    optional = [model_file_state(model_dir / name, name=name) for name in OPTIONAL_MODEL_FILES]
    missing_required = [
        item["name"] for item in required if item["state"] != "present"
    ]
    return {
        "model_dir": str(model_dir),
        "exists": model_dir.exists(),
        "required": required,
        "optional": optional,
        "missing_required": missing_required,
        "ready": len(missing_required) == 0,
    }


def model_file_state(path: Path, *, name: str | None = None) -> dict[str, Any]:
    display_name = name or path.name
    if not path.exists():
        return {"name": display_name, "path": str(path), "state": "missing", "bytes": 0}
    if not path.is_file():
        return {"name": display_name, "path": str(path), "state": "not_file", "bytes": 0}
    size = path.stat().st_size
    return {
        "name": display_name,
        "path": str(path),
        "state": "present" if size > 0 else "empty",
        "bytes": size,
    }


def classify_windowsml_status(
    *,
    providers: Sequence[str],
    import_error: object | None,
    model_artifacts: dict[str, Any],
    windows_video_controllers: Sequence[dict[str, Any]] = (),
    dxgi_adapters: Sequence[dict[str, Any]] = (),
) -> dict[str, Any]:
    provider_names = [str(provider) for provider in providers]
    windowsml_available = "DmlExecutionProvider" in provider_names
    amd_dxgi_adapter = select_amd_dxgi_adapter(dxgi_adapters)
    amd_adapters = [
        controller
        for controller in windows_video_controllers
        if is_amd_adapter(str(controller.get("Name") or controller.get("name") or ""))
    ]
    nvidia_adapters = [
        controller
        for controller in windows_video_controllers
        if is_nvidia_adapter(str(controller.get("Name") or controller.get("name") or ""))
    ]
    dxgi_nvidia_adapters = [
        adapter
        for adapter in dxgi_adapters
        if is_nvidia_adapter(str(adapter.get("description") or adapter.get("name") or ""))
        or str(adapter.get("adapter_kind") or "") == "nvidia_dgpu"
    ]
    amd_igpu_detected = bool(amd_adapters) or amd_dxgi_adapter is not None
    amd_dxgi_adapter_index = adapter_index(amd_dxgi_adapter)
    blockers: list[str] = []

    if import_error:
        blockers.append("onnxruntime_import_failed")
    if not windowsml_available:
        blockers.append("windowsml_provider_unavailable")
    if not amd_igpu_detected:
        blockers.append("amd_igpu_not_detected")
    if windowsml_available and amd_igpu_detected and amd_dxgi_adapter_index is None:
        blockers.append("amd_dxgi_adapter_index_unavailable")
    if not model_artifacts.get("ready", False):
        blockers.append("model_artifacts_missing")

    if not windowsml_available or not amd_igpu_detected or amd_dxgi_adapter_index is None:
        state = "blocked"
    elif model_artifacts.get("ready", False):
        state = "ready"
    else:
        state = "ready_for_model"

    return {
        "state": state,
        "windowsml_provider_available": windowsml_available,
        "amd_igpu_detected": amd_igpu_detected,
        "nvidia_dgpu_detected": bool(nvidia_adapters) or bool(dxgi_nvidia_adapters),
        "windowsml_device_id": amd_dxgi_adapter_index,
        "windowsml_device_selection": {
            "device_id": amd_dxgi_adapter_index,
            "source": "dxgi_adapter_index" if amd_dxgi_adapter_index is not None else None,
            "adapter": amd_dxgi_adapter,
        },
        "model_artifacts_ready": bool(model_artifacts.get("ready", False)),
        "blockers": blockers,
        "current_safe_action": (
            "Keep OCR on the AMD iGPU WindowsML lane only when WindowsML, AMD adapter "
            "selection, and PP-OCRv6 artifacts are all ready."
        ),
        "recommended_next_step": (
            "Run PaddleOCR 3.7 WindowsML session and inference smoke before packaged QA."
        ),
    }


def windows_video_controller_snapshot() -> list[dict[str, Any]]:
    if platform.system().lower() != "windows":
        return []
    command = (
        "Get-CimInstance Win32_VideoController | "
        "Select-Object Name,AdapterRAM,DriverVersion,PNPDeviceID | "
        "ConvertTo-Json -Depth 4"
    )
    result = _run_command(
        [
            resolve_powershell_executable(),
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            command,
        ]
    )
    if not result["available"]:
        error = result.get("error") or result.get("stderr") or result.get("stdout")
        return [{"error": error}]
    try:
        payload = json.loads(str(result["stdout"] or "").strip() or "[]")
    except json.JSONDecodeError as exc:
        return [{"error": f"video_controller_json_error:{exc}"}]
    return payload if isinstance(payload, list) else [payload]


def dxgi_adapter_snapshot() -> list[dict[str, Any]]:
    if platform.system().lower() != "windows":
        return []
    result = _run_command(
        [
            resolve_powershell_executable(),
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            dxgi_adapter_probe_script(),
        ]
    )
    if not result["available"]:
        error = result.get("error") or result.get("stderr") or result.get("stdout")
        return [{"error": error}]
    try:
        payload = json.loads(str(result["stdout"] or "").strip() or "[]")
    except json.JSONDecodeError as exc:
        return [{"error": f"dxgi_adapter_json_error:{exc}"}]
    if isinstance(payload, dict) and isinstance(payload.get("adapters"), list):
        return payload["adapters"]
    return payload if isinstance(payload, list) else [payload]


def dxgi_adapter_probe_script() -> str:
    return r"""
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct LUID {
  public uint LowPart;
  public int HighPart;
}

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct DXGI_ADAPTER_DESC1 {
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
  public string Description;
  public uint VendorId;
  public uint DeviceId;
  public uint SubSysId;
  public uint Revision;
  public UIntPtr DedicatedVideoMemory;
  public UIntPtr DedicatedSystemMemory;
  public UIntPtr SharedSystemMemory;
  public LUID AdapterLuid;
  public uint Flags;
}

[ComImport, Guid("770aae78-f26f-4dba-a829-253c83d1b387"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDXGIFactory1 {
  [PreserveSig] int SetPrivateData(ref Guid Name, uint DataSize, IntPtr pData);
  [PreserveSig] int SetPrivateDataInterface(ref Guid Name, IntPtr pUnknown);
  [PreserveSig] int GetPrivateData(ref Guid Name, ref uint pDataSize, IntPtr pData);
  [PreserveSig] int GetParent(ref Guid riid, out IntPtr ppParent);
  [PreserveSig] int EnumAdapters(uint Adapter, out IntPtr ppAdapter);
  [PreserveSig] int MakeWindowAssociation(IntPtr WindowHandle, uint Flags);
  [PreserveSig] int GetWindowAssociation(out IntPtr pWindowHandle);
  [PreserveSig] int CreateSwapChain(IntPtr pDevice, IntPtr pDesc, out IntPtr ppSwapChain);
  [PreserveSig] int CreateSoftwareAdapter(IntPtr Module, out IntPtr ppAdapter);
  [PreserveSig] int EnumAdapters1(uint Adapter, out IDXGIAdapter1 ppAdapter);
  [PreserveSig] int IsCurrent();
}

[ComImport, Guid("29038f61-3839-4626-91fd-086879011a05"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDXGIAdapter1 {
  [PreserveSig] int SetPrivateData(ref Guid Name, uint DataSize, IntPtr pData);
  [PreserveSig] int SetPrivateDataInterface(ref Guid Name, IntPtr pUnknown);
  [PreserveSig] int GetPrivateData(ref Guid Name, ref uint pDataSize, IntPtr pData);
  [PreserveSig] int GetParent(ref Guid riid, out IntPtr ppParent);
  [PreserveSig] int EnumOutputs(uint Output, out IntPtr ppOutput);
  [PreserveSig] int GetDesc(out DXGI_ADAPTER_DESC1 desc);
  [PreserveSig] int CheckInterfaceSupport(ref Guid InterfaceName, out long pUMDVersion);
  [PreserveSig] int GetDesc1(out DXGI_ADAPTER_DESC1 desc);
}

public static class DxgiProbe {
  [DllImport("dxgi.dll")]
  public static extern int CreateDXGIFactory1(ref Guid riid, out IDXGIFactory1 ppFactory);

  public static DxgiAdapterInfo[] GetAdapters() {
    Guid iid = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
    IDXGIFactory1 factory;
    int hr = CreateDXGIFactory1(ref iid, out factory);
    if (hr != 0 || factory == null) {
      throw new Exception("CreateDXGIFactory1 failed with HRESULT " + hr);
    }
    List<DxgiAdapterInfo> adapters = new List<DxgiAdapterInfo>();
    for (uint index = 0; index < 32; index++) {
      IDXGIAdapter1 adapter;
      int enumHr = factory.EnumAdapters1(index, out adapter);
      if (enumHr != 0 || adapter == null) {
        break;
      }
      DXGI_ADAPTER_DESC1 desc;
      int descHr = adapter.GetDesc1(out desc);
      if (descHr != 0) {
        continue;
      }
      adapters.Add(new DxgiAdapterInfo {
        adapter_index = index,
        luid = string.Format(
          "0x{0:x8}_0x{1:x8}",
          desc.AdapterLuid.HighPart,
          desc.AdapterLuid.LowPart
        ).ToLowerInvariant(),
        description = desc.Description,
        vendor_id = string.Format("0x{0:x4}", desc.VendorId),
        device_id = string.Format("0x{0:x4}", desc.DeviceId),
        dedicated_video_memory_bytes = desc.DedicatedVideoMemory.ToUInt64(),
        dedicated_system_memory_bytes = desc.DedicatedSystemMemory.ToUInt64(),
        shared_system_memory_bytes = desc.SharedSystemMemory.ToUInt64()
      });
    }
    return adapters.ToArray();
  }
}

public class DxgiAdapterInfo {
  public uint adapter_index;
  public string luid;
  public string description;
  public string vendor_id;
  public string device_id;
  public ulong dedicated_video_memory_bytes;
  public ulong dedicated_system_memory_bytes;
  public ulong shared_system_memory_bytes;
}
'@
Add-Type -TypeDefinition $source -ErrorAction Stop
$adapters = @([DxgiProbe]::GetAdapters() | ForEach-Object {
  $kind = if ($_.description -match 'AMD|Radeon') {
    'amd_igpu'
  } elseif ($_.description -match 'NVIDIA|GeForce|RTX') {
    'nvidia_dgpu'
  } elseif ($_.description -match 'Microsoft Basic Render') {
    'software'
  } else {
    'unknown'
  }
  [pscustomobject]@{
    adapter_index = [int]$_.adapter_index
    luid = $_.luid
    description = $_.description
    vendor_id = $_.vendor_id
    device_id = $_.device_id
    dedicated_video_memory_bytes = [uint64]$_.dedicated_video_memory_bytes
    dedicated_system_memory_bytes = [uint64]$_.dedicated_system_memory_bytes
    shared_system_memory_bytes = [uint64]$_.shared_system_memory_bytes
    adapter_kind = $kind
  }
})
[pscustomobject]@{
  status = 'completed'
  generated_at = (Get-Date).ToUniversalTime().ToString('o')
  adapters = $adapters
} | ConvertTo-Json -Depth 8
"""


def select_amd_dxgi_adapter(dxgi_adapters: Sequence[dict[str, Any]]) -> dict[str, Any] | None:
    for adapter in dxgi_adapters:
        if str(adapter.get("adapter_kind") or "") == "amd_igpu":
            return adapter
    for adapter in dxgi_adapters:
        if is_amd_adapter(str(adapter.get("description") or adapter.get("name") or "")):
            return adapter
    return None


def adapter_index(adapter: dict[str, Any] | None) -> int | None:
    if adapter is None:
        return None
    raw = adapter.get("adapter_index")
    if isinstance(raw, int) and raw >= 0:
        return raw
    if isinstance(raw, str):
        try:
            parsed = int(raw)
        except ValueError:
            return None
        return parsed if parsed >= 0 else None
    return None


def resolve_powershell_executable() -> str:
    configured = os.environ.get("EXAM_PREP_POWERSHELL_EXE", "").strip()
    if configured:
        return configured
    windows_root = os.environ.get("SystemRoot", "").strip() or os.environ.get("WINDIR", "").strip()
    if windows_root:
        candidate = Path(windows_root) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
        if candidate.is_file():
            return str(candidate)
    return "powershell.exe"


def _run_command(command: Sequence[str]) -> dict[str, Any]:
    try:
        result = subprocess.run(
            list(command),
            check=False,
            capture_output=True,
            text=True,
            timeout=COMMAND_TIMEOUT_SECONDS,
        )
    except FileNotFoundError as exc:
        return {"available": False, "error": str(exc), "command": list(command)}
    except subprocess.TimeoutExpired as exc:
        return {"available": False, "error": f"timeout:{exc}", "command": list(command)}
    return {
        "available": result.returncode == 0,
        "command": list(command),
        "exit_code": result.returncode,
        "stdout": result.stdout.strip(),
        "stderr": result.stderr.strip(),
    }


def is_amd_adapter(name: str) -> bool:
    return bool(re.search(r"\bAMD\b|Radeon", name, re.IGNORECASE))


def is_nvidia_adapter(name: str) -> bool:
    return bool(re.search(r"\bNVIDIA\b|GeForce|RTX", name, re.IGNORECASE))


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    report = build_report(args.model_dir)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))

    state = report["status"]["state"]
    if args.fail_if_blocked and state == "blocked":
        raise SystemExit(1)
    if args.fail_if_not_ready and state != "ready":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
