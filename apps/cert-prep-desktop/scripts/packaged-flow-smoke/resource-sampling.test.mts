import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  dxgiAdapterProbeScript,
  finalizeResourceSamplingArtifacts,
  readDxgiAdapters,
  summarizeGpuByAdapter,
  summarizeNvidiaSmiCsv,
  summarizeWindowsResourceCsv,
  windowsResourceSamplingScript,
} from './resource-sampling.mts';

test('windows resource sampling script captures CPU, process, and GPU counters', () => {
  const script = windowsResourceSamplingScript({
    csvPath: "C:\\tmp\\sample's.csv",
    summaryPath: 'C:\\tmp\\summary.json',
    intervalMs: 1000,
  });

  assert.match(script, /Win32_PerfFormattedData_PerfOS_Processor/);
  assert.match(script, /Win32_Process/);
  assert.match(script, /working_set_bytes/);
  assert.match(script, /private_page_count_bytes/);
  assert.match(script, /GPU Adapter Memory/);
  assert.match(script, /GPU Process Memory/);
  assert.match(script, /GPU Engine/);
  assert.match(script, /cert-prep-desktop\.exe/);
  assert.match(script, /cert-prep-ocr-windowsml-runtime\.exe/);
  assert.match(script, /llama-server\.exe/);
  assert.match(script, /ollama\.exe/);
  assert.match(script, /ollama app\.exe/);
  assert.match(script, /C:\\tmp\\sample''s\.csv/);
});

test('dxgi adapter probe script emits LUID and adapter metadata', () => {
  const script = dxgiAdapterProbeScript('C:\\tmp\\dxgi.json');

  assert.match(script, /CreateDXGIFactory1/);
  assert.match(script, /GetDesc1/);
  assert.match(script, /AdapterLuid/);
  assert.match(script, /adapter_index/);
  assert.match(script, /amd_igpu/);
  assert.match(script, /nvidia_dgpu/);
});

test('dxgi adapter reader accepts PowerShell UTF-8 BOM JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cert-prep-dxgi-'));
  try {
    const path = join(dir, 'windows-dxgi-adapters.json');
    writeFileSync(
      path,
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(
          JSON.stringify({
            status: 'completed',
            adapters: [
              dxgiAdapter(
                '0x00000000_0x000136c5',
                'AMD Radeon(TM) 880M Graphics',
                'amd_igpu',
              ),
              dxgiAdapter(
                '0x00000000_0x0001fbc5',
                'NVIDIA GeForce RTX 4060 Laptop GPU',
                'nvidia_dgpu',
              ),
            ],
          }),
          'utf8',
        ),
      ]),
    );

    const adapters = readDxgiAdapters(path);

    assert.equal(adapters.length, 2);
    assert.equal(adapters[0].adapter_kind, 'amd_igpu');
    assert.equal(adapters[1].adapter_kind, 'nvidia_dgpu');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resource summary finalizer preserves closeout evidence and target process GPU usage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cert-prep-resource-summary-'));
  try {
    writeFileSync(
      join(dir, 'windows-resource-summary.json'),
      JSON.stringify({ generated_at: '2026-06-21T00:00:00.000Z' }),
      'utf8',
    );
    writeFileSync(
      join(dir, 'windows-dxgi-adapters.json'),
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(
          JSON.stringify({
            status: 'completed',
            adapters: [
              dxgiAdapter(
                '0x00000000_0x000136c5',
                'AMD Radeon(TM) 880M Graphics',
                'amd_igpu',
              ),
              dxgiAdapter(
                '0x00000000_0x0001fbc5',
                'NVIDIA GeForce RTX 4060 Laptop GPU',
                'nvidia_dgpu',
              ),
            ],
          }),
          'utf8',
        ),
      ]),
    );
    writeFileSync(
      join(dir, 'windows-resource-sampling.csv'),
      `timestamp,source,path,pid,name,metric,value,unit
"2026-06-21T00:00:00Z","windows_process","Win32_Process","42","cert-prep-ocr-runtime.exe","working_set_bytes","1024","bytes"
"2026-06-21T00:00:00Z","windows_gpu_counter","\\\\MSI\\GPU Adapter Memory(luid_0x00000000_0x000136C5_phys_0)\\Shared Usage","","","\\\\MSI\\GPU Adapter Memory(luid_0x00000000_0x000136C5_phys_0)\\Shared Usage","4096","raw"
"2026-06-21T00:00:00Z","windows_gpu_counter","\\\\MSI\\GPU Adapter Memory(luid_0x00000000_0x0001FBC5_phys_0)\\Dedicated Usage","","","\\\\MSI\\GPU Adapter Memory(luid_0x00000000_0x0001FBC5_phys_0)\\Dedicated Usage","8192","raw"
"2026-06-21T00:00:00Z","windows_gpu_counter","\\\\MSI\\GPU Process Memory(pid_42_luid_0x00000000_0x0001FBC5_phys_0)\\Dedicated Usage","","","\\\\MSI\\GPU Process Memory(pid_42_luid_0x00000000_0x0001FBC5_phys_0)\\Dedicated Usage","2048","raw"
`,
      'utf8',
    );
    writeFileSync(
      join(dir, 'nvidia-smi.csv'),
      `timestamp, utilization.gpu [%], memory.used [MiB], memory.total [MiB], power.draw [W]
2026/06/21 17:00:00.000, 44 %, 1936 MiB, 8188 MiB, 18.00 W
`,
      'utf8',
    );

    finalizeResourceSamplingArtifacts({
      outDir: dir,
      workspaceRoot: dir,
      artifacts: {
        windows_dxgi_adapters_json: 'windows-dxgi-adapters.json',
        windows_counters_csv: 'windows-resource-sampling.csv',
        windows_summary_json: 'windows-resource-summary.json',
        nvidia_smi_csv: 'nvidia-smi.csv',
      },
      observe() {
        assert.fail('finalizer should not report an observation for valid fixtures');
      },
      samplerStopSummary: {
        started_at: '2026-06-21T00:00:00.000Z',
        finished_at: '2026-06-21T00:00:01.000Z',
        duration_ms: 1000,
        child_count: 2,
        stopped_count: 2,
        forced_count: 1,
        error_count: 0,
        results: [],
      },
      nvidiaSmiTimestampUtcOffsetMinutesAtStart: 480,
      nvidiaSmiTimestampUtcOffsetMinutesAtStop: 480,
    });

    const summary = JSON.parse(
      readFileSync(join(dir, 'windows-resource-summary.json'), 'utf8'),
    ) as {
      sampler_stop: { forced_count: number };
      gpu_luid_map_status: string;
      dxgi_adapters: unknown[];
      named_target_process_gpu_usage: Array<{
        name: string;
        adapter_kind: string;
        metrics: { dedicated_usage: { max: number } };
      }>;
      gpu_routing_checks: {
        windowsml_ocr_process_observed: boolean;
        ocr_uses_amd_igpu: boolean;
        ocr_avoids_nvidia_dgpu: boolean;
      };
      nvidia_smi_summary: { memory_used_mib: { max: number } };
      nvidia_smi_timestamp_utc_offset_minutes: number;
    };

    assert.equal(summary.sampler_stop.forced_count, 1);
    assert.equal(summary.gpu_luid_map_status, 'complete');
    assert.equal(summary.dxgi_adapters.length, 2);
    assert.equal(summary.named_target_process_gpu_usage.length, 1);
    assert.equal(
      summary.named_target_process_gpu_usage[0].name,
      'cert-prep-ocr-runtime.exe',
    );
    assert.equal(
      summary.named_target_process_gpu_usage[0].adapter_kind,
      'nvidia_dgpu',
    );
    assert.equal(
      summary.named_target_process_gpu_usage[0].metrics.dedicated_usage.max,
      2048,
    );
    assert.equal(summary.gpu_routing_checks.windowsml_ocr_process_observed, false);
    assert.equal(summary.gpu_routing_checks.ocr_uses_amd_igpu, false);
    assert.equal(summary.gpu_routing_checks.ocr_avoids_nvidia_dgpu, false);
    assert.equal(summary.nvidia_smi_summary.memory_used_mib.max, 1936);
    assert.equal(summary.nvidia_smi_timestamp_utc_offset_minutes, 480);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resource summary finalizer rejects timezone offset changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cert-prep-resource-timezone-'));
  try {
    assert.throws(
      () =>
        finalizeResourceSamplingArtifacts({
          outDir: dir,
          workspaceRoot: dir,
          artifacts: {},
          observe() {
            assert.fail('offset validation must fail before observation');
          },
          nvidiaSmiTimestampUtcOffsetMinutesAtStart: 480,
          nvidiaSmiTimestampUtcOffsetMinutesAtStop: 540,
        }),
      /timestamp UTC offset changed or is unsupported/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('windows resource summary aggregates CPU, process RSS, and GPU LUID metrics', () => {
  const summary = summarizeWindowsResourceCsv(`timestamp,source,path,pid,name,metric,value,unit
"2026-06-21T00:00:00Z","windows_cpu","Win32_PerfFormattedData_PerfOS_Processor","","_Total","percent_processor_time","55","percent"
"2026-06-21T00:00:00Z","windows_process","Win32_Process","42","cert-prep-ocr-runtime.exe","working_set_bytes","1024","bytes"
"2026-06-21T00:00:00Z","windows_gpu_counter","\\\\MSI\\GPU Adapter Memory(luid_0x00000000_0x000136C5_phys_0)\\Dedicated Usage","","","\\\\MSI\\GPU Adapter Memory(luid_0x00000000_0x000136C5_phys_0)\\Dedicated Usage","256","raw"
"2026-06-21T00:00:00Z","windows_gpu_counter","\\\\MSI\\GPU Engine(pid_42_luid_0x00000000_0x000136C5_phys_0_eng_2_engtype_Compute 0)\\Utilization Percentage","","","\\\\MSI\\GPU Engine(pid_42_luid_0x00000000_0x000136C5_phys_0_eng_2_engtype_Compute 0)\\Utilization Percentage","75.5","raw"
"2026-06-21T00:00:01Z","windows_gpu_counter","\\\\MSI\\GPU Engine(pid_42_luid_0x00000000_0x000136C5_phys_0_eng_2_engtype_Compute 0)\\Utilization Percentage","","","\\\\MSI\\GPU Engine(pid_42_luid_0x00000000_0x000136C5_phys_0_eng_2_engtype_Compute 0)\\Utilization Percentage","25.5","raw"
"2026-06-21T00:00:01Z","windows_gpu_counter","\\\\MSI\\GPU Engine(pid_42_luid_0x00000000_0x000136C5_phys_0_eng_2_engtype_Compute 0)\\Utilization Percentage","","","\\\\MSI\\GPU Engine(pid_42_luid_0x00000000_0x000136C5_phys_0_eng_2_engtype_Compute 0)\\Utilization Percentage","99999","raw"
`) as unknown as {
    sample_count: number;
    cpu: { max: number; avg: number };
    processes: Array<{ metrics: { working_set_bytes: { max: number } } }>;
    gpu_adapters: Array<{
      luid: string;
      metrics: {
        dedicated_usage: { max: number };
        engine_utilization_percent: { max: number; avg: number };
      };
      engine_types: { compute_0: { max: number } };
    }>;
  };

  assert.equal(summary.sample_count, 2);
  assert.equal(summary.cpu.max, 55);
  assert.equal(summary.cpu.avg, 55);
  assert.equal(summary.processes[0].metrics.working_set_bytes.max, 1024);
  assert.equal(summary.gpu_adapters[0].luid, '0x00000000_0x000136c5');
  assert.equal(summary.gpu_adapters[0].metrics.dedicated_usage.max, 256);
  assert.equal(
    summary.gpu_adapters[0].metrics.engine_utilization_percent.max,
    75.5,
  );
  assert.equal(
    summary.gpu_adapters[0].metrics.engine_utilization_percent.avg,
    50.5,
  );
  assert.equal(summary.gpu_adapters[0].engine_types.compute_0.max, 75.5);
});

test('adapter-aware summary joins GPU LUID metrics to DXGI adapter kinds', () => {
  const windowsSummary = summarizeWindowsResourceCsv(`timestamp,source,path,pid,name,metric,value,unit
"2026-06-21T00:00:00Z","windows_process","Win32_Process","42","cert-prep-ocr-runtime.exe","working_set_bytes","1024","bytes"
"2026-06-21T00:00:00Z","windows_gpu_counter","\\\\MSI\\GPU Adapter Memory(luid_0x00000000_0x000136C5_phys_0)\\Dedicated Usage","","","\\\\MSI\\GPU Adapter Memory(luid_0x00000000_0x000136C5_phys_0)\\Dedicated Usage","256","raw"
"2026-06-21T00:00:00Z","windows_gpu_counter","\\\\MSI\\GPU Adapter Memory(luid_0x00000000_0x0001FBC5_phys_0)\\Dedicated Usage","","","\\\\MSI\\GPU Adapter Memory(luid_0x00000000_0x0001FBC5_phys_0)\\Dedicated Usage","512","raw"
"2026-06-21T00:00:00Z","windows_gpu_counter","\\\\MSI\\GPU Engine(pid_42_luid_0x00000000_0x000136C5_phys_0_eng_2_engtype_Compute 0)\\Utilization Percentage","","","\\\\MSI\\GPU Engine(pid_42_luid_0x00000000_0x000136C5_phys_0_eng_2_engtype_Compute 0)\\Utilization Percentage","75.5","raw"
"2026-06-21T00:00:00Z","windows_gpu_counter","\\\\MSI\\GPU Process Memory(pid_42_luid_0x00000000_0x000136C5_phys_0)\\Shared Usage","","","\\\\MSI\\GPU Process Memory(pid_42_luid_0x00000000_0x000136C5_phys_0)\\Shared Usage","4096","raw"
`);

  const summary = summarizeGpuByAdapter(windowsSummary, [
    dxgiAdapter('0x00000000_0x000136c5', 'AMD Radeon(TM) 880M Graphics', 'amd_igpu'),
    dxgiAdapter('0x00000000_0x0001fbc5', 'NVIDIA GeForce RTX 4060 Laptop GPU', 'nvidia_dgpu'),
  ]) as {
    gpu_utilization_by_adapter: {
      amd_igpu: { max_compute_percent: number; name: string };
    };
    gpu_memory_by_adapter: {
      amd_igpu: { max_process_shared_usage_bytes: number };
      nvidia_dgpu: { max_dedicated_usage_bytes: number };
    };
    target_process_gpu_usage: Array<{
      adapter_kind: string;
      adapter_name: string;
      name: string;
    }>;
    named_target_process_gpu_usage: Array<{
      adapter_kind: string;
      adapter_name: string;
      name: string;
    }>;
    gpu_routing_checks: {
      windowsml_ocr_process_observed: boolean;
      ocr_uses_amd_igpu: boolean;
      ocr_avoids_nvidia_dgpu: boolean;
      reasoning_uses_nvidia_dgpu: boolean;
      gpu_luid_map_usable: boolean;
    };
  };

  assert.equal(
    summary.gpu_utilization_by_adapter.amd_igpu.max_compute_percent,
    75.5,
  );
  assert.equal(
    summary.gpu_utilization_by_adapter.amd_igpu.name,
    'AMD Radeon(TM) 880M Graphics',
  );
  assert.equal(
    summary.gpu_memory_by_adapter.amd_igpu.max_process_shared_usage_bytes,
    4096,
  );
  assert.equal(
    summary.gpu_memory_by_adapter.nvidia_dgpu.max_dedicated_usage_bytes,
    512,
  );
  assert.equal(summary.target_process_gpu_usage[0].adapter_kind, 'amd_igpu');
  assert.equal(
    summary.target_process_gpu_usage[0].adapter_name,
    'AMD Radeon(TM) 880M Graphics',
  );
  assert.equal(summary.target_process_gpu_usage[0].name, 'cert-prep-ocr-runtime.exe');
  assert.equal(summary.named_target_process_gpu_usage.length, 1);
  assert.equal(
    summary.named_target_process_gpu_usage[0].name,
    'cert-prep-ocr-runtime.exe',
  );
  assert.equal(summary.gpu_routing_checks.windowsml_ocr_process_observed, false);
  assert.equal(summary.gpu_routing_checks.ocr_uses_amd_igpu, false);
  assert.equal(summary.gpu_routing_checks.ocr_avoids_nvidia_dgpu, false);
  assert.equal(summary.gpu_routing_checks.reasoning_uses_nvidia_dgpu, false);
  assert.equal(summary.gpu_routing_checks.gpu_luid_map_usable, true);
});

test('adapter-aware summary exposes WindowsML OCR and reasoning GPU routing gates', () => {
  const windowsSummary = summarizeWindowsResourceCsv(`timestamp,source,path,pid,name,metric,value,unit
"2026-06-21T00:00:00Z","windows_process","Win32_Process","42","cert-prep-ocr-windowsml-runtime.exe","working_set_bytes","1024","bytes"
"2026-06-21T00:00:00Z","windows_process","Win32_Process","77","llama-server.exe","working_set_bytes","2048","bytes"
"2026-06-21T00:00:00Z","windows_gpu_counter","\\\\MSI\\GPU Adapter Memory(luid_0x00000000_0x000136C5_phys_0)\\Dedicated Usage","","","\\\\MSI\\GPU Adapter Memory(luid_0x00000000_0x000136C5_phys_0)\\Dedicated Usage","256","raw"
"2026-06-21T00:00:00Z","windows_gpu_counter","\\\\MSI\\GPU Adapter Memory(luid_0x00000000_0x0001FBC5_phys_0)\\Dedicated Usage","","","\\\\MSI\\GPU Adapter Memory(luid_0x00000000_0x0001FBC5_phys_0)\\Dedicated Usage","512","raw"
"2026-06-21T00:00:00Z","windows_gpu_counter","\\\\MSI\\GPU Adapter Memory(luid_0x00000000_0x00022E9E_phys_0)\\Shared Usage","","","\\\\MSI\\GPU Adapter Memory(luid_0x00000000_0x00022E9E_phys_0)\\Shared Usage","65536","raw"
"2026-06-21T00:00:00Z","windows_gpu_counter","\\\\MSI\\GPU Process Memory(pid_42_luid_0x00000000_0x000136C5_phys_0)\\Shared Usage","","","\\\\MSI\\GPU Process Memory(pid_42_luid_0x00000000_0x000136C5_phys_0)\\Shared Usage","8192","raw"
"2026-06-21T00:00:00Z","windows_gpu_counter","\\\\MSI\\GPU Process Memory(pid_42_luid_0x00000000_0x0001FBC5_phys_0)\\Dedicated Usage","","","\\\\MSI\\GPU Process Memory(pid_42_luid_0x00000000_0x0001FBC5_phys_0)\\Dedicated Usage","1048576","raw"
"2026-06-21T00:00:00Z","windows_gpu_counter","\\\\MSI\\GPU Process Memory(pid_77_luid_0x00000000_0x0001FBC5_phys_0)\\Dedicated Usage","","","\\\\MSI\\GPU Process Memory(pid_77_luid_0x00000000_0x0001FBC5_phys_0)\\Dedicated Usage","2147483648","raw"
"2026-06-21T00:00:00Z","windows_gpu_counter","\\\\MSI\\GPU Process Memory(pid_88_luid_0x00000000_0x00022E9E_phys_0)\\Shared Usage","","","\\\\MSI\\GPU Process Memory(pid_88_luid_0x00000000_0x00022E9E_phys_0)\\Shared Usage","65536","raw"
`);

  const summary = summarizeGpuByAdapter(windowsSummary, [
    dxgiAdapter('0x00000000_0x000136c5', 'AMD Radeon(TM) 880M Graphics', 'amd_igpu'),
    dxgiAdapter('0x00000000_0x0001fbc5', 'NVIDIA GeForce RTX 4060 Laptop GPU', 'nvidia_dgpu'),
  ]) as {
    gpu_routing_checks: {
      windowsml_ocr_process_observed: boolean;
      ocr_uses_amd_igpu: boolean;
      ocr_avoids_nvidia_dgpu: boolean;
      ocr_nvidia_process_memory_max_bytes: number;
      reasoning_uses_nvidia_dgpu: boolean;
      gpu_luid_map_usable: boolean;
    };
  };

  assert.equal(summary.gpu_routing_checks.windowsml_ocr_process_observed, true);
  assert.equal(summary.gpu_routing_checks.ocr_uses_amd_igpu, true);
  assert.equal(summary.gpu_routing_checks.ocr_avoids_nvidia_dgpu, true);
  assert.equal(
    summary.gpu_routing_checks.ocr_nvidia_process_memory_max_bytes,
    1_048_576,
  );
  assert.equal(summary.gpu_routing_checks.reasoning_uses_nvidia_dgpu, true);
  assert.equal(summary.gpu_routing_checks.gpu_luid_map_usable, true);
});

test('nvidia smi summary aggregates utilization, memory, and power peaks', () => {
  const summary = summarizeNvidiaSmiCsv(`timestamp, utilization.gpu [%], memory.used [MiB], memory.total [MiB], power.draw [W]
2026/06/21 17:00:00.000, 12 %, 1000 MiB, 8188 MiB, 14.25 W
2026/06/21 17:00:01.000, 33 %, 2048 MiB, 8188 MiB, 22.50 W
`) as {
    sample_count: number;
    gpu_utilization_percent: { max: number };
    memory_used_mib: { max: number };
    power_draw_w: { max: number };
  };

  assert.equal(summary.sample_count, 2);
  assert.equal(summary.gpu_utilization_percent.max, 33);
  assert.equal(summary.memory_used_mib.max, 2048);
  assert.equal(summary.power_draw_w.max, 22.5);
});

function dxgiAdapter(luid: string, description: string, adapterKind: string) {
  return {
    adapter_index: adapterKind === 'amd_igpu' ? 0 : 1,
    luid,
    description,
    vendor_id: '0x0000',
    device_id: '0x0000',
    dedicated_video_memory_bytes: 1,
    dedicated_system_memory_bytes: 0,
    shared_system_memory_bytes: 2,
    adapter_kind: adapterKind,
  };
}
