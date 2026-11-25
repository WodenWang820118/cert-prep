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
  'extraction_failed',
  'canceled',
]);

export interface PackagedImageSourceEvidence {
  readonly id: string;
  readonly project_id: string;
  readonly filename: string;
  readonly sha256: string;
  readonly status: 'no_text_detected' | 'ready';
  readonly page_count: 1;
  readonly processed_page_count: 1;
  readonly has_text: boolean;
  readonly chunks_count: number;
  readonly extraction_method: string;
  readonly ocr_device: string;
  readonly extraction_warnings: string | null;
  readonly failure_message: string | null;
  readonly source_kind?: string;
}

export interface PackagedOcrImageExpectation {
  readonly filename: string;
  readonly sha256: string;
}

export function packagedStaticImage(): Buffer {
  return Buffer.from(PACKAGED_STATIC_IMAGE_BYTES);
}

export function isTerminalImageSource(payload: unknown): boolean {
  return (
    isRecord(payload) &&
    typeof payload.status === 'string' &&
    TERMINAL_STATUSES.has(payload.status)
  );
}

export function requireExpectedTerminalImageSource(
  payload: unknown,
): PackagedImageSourceEvidence {
  if (!isRecord(payload)) {
    throw new Error('Packaged image source response was not a JSON object.');
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
        `Packaged image source ${field} expected ${String(value)} but received ${String(payload[field])}.`,
      );
    }
  }
  if (typeof payload.id !== 'string' || payload.id.length === 0) {
    throw new Error('Packaged image source id was missing.');
  }
  if (typeof payload.project_id !== 'string' || payload.project_id.length === 0) {
    throw new Error('Packaged image source project_id was missing.');
  }
  if (
    typeof payload.ocr_device !== 'string' ||
    payload.ocr_device.trim().length === 0
  ) {
    throw new Error(
      'Packaged image source did not report the OCR device that processed the PNG.',
    );
  }
  if (
    payload.extraction_warnings !== null &&
    typeof payload.extraction_warnings !== 'string'
  ) {
    throw new Error('Packaged image source extraction_warnings was invalid.');
  }
  if (payload.failure_message !== null && typeof payload.failure_message !== 'string') {
    throw new Error('Packaged image source failure_message was invalid.');
  }
  return payload as unknown as PackagedImageSourceEvidence;
}

export function requireExpectedOcrImageSource(
  payload: unknown,
  expectation: PackagedOcrImageExpectation,
): PackagedImageSourceEvidence {
  if (!isRecord(payload)) {
    throw new Error('Packaged OCR image source response was not a JSON object.');
  }
  const fields: Readonly<Record<string, unknown>> = {
    filename: expectation.filename,
    sha256: expectation.sha256,
    status: 'ready',
    page_count: 1,
    processed_page_count: 1,
    has_text: true,
    extraction_method: 'text_recognition',
    failure_message: null,
  };
  for (const [field, value] of Object.entries(fields)) {
    if (payload[field] !== value) {
      throw new Error(
        `Packaged OCR image source ${field} expected ${String(value)} but received ${String(payload[field])}.`,
      );
    }
  }
  if (typeof payload.chunks_count !== 'number' || payload.chunks_count < 1) {
    throw new Error('Packaged OCR image source must contain at least one text chunk.');
  }
  if (typeof payload.id !== 'string' || payload.id.length === 0) {
    throw new Error('Packaged OCR image source id was missing.');
  }
  if (typeof payload.project_id !== 'string' || payload.project_id.length === 0) {
    throw new Error('Packaged OCR image source project_id was missing.');
  }
  if (payload.source_kind !== 'image') {
    throw new Error(
      `Packaged OCR image source_kind expected image but received ${String(payload.source_kind)}.`,
    );
  }
  // Capture 0.11.0 reports text recognition on DirectML or CPU.
  if (payload.ocr_device !== 'directml' && payload.ocr_device !== 'cpu') {
    throw new Error(
      `Packaged OCR image source OCR device expected directml or cpu but received ${String(payload.ocr_device)}.`,
    );
  }
  if (
    payload.extraction_warnings !== null &&
    typeof payload.extraction_warnings !== 'string'
  ) {
    throw new Error('Packaged OCR image source extraction_warnings was invalid.');
  }
  return payload as unknown as PackagedImageSourceEvidence;
}

export async function waitForExpectedTerminalImageSource(
  readSource: () => Promise<unknown>,
  {
    timeoutMs,
    pollIntervalMs = 500,
    delay = defaultDelay,
  }: {
    readonly timeoutMs: number;
    readonly pollIntervalMs?: number;
    readonly delay?: (durationMs: number) => Promise<void>;
  },
): Promise<PackagedImageSourceEvidence> {
  const deadline = Date.now() + timeoutMs;
  let latest: unknown = null;
  do {
    latest = await readSource();
    if (isTerminalImageSource(latest)) {
      return requireExpectedTerminalImageSource(latest);
    }
    await delay(pollIntervalMs);
  } while (Date.now() < deadline);
  const status = isRecord(latest) ? String(latest.status ?? 'missing') : 'invalid';
  throw new Error(
    `Timed out waiting for packaged image source terminal state; latest status=${status}.`,
  );
}

export async function waitForExpectedOcrImageSource(
  readSource: () => Promise<unknown>,
  {
    timeoutMs,
    pollIntervalMs = 500,
    delay = defaultDelay,
    expectation,
  }: {
    readonly timeoutMs: number;
    readonly pollIntervalMs?: number;
    readonly delay?: (durationMs: number) => Promise<void>;
    readonly expectation: PackagedOcrImageExpectation;
  },
): Promise<PackagedImageSourceEvidence> {
  const deadline = Date.now() + timeoutMs;
  let latest: unknown = null;
  do {
    latest = await readSource();
    if (isRecord(latest) && latest.status === 'ready') {
      return requireExpectedOcrImageSource(latest, expectation);
    }
    if (
      isRecord(latest) &&
      ['extraction_failed', 'canceled', 'no_text_detected'].includes(String(latest.status))
    ) {
      throw new Error(
        `Packaged OCR image source ended as ${String(latest.status)}.`,
      );
    }
    await delay(pollIntervalMs);
  } while (Date.now() < deadline);
  const status = isRecord(latest) ? String(latest.status ?? 'missing') : 'invalid';
  throw new Error(
    `Timed out waiting for packaged OCR image source terminal state; latest status=${status}.`,
  );
}

async function defaultDelay(durationMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
}
