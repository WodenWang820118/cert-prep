import { createHash } from 'node:crypto';

import { isRecord } from '../packaged-flow-smoke/text-utils.mts';

export const PACKAGED_STATIC_IMAGE_FILENAME =
  'packaged-static-image-256x128.png';
export const PACKAGED_STATIC_IMAGE_WIDTH = 256;
export const PACKAGED_STATIC_IMAGE_HEIGHT = 128;

const PACKAGED_STATIC_IMAGE_BYTES = Buffer.from(
  [
    'iVBORw0KGgoAAAANSUhEUgAAAQAAAACACAIAAABr1yBdAAABHUlEQVR42u3TAQnAQBADwbS8hPNv',
    '8COiNgo3I2Fhn3tvYKuTZGaEYKG2rwpsZgAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAM',
    'AAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAA',
    'GAAMAAYAA2AAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAY',
    'AAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAyAAcAAYAAwABgA',
    'DAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwAPzXSdJWCHb6AJymCYmkTS0cAAAAAElFTkSuQmCC',
  ].join(''),
  'base64',
);
export const PACKAGED_STATIC_IMAGE_SHA256 = createHash('sha256')
  .update(PACKAGED_STATIC_IMAGE_BYTES)
  .digest('hex');

const TERMINAL_STATUSES = new Set([
  'ready',
  'no_text_detected',
  'ocr_failed',
  'canceled',
  'exam_failed',
]);

export interface PackagedImageDocumentEvidence {
  readonly id: string;
  readonly project_id: string;
  readonly filename: string;
  readonly sha256: string;
  readonly status: 'no_text_detected';
  readonly page_count: 1;
  readonly processed_page_count: 1;
  readonly has_text: false;
  readonly chunks_count: 0;
  readonly extraction_method: 'none';
  readonly ocr_device: string;
  readonly ocr_fallback_reason: string | null;
}

export function packagedStaticImage(): Buffer {
  return Buffer.from(PACKAGED_STATIC_IMAGE_BYTES);
}

export function isTerminalImageDocument(payload: unknown): boolean {
  return (
    isRecord(payload) &&
    typeof payload.status === 'string' &&
    TERMINAL_STATUSES.has(payload.status)
  );
}

export function requireExpectedTerminalImageDocument(
  payload: unknown,
): PackagedImageDocumentEvidence {
  if (!isRecord(payload)) {
    throw new Error('Packaged image document response was not a JSON object.');
  }
  const expected: Readonly<Record<string, unknown>> = {
    filename: PACKAGED_STATIC_IMAGE_FILENAME,
    sha256: PACKAGED_STATIC_IMAGE_SHA256,
    status: 'no_text_detected',
    page_count: 1,
    processed_page_count: 1,
    has_text: false,
    chunks_count: 0,
    extraction_method: 'none',
  };
  for (const [field, value] of Object.entries(expected)) {
    if (payload[field] !== value) {
      throw new Error(
        `Packaged image document ${field} expected ${String(value)} but received ${String(payload[field])}.`,
      );
    }
  }
  if (typeof payload.id !== 'string' || payload.id.length === 0) {
    throw new Error('Packaged image document id was missing.');
  }
  if (typeof payload.project_id !== 'string' || payload.project_id.length === 0) {
    throw new Error('Packaged image document project_id was missing.');
  }
  if (
    typeof payload.ocr_device !== 'string' ||
    payload.ocr_device.trim().length === 0
  ) {
    throw new Error(
      'Packaged image document did not report the OCR device that processed the PNG.',
    );
  }
  if (
    payload.ocr_fallback_reason !== null &&
    typeof payload.ocr_fallback_reason !== 'string'
  ) {
    throw new Error('Packaged image document ocr_fallback_reason was invalid.');
  }
  return payload as unknown as PackagedImageDocumentEvidence;
}

export async function waitForExpectedTerminalImageDocument(
  readDocument: () => Promise<unknown>,
  {
    timeoutMs,
    pollIntervalMs = 500,
    delay = defaultDelay,
  }: {
    readonly timeoutMs: number;
    readonly pollIntervalMs?: number;
    readonly delay?: (durationMs: number) => Promise<void>;
  },
): Promise<PackagedImageDocumentEvidence> {
  const deadline = Date.now() + timeoutMs;
  let latest: unknown = null;
  do {
    latest = await readDocument();
    if (isTerminalImageDocument(latest)) {
      return requireExpectedTerminalImageDocument(latest);
    }
    await delay(pollIntervalMs);
  } while (Date.now() < deadline);
  const status = isRecord(latest) ? String(latest.status ?? 'missing') : 'invalid';
  throw new Error(
    `Timed out waiting for packaged image document terminal state; latest status=${status}.`,
  );
}

async function defaultDelay(durationMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
}
