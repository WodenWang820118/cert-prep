import type { JsonRecord } from './types.mts';

/** Validates numeric CLI/env input that must be a positive integer. */
export function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

/** Coerces unknown health payloads into records for stable report summaries. */
export function asJsonRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

/** Converts unknown thrown values into deterministic diagnostic strings. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'none');
}
