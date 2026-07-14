import { setTimeout as delay } from 'node:timers/promises';

import type { JsonResponse, JsonTransport } from './api-client.mts';
import { requireJsonObject } from './api-client.mts';

export interface PollOptions {
  readonly timeoutMs: number;
  readonly intervalMs?: number;
  readonly label: string;
}

export async function pollJson(
  transport: JsonTransport,
  path: string,
  predicate: (body: Record<string, unknown>) => boolean,
  {
    timeoutMs,
    intervalMs = 200,
    label,
  }: PollOptions,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: JsonResponse | null = null;
  while (Date.now() < deadline) {
    last = await transport.request('GET', path);
    const body = requireJsonObject(last, [200], label);
    if (predicate(body)) {
      return body;
    }
    await delay(intervalMs);
  }
  throw new Error(
    `${label} did not reach the required state before timeout (last HTTP ${last?.status ?? 'none'}).`,
  );
}

export async function stableJsonSamples(
  transport: JsonTransport,
  path: string,
  count: number,
  intervalMs: number,
  label: string,
  sleep: (milliseconds: number) => Promise<unknown> = delay,
): Promise<Record<string, unknown>[]> {
  const samples: Record<string, unknown>[] = [];
  for (let index = 0; index < count; index += 1) {
    const response = await transport.request('GET', path);
    samples.push(requireJsonObject(response, [200], label));
    if (index + 1 < count) {
      await sleep(intervalMs);
    }
  }
  return samples;
}

export function encoded(value: string): string {
  return encodeURIComponent(value);
}

export function stringField(
  value: unknown,
  label: string,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

export function numberField(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

export function booleanField(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be boolean.`);
  }
  return value;
}
