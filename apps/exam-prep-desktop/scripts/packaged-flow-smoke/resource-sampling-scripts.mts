import type { WindowsResourceScriptOptions } from './resource-sampling-types.mts';

function psString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function dxgiAdapterProbeScript(outputPath: string): string {
  return `$ErrorActionPreference = 'Stop'
$outputPath = ${psString(outputPath)}
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
try {
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
      luid = $_.luid
      adapter_index = [int]$_.adapter_index
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
  } | ConvertTo-Json -Depth 8 | Set-Content -Path $outputPath -Encoding utf8
} catch {
  [pscustomobject]@{
    status = 'unavailable'
    generated_at = (Get-Date).ToUniversalTime().ToString('o')
    error = $_.Exception.Message
    adapters = @()
  } | ConvertTo-Json -Depth 8 | Set-Content -Path $outputPath -Encoding utf8
}
`;
}

export function windowsResourceSamplingScript({
  csvPath,
  summaryPath,
  intervalMs,
}: WindowsResourceScriptOptions): string {
  return `$ErrorActionPreference = 'Stop'
$csvPath = ${psString(csvPath)}
$summaryPath = ${psString(summaryPath)}
$intervalMs = ${intervalMs}
$targetProcessNames = @(
  'exam-prep-desktop.exe',
  'exam-prep-backend.exe',
  'exam-prep-ocr-runtime.exe',
  'exam-prep-ocr-windowsml-runtime.exe',
  'llama-server.exe',
  'ollama.exe',
  'ollama app.exe',
  'ollama_llama_server.exe',
  'python.exe',
  'pythonw.exe'
)
$gpuCounters = @(
  '\\GPU Adapter Memory(*)\\Dedicated Usage',
  '\\GPU Adapter Memory(*)\\Shared Usage',
  '\\GPU Adapter Memory(*)\\Total Committed',
  '\\GPU Process Memory(*)\\Dedicated Usage',
  '\\GPU Process Memory(*)\\Shared Usage',
  '\\GPU Process Memory(*)\\Total Committed',
  '\\GPU Engine(*)\\Utilization Percentage'
)
function New-ResourceRow($timestamp, $source, $path, $pidValue, $name, $metric, $value, $unit) {
  [pscustomobject]@{
    timestamp = $timestamp
    source = $source
    path = $path
    pid = $pidValue
    name = $name
    metric = $metric
    value = $value
    unit = $unit
  }
}

function Add-Rows($rows) {
  if ($rows.Count -gt 0) {
    $rows | ConvertTo-Csv -NoTypeInformation | Select-Object -Skip 1 | Add-Content -Path $csvPath -Encoding utf8
  }
}
$summary = [ordered]@{
  generated_at = (Get-Date).ToUniversalTime().ToString('o')
  sample_interval_ms = $intervalMs
  target_process_names = $targetProcessNames
  video_controllers = @(Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion,PNPDeviceID)
  gpu_counter_sets = @(Get-Counter -ListSet GPU* | Select-Object -ExpandProperty CounterSetName)
  gpu_counters = $gpuCounters
}
$summary | ConvertTo-Json -Depth 8 | Set-Content -Path $summaryPath -Encoding utf8
'timestamp,source,path,pid,name,metric,value,unit' | Set-Content -Path $csvPath -Encoding utf8
while ($true) {
  $timestamp = (Get-Date).ToUniversalTime().ToString('o')
  $rows = @()
  try {
    $cpu = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"
    $rows += New-ResourceRow $timestamp 'windows_cpu' 'Win32_PerfFormattedData_PerfOS_Processor' '' '_Total' 'percent_processor_time' ([double]$cpu.PercentProcessorTime) 'percent'
  } catch {
    $rows += New-ResourceRow $timestamp 'error' 'Win32_PerfFormattedData_PerfOS_Processor' '' '' 'cpu_sample_error' $_.Exception.Message 'text'
  }
  try {
    $processes = Get-CimInstance Win32_Process | Where-Object { $targetProcessNames -contains $_.Name }
    foreach ($process in $processes) {
      $workingSet = if ($null -eq $process.WorkingSetSize) { 0 } else { [double]$process.WorkingSetSize }
      $privatePageCount = if ($null -eq $process.PrivatePageCount) { 0 } else { [double]$process.PrivatePageCount }
      $rows += New-ResourceRow $timestamp 'windows_process' 'Win32_Process' $process.ProcessId $process.Name 'working_set_bytes' $workingSet 'bytes'
      $rows += New-ResourceRow $timestamp 'windows_process' 'Win32_Process' $process.ProcessId $process.Name 'private_page_count_bytes' $privatePageCount 'bytes'
    }
  } catch {
    $rows += New-ResourceRow $timestamp 'error' 'Win32_Process' '' '' 'process_sample_error' $_.Exception.Message 'text'
  }
  try {
    $samples = Get-Counter -Counter $gpuCounters -ErrorAction Stop
    foreach ($sample in $samples.CounterSamples) {
      $rows += New-ResourceRow $timestamp 'windows_gpu_counter' $sample.Path '' '' $sample.Path ([double]$sample.CookedValue) 'raw'
    }
  } catch {
    $rows += New-ResourceRow $timestamp 'error' 'Get-Counter' '' '' 'gpu_counter_sample_error' $_.Exception.Message 'text'
  }
  Add-Rows $rows
  Start-Sleep -Milliseconds $intervalMs
}
`;
}
