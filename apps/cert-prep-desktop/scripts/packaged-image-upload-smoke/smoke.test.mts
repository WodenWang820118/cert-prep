import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { parsePackagedImageUploadSmokeArgs } from './args.mts';
import {
  PACKAGED_STATIC_IMAGE_FILENAME,
  PACKAGED_STATIC_IMAGE_HEIGHT,
  PACKAGED_STATIC_IMAGE_SHA256,
  PACKAGED_STATIC_IMAGE_WIDTH,
  packagedStaticImage,
  requireExpectedTerminalImageDocument,
  waitForExpectedTerminalImageDocument,
} from './image-contract.mts';

test('packaged image fixture is a deterministic static 256x128 PNG', () => {
  const image = packagedStaticImage();

  assert.deepEqual(
    image.subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  assert.equal(image.toString('ascii', 12, 16), 'IHDR');
  assert.equal(image.readUInt32BE(16), PACKAGED_STATIC_IMAGE_WIDTH);
  assert.equal(image.readUInt32BE(20), PACKAGED_STATIC_IMAGE_HEIGHT);
  assert.equal(image.includes(Buffer.from('acTL')), false);
  assert.equal(
    createHash('sha256').update(image).digest('hex'),
    PACKAGED_STATIC_IMAGE_SHA256,
  );
  assert.equal(
    PACKAGED_STATIC_IMAGE_SHA256,
    'bf40647f858fcb370007296dfe92b924db6494aec8959f7e1b02f6fea3110444',
  );
});

test('terminal image evidence requires one fully processed no-text page', () => {
  const document = terminalDocument();

  assert.deepEqual(requireExpectedTerminalImageDocument(document), document);
  assert.throws(
    () =>
      requireExpectedTerminalImageDocument({
        ...document,
        processed_page_count: 0,
      }),
    /processed_page_count expected 1/,
  );
  assert.throws(
    () =>
      requireExpectedTerminalImageDocument({
        ...document,
        status: 'ocr_failed',
      }),
    /status expected no_text_detected/,
  );
  assert.throws(
    () =>
      requireExpectedTerminalImageDocument({
        ...document,
        ocr_device: null,
      }),
    /did not report the OCR device/,
  );
});

test('terminal image polling waits through processing and validates evidence', async () => {
  const responses: unknown[] = [
    { status: 'processing' },
    terminalDocument(),
  ];
  let reads = 0;

  const document = await waitForExpectedTerminalImageDocument(
    async () => responses[reads++] ?? responses.at(-1),
    { timeoutMs: 1_000, delay: async () => undefined },
  );

  assert.equal(reads, 2);
  assert.equal(document.page_count, 1);
  assert.equal(document.processed_page_count, 1);
});

test('packaged image CLI keeps fresh app data beside timestamped evidence', () => {
  const parsed = parsePackagedImageUploadSmokeArgs(
    [
      '--out-root',
      'tmp/image-smoke',
      '--cdp-port',
      '9556',
      '--timeout-ms',
      '1234',
    ],
    'C:\\workspace',
    () => new Date('2026-07-17T12:34:56.000Z'),
  );

  assert.match(
    parsed.outDir,
    /tmp[\\/]image-smoke[\\/]2026-07-17T12-34-56-000Z$/,
  );
  assert.equal(parsed.appDataDir, `${parsed.outDir}\\app-data`);
  assert.equal(parsed.cdpPort, 9556);
  assert.equal(parsed.timeoutMs, 1234);
  assert.throws(
    () => parsePackagedImageUploadSmokeArgs(['--timeout-ms', '0']),
    /positive integer/,
  );
});

test('desktop project exposes a packaged static-image acceptance target', () => {
  const project = JSON.parse(
    readFileSync(new URL('../../project.json', import.meta.url), 'utf8'),
  ) as {
    targets?: Record<
      string,
      {
        dependsOn?: string[];
        options?: {
          command?: string;
          env?: Record<string, string>;
        };
      }
    >;
  };
  const target = project.targets?.['packaged-image-upload-smoke'];

  assert.deepEqual(target?.dependsOn, ['build-windowsml-dev']);
  assert.equal(
    target?.options?.command,
    'node apps/cert-prep-desktop/scripts/packaged-image-upload-smoke.mts',
  );
  assert.equal(
    target?.options?.env?.CERT_PREP_ALLOW_LOCAL_OCR_RUNTIME_URL,
    'true',
  );
});

function terminalDocument(): Record<string, unknown> {
  return {
    id: 'document-1',
    project_id: 'project-1',
    filename: PACKAGED_STATIC_IMAGE_FILENAME,
    sha256: PACKAGED_STATIC_IMAGE_SHA256,
    status: 'no_text_detected',
    page_count: 1,
    processed_page_count: 1,
    has_text: false,
    chunks_count: 0,
    extraction_method: 'none',
    ocr_device: 'cpu',
    ocr_fallback_reason: null,
  };
}
