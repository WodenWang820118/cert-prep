const CAPTURE_LIMIT = 12_000;

/** Coerces process/API numeric fields into finite report-safe numbers. */
export function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : Number(value) || 0;
}

/** Coerces optional process/API fields into report-safe strings. */
export function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Narrows unknown JSON values before reading object fields. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Normalizes Windows and POSIX separators for report paths and matching. */
export function normalizePath(path: string): string {
  return path.split(/[\\/]+/).join('/');
}

/** Normalizes a command line fragment for case-insensitive Windows matching. */
export function normalizeForCommandLine(value: string): string {
  return normalizePath(value).toLowerCase();
}

/** Keeps captured output bounded before it enters reports or errors. */
export function trimCapture(value: string): string {
  return value.trim().slice(-CAPTURE_LIMIT);
}

/** Converts unknown caught values into readable diagnostics. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'none');
}
