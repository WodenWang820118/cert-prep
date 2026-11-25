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
  readonly sourceCreated: false;
  readonly uploadResponseObserved: false;
}

export interface SourceCancellationProofs {
  readonly ocr: Record<string, unknown>;
  readonly partialDataRemoved: Record<string, unknown>;
  readonly cancelVsCompleteRace: Record<string, unknown>;
  readonly crashRecovery: Record<string, unknown> | null;
}

export interface SourceCancellationOptions {
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

export async function runUploadBeforeSourceIdCancellation(
  transport: JsonTransport,
  projectId: string,
  pdf: FilePayload,
  timeoutMs: number,
): Promise<UploadCancellationProof> {
  const operationId = `upload-${randomUUID()}`;
  const collectionPath = `/projects/${encoded(projectId)}/sources`;
  const operationPath = `/projects/${encoded(projectId)}/source-operations/${encoded(
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
    sourceId: null,
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
    sourceId: null,
    operationId,
    statuses: ['canceled'],
  });
  const uploadResponse = await uploadPromise;
  if (uploadResponse.status === 201) {
    throw new Error(
      'Upload-before-ID cancellation lost the race and created a source.',
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
    sourceCreated: false,
    uploadResponseObserved: false,
  };
}

export async function runSourceCancelRetryScenario({
  transport: initialTransport,
  projectId,
  pdf,
  timeoutMs,
  latePublishObservationWindowMs = 2_000,
  sleepBetweenStableSamples,
  restartAfterCancel,
}: SourceCancellationOptions): Promise<SourceCancellationProofs> {
  if (latePublishObservationWindowMs < 1_000) {
    throw new Error('Late-publish observation window must be at least 1000ms.');
  }
  let transport = initialTransport;
  const initialOperationId = `ocr-${randomUUID()}`;
  const collectionPath = `/projects/${encoded(projectId)}/sources`;
  const uploadBody = requireJsonObject(
    await transport.request('POST', collectionPath, {
      headers: { 'X-Cert-Prep-Operation-Id': initialOperationId },
      multipart: { file: pdf, language_hint: 'ja' },
      timeoutMs,
    }),
    [201],
    'OCR cancellation upload',
  );
  const sourceId = stringField(uploadBody.id, 'upload source id');
  if (uploadBody.project_id !== projectId) {
    throw new Error('Upload response was not bound to the expected project.');
  }
  const sourcePath = `/projects/${encoded(projectId)}/sources/${encoded(sourceId)}`;
  const chunksPath = `${sourcePath}/chunks`;
  const operationPath = `/projects/${encoded(projectId)}/source-operations/${encoded(
    initialOperationId,
  )}`;

  const partialSource = await pollJson(
    transport,
    sourcePath,
    (body) =>
      body.status === 'processing' &&
      typeof body.chunks_count === 'number' &&
      body.chunks_count > 0,
    { timeoutMs, intervalMs: 100, label: 'partial OCR source' },
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
    await transport.request('DELETE', `${sourcePath}/processing`),
    [202],
    'OCR cancellation',
  );
  const cancelResponse = exactOperation(cancelBody, {
    projectId,
    sourceId,
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
      sourceId,
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
        sourceId,
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
    sourceId,
    operationId: initialOperationId,
    statuses: ['canceled'],
  });
  const canceledSource = exactSource(
    requireJsonObject(
      await transport.request('GET', sourcePath),
      [200],
      'canceled OCR source',
    ),
    projectId,
    sourceId,
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
  const storedQuestionsBeforeCancel = numberField(partialSource.question_count, 'question_count');
  assertCanceledSourceIsEmpty(canceledSource, canceledChunks.length);
  if (numberField(canceledSource.question_count, 'question_count') < storedQuestionsBeforeCancel) {
    throw new Error('Canceled OCR lost stored questions.');
  }

  const lateSamples = await stableJsonSamples(
    transport,
    sourcePath,
    2,
    latePublishObservationWindowMs,
    'late-publish OCR source',
    sleepBetweenStableSamples,
  );
  for (const sample of lateSamples) {
    const scoped = exactSource(sample, projectId, sourceId, 'canceled');
    assertCanceledSourceIsEmpty(scoped, 0);
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
    await transport.request('POST', `${sourcePath}/retry`),
    [202],
    'same-source OCR retry',
  );
  const retryOperationId = stringField(retryBody.id, 'retry operation id');
  if (retryOperationId === initialOperationId) {
    throw new Error('OCR retry reused the canceled operation id.');
  }
  const retryResponse = exactOperation(retryBody, {
    projectId,
    sourceId,
    operationId: retryOperationId,
    statuses: ['queued', 'running', 'succeeded'],
  });
  const retryOperationPath = `/projects/${encoded(
    projectId,
  )}/source-operations/${encoded(retryOperationId)}`;
  const retryTerminalResponse = exactOperation(
    await pollJson(
      transport,
      retryOperationPath,
      (body) => body.status === 'succeeded',
      { timeoutMs, label: 'OCR retry terminal operation' },
    ),
    {
      projectId,
      sourceId,
      operationId: retryOperationId,
      statuses: ['succeeded'],
    },
  );
  const readySourceResponse = exactSource(
    await pollJson(
      transport,
      sourcePath,
      (body) => body.status === 'ready',
      { timeoutMs, label: 'same-source OCR retry ready' },
    ),
    projectId,
    sourceId,
    'ready',
  );

  return {
    ocr: {
      projectId,
      sourceId,
      initialOperationId,
      retryOperationId,
      cancelResponse,
      canceledResponse,
      retryResponse,
      retryTerminalResponse,
      readySourceResponse,
      sameSourceRetry: true,
      latePublishSuppressed: true,
      latePublishObservationWindowMs,
    },
    partialDataRemoved: {
      projectId,
      sourceId,
      operationId: initialOperationId,
      beforeCancel: {
        chunksCount: beforeChunks.length,
        nonZeroDerivedMetricCount: nonZeroDerivedMetricCount(partialSource),
        questionCount: storedQuestionsBeforeCancel,
      },
      afterCanceled: canceledSourceMetrics(canceledSource, canceledChunks.length),
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
    readonly sourceId: string | null;
    readonly operationId: string;
    readonly statuses: readonly string[];
  },
): Record<string, unknown> {
  const sanitized = {
    id: stringField(body.id, 'operation id'),
    project_id: stringField(body.project_id, 'operation project id'),
    source_id:
      body.source_id === null
        ? null
        : stringField(body.source_id, 'operation source id'),
    status: stringField(body.status, 'operation status'),
    phase: stringField(body.phase, 'operation phase'),
    cancellable: booleanField(body.cancellable, 'operation cancellable'),
  };
  if (
    sanitized.id !== expected.operationId ||
    sanitized.project_id !== expected.projectId ||
    sanitized.source_id !== expected.sourceId ||
    !expected.statuses.includes(sanitized.status)
  ) {
    throw new Error('Operation response did not match the exact project/source/id scope.');
  }
  return sanitized;
}

function exactSource(
  body: Record<string, unknown>,
  projectId: string,
  sourceId: string,
  status: 'canceled' | 'ready',
): Record<string, unknown> {
  if (
    body.id !== sourceId ||
    body.project_id !== projectId ||
    body.status !== status
  ) {
    throw new Error('Source response did not match the exact expected scope.');
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

function nonZeroDerivedMetricCount(source: Record<string, unknown>): number {
  const values = [
    source.processed_page_count,
  ];
  const count = values.filter(
    (value) => typeof value === 'number' && Number.isFinite(value) && value > 0,
  ).length;
  if (count < 1) {
    throw new Error('Partial OCR response had no non-zero derived metric.');
  }
  return count;
}

function assertCanceledSourceIsEmpty(
  source: Record<string, unknown>,
  chunksEndpointItems: number,
): void {
  const metrics = canceledSourceMetrics(source, chunksEndpointItems);
  if (
    metrics.hasText !== false ||
    Object.entries(metrics).some(
      ([key, value]) => key !== 'hasText' && key !== 'questionCount' && value !== 0,
    )
  ) {
    throw new Error('Canceled OCR retained chunks, text, or derived metrics.');
  }
}

function canceledSourceMetrics(
  source: Record<string, unknown>,
  chunksEndpointItems: number,
): Record<string, unknown> {
  return {
    chunksCount: numberField(source.chunks_count, 'chunks_count'),
    chunksEndpointItems,
    hasText: booleanField(source.has_text, 'has_text'),
    processedPageCount: numberField(
      source.processed_page_count,
      'processed_page_count',
    ),
    questionCount: numberField(source.question_count, 'question_count'),
  };
}
