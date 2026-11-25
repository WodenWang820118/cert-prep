import { setTimeout as delay } from 'node:timers/promises';

import type { Page } from 'playwright';

import { CAPTURE_RUNTIME_VERSION } from '../../../../tools/capture-runtime-version.mts';
import type { ProjectApiRef } from '../packaged-flow-smoke/types.mts';
import { isRecord } from '../packaged-flow-smoke/text-utils.mts';

// The messages the backend stores when a requirement is not ready
// (`capture_integration/application/messages.py`). They are Cert's own text: the
// runtime's requirement detail is logged, never stored.
const PDF_OCR_ERROR =
  'This PDF requires text recognition, which is unavailable in the installed Capture Runtime.';
const IMAGE_OCR_ERROR = 'Text recognition is unavailable in the installed Capture Runtime.';
const AUDIO_ERROR = 'Speech recognition is unavailable in the installed Capture Runtime.';

export interface PublishedRuntimeNegativeCaseEvidence {
  readonly case: 'image' | 'audio' | 'scanned-pdf' | 'mixed-pdf';
  readonly fileName: string;
  readonly operationStatus: 'failed';
  readonly sourceStatus: 'extraction_failed' | 'transcription_failed';
  readonly chunksCount: 0;
  readonly markdownStatus: 409;
  readonly error: string;
}

interface NegativeCaseDefinition {
  readonly case: PublishedRuntimeNegativeCaseEvidence['case'];
  readonly operationId: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly content: Buffer;
  readonly expectedSourceStatus: PublishedRuntimeNegativeCaseEvidence['sourceStatus'];
  readonly expectedError: string;
}

export async function assertPublishedCaptureSurface(page: Page): Promise<void> {
  const workbench = page.locator('capture-workbench');
  const enabledSources = await workbench.evaluate((element) => {
    const config = (
      element as HTMLElement & {
        config?: { enabledSources?: unknown };
      }
    ).config;
    return config?.enabledSources;
  });
  if (
    !Array.isArray(enabledSources) ||
    JSON.stringify(enabledSources) !== JSON.stringify(['pdf', 'image'])
  ) {
    throw new Error(
      `${CAPTURE_RUNTIME_VERSION} host did not expose exactly PDF and image capture.`,
    );
  }
  const copy = await page.locator('main').innerText();
  for (const statement of [
    'PDF and image sources are processed',
    'explicit OCR consent',
    'Recordings are imported on the Questions page.',
  ]) {
    if (!copy.includes(statement)) {
      throw new Error(`${CAPTURE_RUNTIME_VERSION} host copy omitted: ${statement}`);
    }
  }
  if (
    (await page
      .getByRole('button', { name: /Install (Text recognition|Speech recognition)/i })
      .count()) !== 0
  ) {
    throw new Error(
      'Host exposed Capture Runtime setup controls it does not own.',
    );
  }
}

export async function runPublishedRuntimeNegativeDataCases(
  page: Page,
  projectApi: ProjectApiRef,
): Promise<PublishedRuntimeNegativeCaseEvidence[]> {
  const cases: NegativeCaseDefinition[] = [
    {
      case: 'image',
      operationId: 'packaged-negative-image',
      fileName: 'runtime-negative-image.png',
      mediaType: 'image/png',
      content: minimalPng(),
      expectedSourceStatus: 'extraction_failed',
      expectedError: IMAGE_OCR_ERROR,
    },
    {
      case: 'audio',
      operationId: 'packaged-negative-audio',
      fileName: 'runtime-negative-audio.wav',
      mediaType: 'audio/wav',
      content: minimalWav(),
      expectedSourceStatus: 'transcription_failed',
      expectedError: AUDIO_ERROR,
    },
    {
      case: 'scanned-pdf',
      operationId: 'packaged-negative-scanned-pdf',
      fileName: 'runtime-negative-scanned.pdf',
      mediaType: 'application/pdf',
      content: imageOnlyPdf(),
      expectedSourceStatus: 'extraction_failed',
      expectedError: PDF_OCR_ERROR,
    },
    {
      case: 'mixed-pdf',
      operationId: 'packaged-negative-mixed-pdf',
      fileName: 'runtime-negative-mixed.pdf',
      mediaType: 'application/pdf',
      content: mixedTextAndImagePdf(),
      expectedSourceStatus: 'extraction_failed',
      expectedError: PDF_OCR_ERROR,
    },
  ];
  const evidence: PublishedRuntimeNegativeCaseEvidence[] = [];
  for (const definition of cases) {
    evidence.push(await runNegativeCase(page, projectApi, definition));
  }
  return evidence;
}

async function runNegativeCase(
  page: Page,
  projectApi: ProjectApiRef,
  definition: NegativeCaseDefinition,
): Promise<PublishedRuntimeNegativeCaseEvidence> {
  const authHeaders = {
    Authorization: projectApi.authorization,
    'X-Cert-Prep-Operation-Id': definition.operationId,
  };
  const response = await page.request.post(
    `${projectApi.apiBaseUrl}/projects/${encodeURIComponent(
      projectApi.projectId,
    )}/sources`,
    {
      headers: authHeaders,
      multipart: {
        language_hint: 'auto',
        file: {
          name: definition.fileName,
          mimeType: definition.mediaType,
          buffer: definition.content,
        },
      },
      timeout: 120_000,
    },
  );
  const uploaded: unknown = await response.json();
  if (response.status() !== 201 || !isRecord(uploaded)) {
    throw new Error(`${definition.case} upload was not durably accepted.`);
  }
  const sourceId = stringValue(uploaded.id);
  if (!sourceId) {
    throw new Error(`${definition.case} upload omitted its source ID.`);
  }
  const operation = await waitForFailedOperation(
    page,
    projectApi,
    definition.operationId,
  );
  if (operation.error !== definition.expectedError) {
    throw new Error(
      `${definition.case} exposed an unexpected dependency error.`,
    );
  }
  const source = await getJson(
    page,
    `${projectApi.apiBaseUrl}/projects/${encodeURIComponent(
      projectApi.projectId,
    )}/sources/${encodeURIComponent(sourceId)}`,
    projectApi.authorization,
  );
  if (
    source.status !== definition.expectedSourceStatus ||
    source.extraction_method !== 'none' ||
    source.failure_message !== operation.error ||
    source.extraction_warnings !== null ||
    source.chunks_count !== 0
  ) {
    throw new Error(
      `${definition.case} produced a ready or non-empty source.`,
    );
  }
  const chunks = await getJson(
    page,
    `${projectApi.apiBaseUrl}/projects/${encodeURIComponent(
      projectApi.projectId,
    )}/sources/${encodeURIComponent(sourceId)}/chunks`,
    projectApi.authorization,
  );
  if (!Array.isArray(chunks.items) || chunks.items.length !== 0) {
    throw new Error(`${definition.case} produced fallback or fake chunks.`);
  }
  const markdown = await page.request.get(
    `${projectApi.apiBaseUrl}/projects/${encodeURIComponent(
      projectApi.projectId,
    )}/sources/${encodeURIComponent(sourceId)}/markdown`,
    { headers: { Authorization: projectApi.authorization } },
  );
  const markdownError: unknown = await markdown.json();
  if (
    markdown.status() !== 409 ||
    !isRecord(markdownError) ||
    markdownError.code !== 'markdown_unavailable'
  ) {
    throw new Error(`${definition.case} unexpectedly exposed Markdown output.`);
  }
  return {
    case: definition.case,
    fileName: definition.fileName,
    operationStatus: 'failed',
    sourceStatus: definition.expectedSourceStatus,
    chunksCount: 0,
    markdownStatus: 409,
    error: stringValue(operation.error),
  };
}

async function waitForFailedOperation(
  page: Page,
  projectApi: ProjectApiRef,
  operationId: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const operation = await getJson(
      page,
      `${projectApi.apiBaseUrl}/projects/${encodeURIComponent(
        projectApi.projectId,
      )}/source-operations/${encodeURIComponent(operationId)}`,
      projectApi.authorization,
    );
    if (operation.status === 'failed') return operation;
    if (['succeeded', 'canceled'].includes(stringValue(operation.status))) {
      throw new Error(
        `${CAPTURE_RUNTIME_VERSION} negative operation reached ${String(operation.status)}.`,
      );
    }
    await delay(250);
  }
  throw new Error(
    `${CAPTURE_RUNTIME_VERSION} negative operation ${operationId} did not fail in time.`,
  );
}

async function getJson(
  page: Page,
  url: string,
  authorization: string,
): Promise<Record<string, unknown>> {
  const response = await page.request.get(url, {
    headers: { Authorization: authorization },
  });
  const payload: unknown = await response.json();
  if (!response.ok() || !isRecord(payload)) {
    throw new Error(
      `Packaged ${CAPTURE_RUNTIME_VERSION} negative-data API returned an invalid response.`,
    );
  }
  return payload;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function minimalPng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
}

export function minimalWav(): Buffer {
  const sampleRate = 8_000;
  const samples = sampleRate / 10;
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVEfmt ', 8, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

export function imageOnlyPdf(): Buffer {
  return pdfFromObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 3 >>\nstream\n00>\nendstream',
    streamObject('q 100 0 0 100 72 620 cm /Im1 Do Q'),
  ]);
}

export function mixedTextAndImagePdf(): Buffer {
  const text = 'BT /F1 12 Tf 72 720 Td (Embedded text page) Tj ET';
  return pdfFromObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    streamObject(text),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 7 0 R >> >> /Contents 8 0 R >>',
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 3 >>\nstream\n00>\nendstream',
    streamObject('q 100 0 0 100 72 620 cm /Im1 Do Q'),
  ]);
}

function streamObject(stream: string): string {
  return `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
}

function pdfFromObjects(objects: readonly string[]): Buffer {
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join(
      '',
    )}trailer << /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}
