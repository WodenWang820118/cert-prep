import { existsSync, readFileSync } from 'node:fs';

import type {
  DxgiAdapter,
  WindowsResourceSummary,
} from './resource-sampling-types.mts';

export function readJsonFile(path: string): unknown {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readUtfJsonFile(path)) as unknown;
  } catch {
    return null;
  }
}

function readUtfJsonFile(path: string): string {
  const bytes = readFileSync(path);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString('utf8');
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString('utf16le');
  }
  return bytes.toString('utf8').replace(/^\uFEFF/, '');
}

export function readDxgiAdapters(path: string): DxgiAdapter[] {
  const payload = readJsonFile(path);
  if (!isRecord(payload) || !Array.isArray(payload.adapters)) {
    return [];
  }
  return payload.adapters.filter(isDxgiAdapter).map((adapter) => ({
    ...adapter,
    luid: adapter.luid.toLowerCase(),
  }));
}

function isDxgiAdapter(value: unknown): value is DxgiAdapter {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.adapter_index === 'number' &&
    typeof value.luid === 'string' &&
    typeof value.description === 'string' &&
    typeof value.vendor_id === 'string' &&
    typeof value.device_id === 'string' &&
    typeof value.dedicated_video_memory_bytes === 'number' &&
    typeof value.dedicated_system_memory_bytes === 'number' &&
    typeof value.shared_system_memory_bytes === 'number' &&
    typeof value.adapter_kind === 'string'
  );
}

export function gpuLuidMapStatus(
  windowsSummary: WindowsResourceSummary | null,
  dxgiAdapters: readonly DxgiAdapter[],
): 'complete' | 'partial' | 'unavailable' {
  if (!windowsSummary || dxgiAdapters.length === 0) {
    return 'unavailable';
  }
  return unmappedGpuLuids(windowsSummary, dxgiAdapters).length === 0
    ? 'complete'
    : 'partial';
}

export function unmappedGpuLuids(
  windowsSummary: WindowsResourceSummary | null,
  dxgiAdapters: readonly DxgiAdapter[],
): string[] {
  if (!windowsSummary) {
    return [];
  }
  const mapped = new Set(dxgiAdapters.map((adapter) => adapter.luid));
  return windowsSummary.gpu_adapters
    .map((adapter) => adapter.luid)
    .filter((luid) => !mapped.has(luid));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
