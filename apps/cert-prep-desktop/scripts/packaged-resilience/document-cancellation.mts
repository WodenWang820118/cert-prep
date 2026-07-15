import { randomUUID } from 'node:crypto';

import type {
  FilePayload,
  JsonTransport,
} from './api-client.mts';
import { requireJsonObject } from './api-client.mts';
import {
  booleanField,
  encoded,
  numberField,
  pollJson,
  stableJsonSamples,
  stringField,
} from './scenario-utils.mts';

export interface UploadCancellationProof {
  readonly projectId: string;
  readonly operationId: string;
  readonly cancelResponse: Record<string, unknown>;
  readonly terminalResponse: Record<string, unknown>;
  readonly documentCreated: false;
  readonly uploadResponseObserved: false;
}

export interface DocumentCancellationProofs {
  readonly ocr: Record<string, unknown>;
  readonly partialDataRemoved: Record<string, unknown>;
  readonly cancelVsCompleteRace: Record<string, unknown>;
  readonly crashRecovery: Record<string, unknown> | null;
}

export interface DocumentCancellationOptions {
  readonly transport: JsonTransport;
  readonly projectId: string;
  readonly pdf: FilePayload;
  readonly timeoutMs: number;
  readonly latePublishObservationWindowMs?: number;
  readonly sleepBetweenStableSamples?: (
    milliseconds: number,
  ) => Promise<unknown>;
  readonly restartAfterCancel?: (
    beforeCrash: Readonly<Record<string, unknown>>,
  ) => Promise<JsonTransport>;
}

export async function runUploadBeforeDocumentIdCancellation(
  transport: JsonTransport,
  projectId: string,
  pdf: FilePayload,
  timeoutMs: number,
): Promise<UploadCancellationProof> {
  const operationId = `upload-${randomUUID()}`;
  const collectionPath = `/projects/${encoded(projectId)}/documents`;
  const operationPath = `/projects/${encoded(projectId)}/document-operations/${encoded(
    operationId,
  )}`;
  const uploadPromise = transport.request('POST', collectionPath, {
    headers: { 'X-Cert-Prep-Operation-Id': operationId },
    multipart: { file: pdf, language_hint: 'ja' },
    timeoutMs,
  });
  const cancelBody = requireJsonObject(
    await transport.request('DELETE', operationPath),
    [202],
    'upload-before-ID cancellation',
  );
  const cancelResponse = exactOperation(cancelBody, {
    projectId,
    documentId: null,
    operationId,
    statuses: ['cancel_requested', 'canceled'],
  });
  const terminalBody = await pollJson(
    transport,
    operationPath,
    (body) => body.status === 'canceled',
    { timeoutMs, label: 'upload-before-ID terminal operation' },
  );
  const terminalResponse = exactOperation(terminalBody, {
    projectId,
    documentId: null,
    operationId,
    statuses: ['canceled'],
  });
  const uploadResponse = await uploadPromise;
  if (uploadResponse.status === 201) {
    throw new Error(
      'Upload-before-ID cancellation lost the race and created a document.',
    );
  }
  if (uploadResponse.status !== 409) {
    throw new Error(
      `Canceled upload returned unexpected HTTP ${uploadResponse.status}.`,
    );
  }
  return {
    projectId,
    operationId,
    cancelResponse,
    terminalResponse,
    documentCreated: false,
    uploadResponseObserved: false,
  };
}

export async function runDocumentCancelRetryScenario({
  transport: initialTransport,
  projectId,
  pdf,
  timeoutMs,
  latePublishObservationWindowMs = 2_000,
  sleepBetweenStableSamples,
  restartAfterCancel,
}: DocumentCancellationOptions): Promise<DocumentCancellationProofs> {
  if (latePublishObservationWindowMs < 1_000) {
    throw new Error('Late-publish observation window must be at least 1000ms.');
  }
  let transport = initialTransport;
  const initialOperationId = `ocr-${randomUUID()}`;
  const collectionPath = `/projects/${encoded(projectId)}/documents`;
  const uploadBody = requireJsonObject(
    await transport.request('POST', collectionPath, {
      headers: { 'X-Cert-Prep-Operation-Id': initialOperationId },
      multipart: { file: pdf, language_hint: 'ja' },
      timeoutMs,
    }),
    [201],
    'OCR cancellation upload',
  );
  const documentId = stringField(uploadBody.id, 'upload document id');
  if (uploadBody.project_id !== projectId) {
    throw new Error('Upload response was not bound to the expected project.');
  }
  const documentPath = `/projects/${encoded(projectId)}/documents/${encoded(documentId)}`;
  const chunksPath = `${documentPath}/chunks`;
  const operationPath = `/projects/${encoded(projectId)}/document-operations/${encoded(
    initialOperationId,
  )}`;

  const partialDocument = await pollJson(
    transport,
    documentPath,
    (body) =>
      body.status === 'processing' &&
      typeof body.chunks_count === 'number' &&
      body.chunks_count > 0,
    { timeoutMs, intervalMs: 100, label: 'partial OCR document' },
  );
  const beforeChunks = requireItems(
    requireJsonObject(
      await transport.request('GET', chunksPath),
      [200],
      'partial OCR chunks',
    ),
    'partial OCR chunks',
  );
  if (beforeChunks.length < 1) {
    throw new Error('OCR cancellation did not observe real partial chunks.');
  }

  const cancelBody = requireJsonObject(
    await transport.request('DELETE', `${documentPath}/processing`),
    [202],
    'OCR cancellation',
  );
  const cancelResponse = exactOperation(cancelBody, {
    projectId,
    documentId,
    operationId: initialOperationId,
    statuses: ['cancel_requested', 'canceled'],
  });
  const beforeCrashResponse = exactOperation(
    requireJsonObject(
      await transport.request('GET', operationPath),
      [200],
      'pre-crash operation',
    ),
    {
      projectId,
      documentId,
      operationId: initialOperationId,
      statuses: ['running', 'cancel_requested', 'canceled'],
    },
  );

  let afterRestartResponse: Record<string, unknown> | null = null;
  if (restartAfterCancel) {
    transport = await restartAfterCancel(beforeCrashResponse);
    afterRestartResponse = exactOperation(
      requireJsonObject(
        await transport.request('GET', operationPath),
        [200],
        'post-restart operation',
      ),
      {
        projectId,
        documentId,
        operationId: initialOperationId,
        statuses: ['cancel_requested', 'canceled'],
      },
    );
  }

  const canceledBody = await pollJson(
    transport,
    operationPath,
    (body) => body.status === 'canceled',
    { timeoutMs, label: 'canceled OCR operation' },
  );
  const canceledResponse = exactOperation(canceledBody, {
    projectId,
    documentId,
    operationId: initialOperationId,
    statuses: ['canceled'],
  });
  const canceledDocument = exactDocument(
    requireJsonObject(
      await transport.request('GET', documentPath),
      [200],
      'canceled OCR document',
    ),
    projectId,
    documentId,
    'canceled',
  );
  const canceledChunks = requireItems(
    requireJsonObject(
      await transport.request('GET', chunksPath),
      [200],
      'canceled OCR chunks',
    ),
    'canceled OCR chunks',
  );
  assertCanceledDocumentIsEmpty(canceledDocument, canceledChunks.length);

  const lateSamples = await stableJsonSamples(
    transport,
    documentPath,
    2,
    latePublishObservationWindowMs,
    'late-publish OCR document',
    sleepBetweenStableSamples,
  );
  for (const sample of lateSamples) {
    const scoped = exactDocument(sample, projectId, documentId, 'canceled');
    assertCanceledDocumentIsEmpty(scoped, 0);
  }
  const raceSamples = await stableJsonSamples(
    transport,
    operationPath,
    2,
    100,
    'stable OCR terminal operation',
    sleepBetweenStableSamples,
  );
  const lateTerminalStatuses = raceSamples.map((sample) =>
    stringField(sample.status, 'late terminal status'),
  );
  if (!lateTerminalStatuses.every((status) => status === 'canceled')) {
    throw new Error('OCR terminal state changed after cancellation won.');
  }

  const retryBody = requireJsonObject(
    await transport.request('POST', `${documentPath}/retry`),
    [202],
    'same-document OCR retry',
  );
  const retryOperationId = stringField(retryBody.id, 'retry operation id');
  if (retryOperationId === initialOperationId) {
    throw new Error('OCR retry reused the canceled operation id.');
  }
  const retryResponse = exactOperation(retryBody, {
    projectId,
    documentId,
    operationId: retryOperationId,
    statuses: ['queued', 'running', 'succeeded'],
  });
  const retryOperationPath = `/projects/${encoded(
    projectId,
  )}/document-operations/${encoded(retryOperationId)}`;
  const retryTerminalResponse = exactOperation(
    await pollJson(
      transport,
      retryOperationPath,
      (body) => body.status === 'succeeded',
      { timeoutMs, label: 'OCR retry terminal operation' },
    ),
    {
      projectId,
      documentId,
      operationId: retryOperationId,
      statuses: ['succeeded'],
    },
  );
  const readyDocumentResponse = exactDocument(
    await pollJson(
      transport,
      documentPath,
      (body) => body.status === 'ready',
      { timeoutMs, label: 'same-document OCR retry ready' },
    ),
    projectId,
    documentId,
    'ready',
  );

  return {
    ocr: {
      projectId,
      documentId,
      initialOperationId,
      retryOperationId,
      cancelResponse,
      canceledResponse,
      retryResponse,
      retryTerminalResponse,
      readyDocumentResponse,
      sameDocumentRetry: true,
      latePublishSuppressed: true,
      latePublishObservationWindowMs,
    },
    partialDataRemoved: {
      projectId,
      documentId,
      operationId: initialOperationId,
      beforeCancel: {
        chunksCount: beforeChunks.length,
        nonZeroDerivedMetricCount: nonZeroDerivedMetricCount(partialDocument),
      },
      afterCanceled: canceledDocumentMetrics(canceledDocument, canceledChunks.length),
      originalPdfRetryable: true,
      latePublishSuppressed: true,
      latePublishObservationWindowMs,
    },
    cancelVsCompleteRace: {
      operationId: initialOperationId,
      winner: 'canceled',
      cancelHttpStatus: 202,
      terminalResponse: canceledResponse,
      terminalStateStable: true,
      lateTerminalStatuses,
    },
    crashRecovery:
      afterRestartResponse === null
        ? null
        : {
            operationId: initialOperationId,
            beforeCrashResponse,
            afterRestartResponse,
            terminalResponse: canceledResponse,
            sameOperationId: true,
            restartCount: 1,
          },
  };
}

function exactOperation(
  body: Record<string, unknown>,
  expected: {
    readonly projectId: string;
    readonly documentId: string | null;
    readonly operationId: string;
    readonly statuses: readonly string[];
  },
): Record<string, unknown> {
  const sanitized = {
    id: stringField(body.id, 'operation id'),
    project_id: stringField(body.project_id, 'operation project id'),
    document_id:
      body.document_id === null
        ? null
        : stringField(body.document_id, 'operation document id'),
    status: stringField(body.status, 'operation status'),
    phase: stringField(body.phase, 'operation phase'),
    cancellable: booleanField(body.cancellable, 'operation cancellable'),
  };
  if (
    sanitized.id !== expected.operationId ||
    sanitized.project_id !== expected.projectId ||
    sanitized.document_id !== expected.documentId ||
    !expected.statuses.includes(sanitized.status)
  ) {
    throw new Error('Operation response did not match the exact project/document/id scope.');
  }
  return sanitized;
}

function exactDocument(
  body: Record<string, unknown>,
  projectId: string,
  documentId: string,
  status: 'canceled' | 'ready',
): Record<string, unknown> {
  if (
    body.id !== documentId ||
    body.project_id !== projectId ||
    body.status !== status
  ) {
    throw new Error('Document response did not match the exact expected scope.');
  }
  return body;
}

function requireItems(
  body: Record<string, unknown>,
  label: string,
): unknown[] {
  if (!Array.isArray(body.items)) {
    throw new Error(`${label} did not return an items array.`);
  }
  return body.items;
}

function nonZeroDerivedMetricCount(document: Record<string, unknown>): number {
  const values = [
    document.processed_page_count,
    document.ocr_duration_ms,
    document.parse_wall_duration_ms,
    document.render_duration_ms,
    document.ocr_engine_duration_ms,
    document.first_chunk_ms,
    document.exam_item_count,
  ];
  const count = values.filter(
    (value) => typeof value === 'number' && Number.isFinite(value) && value > 0,
  ).length;
  if (count < 1) {
    throw new Error('Partial OCR response had no non-zero derived metric.');
  }
  return count;
}

function assertCanceledDocumentIsEmpty(
  document: Record<string, unknown>,
  chunksEndpointItems: number,
): void {
  const metrics = canceledDocumentMetrics(document, chunksEndpointItems);
  if (
    metrics.hasText !== false ||
    Object.entries(metrics).some(
      ([key, value]) => key !== 'hasText' && value !== 0,
    )
  ) {
    throw new Error('Canceled OCR retained chunks, text, or derived metrics.');
  }
}

function canceledDocumentMetrics(
  document: Record<string, unknown>,
  chunksEndpointItems: number,
): Record<string, unknown> {
  return {
    chunksCount: numberField(document.chunks_count, 'chunks_count'),
    chunksEndpointItems,
    hasText: booleanField(document.has_text, 'has_text'),
    processedPageCount: numberField(
      document.processed_page_count,
      'processed_page_count',
    ),
    ocrDurationMs: numberField(document.ocr_duration_ms, 'ocr_duration_ms'),
    parseWallDurationMs: numberField(
      document.parse_wall_duration_ms,
      'parse_wall_duration_ms',
    ),
    renderDurationMs: numberField(
      document.render_duration_ms,
      'render_duration_ms',
    ),
    ocrEngineDurationMs: numberField(
      document.ocr_engine_duration_ms,
      'ocr_engine_duration_ms',
    ),
    firstChunkMs: numberField(document.first_chunk_ms, 'first_chunk_ms'),
    examItemCount: numberField(document.exam_item_count, 'exam_item_count'),
  };
}
