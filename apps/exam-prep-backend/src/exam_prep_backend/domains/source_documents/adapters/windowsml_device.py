from __future__ import annotations

from collections.abc import Sequence
import json
import os
from pathlib import Path
import platform
import re
import subprocess
from typing import Any


AUTO_WINDOWSML_DEVICE_ID = -1
COMMAND_TIMEOUT_SECONDS = 10.0


class WindowsMLDeviceSelectionError(RuntimeError):
    """Raised when the WindowsML adapter cannot be selected safely."""


def resolve_windowsml_device_id(requested_device_id: int | None) -> int | None:
    if requested_device_id is None or requested_device_id >= 0:
        return requested_device_id
    adapter = select_amd_dxgi_adapter(dxgi_adapter_snapshot())
    resolved = adapter_index(adapter)
    if resolved is None:
        raise WindowsMLDeviceSelectionError(
            "WindowsML OCR adapter could not be resolved from DXGI adapters."
        )
    return resolved


def windowsml_device_label(device_id: int | None) -> str:
    if device_id is None:
        return "amd_windowsml"
    return f"amd_windowsml:{device_id}"


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


def is_amd_adapter(name: str) -> bool:
    return bool(re.search(r"\bAMD\b|Radeon", name, re.IGNORECASE))


def is_nvidia_adapter(name: str) -> bool:
    return bool(re.search(r"\bNVIDIA\b|GeForce|RTX", name, re.IGNORECASE))


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
