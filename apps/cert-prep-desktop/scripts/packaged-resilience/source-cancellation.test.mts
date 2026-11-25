import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  FilePayload,
  JsonRequestOptions,
  JsonResponse,
  JsonTransport,
} from './api-client.mts';
import {
  runSourceCancelRetryScenario,
  runUploadBeforeSourceIdCancellation,
} from './source-cancellation.mts';

const pdf: FilePayload = {
  name: 'acceptance.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.7 fixture'),
};

test('upload-before-ID cancellation binds the tombstone and never accepts a source response', async () => {
  const transport = new QueueTransport();
  transport.enqueue('POST', '/projects/project-1/sources', {
    status: 409,
    body: { detail: { code: 'operation_canceled' } },
  });
  transport.fallback = (method, path, options) => {
    const operationId = path.split('/').at(-1) ?? '';
    if (method === 'DELETE') {
      assert.equal(options?.headers, undefined);
      return response(
        202,
        operation(operationId, 'cancel_requested', 'canceling', false, null),
      );
    }
    if (method === 'GET') {
      return response(
        200,
        operation(operationId, 'canceled', 'canceled', false, null),
      );
    }
    throw new Error(`Unexpected ${method} ${path}`);
  };

  const proof = await runUploadBeforeSourceIdCancellation(
    transport,
    'project-1',
    pdf,
    1_000,
  );
  assert.equal(proof.sourceCreated, false);
  assert.equal(proof.terminalResponse.status, 'canceled');
  const upload = transport.calls.find((call) => call.method === 'POST');
  assert.match(
    upload?.options?.headers?.['X-Cert-Prep-Operation-Id'] ?? '',
    /^upload-/,
  );
});

test('OCR scenario proves partial cleanup, stable canceled state, distinct retry, and same-source ready', async () => {
  const transport = sourceScenarioTransport();
  const result = await runSourceCancelRetryScenario({
    transport,
    projectId: 'project-1',
    pdf,
    timeoutMs: 2_000,
    latePublishObservationWindowMs: 1_000,
    sleepBetweenStableSamples: () => Promise.resolve(),
  });

  assert.equal(result.ocr.initialOperationId === result.ocr.retryOperationId, false);
  assert.deepEqual(result.ocr.retryTerminalResponse, {
    id: 'retry-operation',
    project_id: 'project-1',
    source_id: 'source-1',
    status: 'succeeded',
    phase: 'completed',
    cancellable: false,
  });
  assert.equal(
    (result.ocr.readySourceResponse as Record<string, unknown>).id,
    'source-1',
  );
  assert.deepEqual(
    (result.partialDataRemoved.afterCanceled as Record<string, unknown>)
      .chunksCount,
    0,
  );
  assert.equal(
    (result.partialDataRemoved.afterCanceled as Record<string, unknown>)
      .questionCount,
    1,
  );
  assert.deepEqual(result.cancelVsCompleteRace.lateTerminalStatuses, [
    'canceled',
    'canceled',
  ]);
  assert.equal(result.crashRecovery, null);
});

test('OCR scenario rejects a response from another project before producing evidence', async () => {
  const transport = sourceScenarioTransport();
  transport.replaceFirst('POST', '/projects/project-1/sources', {
    status: 201,
    body: { id: 'source-1', project_id: 'project-other' },
  });
  await assert.rejects(
    () =>
      runSourceCancelRetryScenario({
        transport,
        projectId: 'project-1',
        pdf,
        timeoutMs: 1_000,
        sleepBetweenStableSamples: () => Promise.resolve(),
      }),
    /not bound to the expected project/,
  );
});

function sourceScenarioTransport(): QueueTransport {
  const transport = new QueueTransport();
  const sourcePath = '/projects/project-1/sources/source-1';
  const initialOperationPattern = /\/source-operations\/ocr-/;

  transport.enqueue('POST', '/projects/project-1/sources', {
    status: 201,
    body: { id: 'source-1', project_id: 'project-1' },
  });
  transport.enqueueMany('GET', sourcePath, [
    response(200, source('processing', 2, true)),
    response(200, source('canceled', 0, false)),
    response(200, source('canceled', 0, false)),
    response(200, source('canceled', 0, false)),
    response(200, source('ready', 4, true)),
  ]);
  transport.enqueueMany('GET', `${sourcePath}/chunks`, [
    response(200, { items: [{ id: 'chunk-1' }, { id: 'chunk-2' }] }),
    response(200, { items: [] }),
  ]);
  transport.enqueue('DELETE', `${sourcePath}/processing`, {
    status: 202,
    body: operation(
      '__INITIAL__',
      'cancel_requested',
      'canceling',
      false,
      'source-1',
    ),
  });
  transport.enqueue('POST', `${sourcePath}/retry`, {
    status: 202,
    body: operation('retry-operation', 'running', 'ocr', true, 'source-1'),
  });
  transport.enqueue(
    'GET',
    '/projects/project-1/source-operations/retry-operation',
    response(
      200,
      operation(
        'retry-operation',
        'succeeded',
        'completed',
        false,
        'source-1',
      ),
    ),
  );
  let initialOperationId = '';
  let initialGetCount = 0;
  transport.transform = (method, path, value) => {
    if (method === 'POST' && path === '/projects/project-1/sources') {
      const call = transport.calls.at(-1);
      initialOperationId =
        call?.options?.headers?.['X-Cert-Prep-Operation-Id'] ?? '';
    }
    if (
      (method === 'DELETE' && path === `${sourcePath}/processing`) ||
      (method === 'GET' && initialOperationPattern.test(path))
    ) {
      const body = value.body as Record<string, unknown>;
      value = { ...value, body: { ...body, id: initialOperationId } };
    }
    if (method === 'GET' && initialOperationPattern.test(path)) {
      initialGetCount += 1;
      const status = initialGetCount === 1 ? 'cancel_requested' : 'canceled';
      value = {
        status: 200,
        body: operation(
          initialOperationId,
          status,
          status === 'canceled' ? 'canceled' : 'canceling',
          false,
          'source-1',
        ),
      };
    }
    return value;
  };
  transport.fallback = (method, path) => {
    if (method === 'GET' && initialOperationPattern.test(path)) {
      initialGetCount += 1;
      return response(
        200,
        operation(initialOperationId, 'canceled', 'canceled', false, 'source-1'),
      );
    }
    throw new Error(`Unexpected ${method} ${path}`);
  };
  return transport;
}

function operation(
  id: string,
  status: string,
  phase: string,
  cancellable: boolean,
  sourceId: string | null,
): Record<string, unknown> {
  return {
    id,
    project_id: 'project-1',
    source_id: sourceId,
    status,
    phase,
    cancellable,
  };
}

function source(
  status: 'processing' | 'canceled' | 'ready',
  chunks: number,
  hasText: boolean,
): Record<string, unknown> {
  const partial = status === 'processing' ? 10 : 0;
  return {
    id: 'source-1',
    project_id: 'project-1',
    status,
    chunks_count: chunks,
    has_text: hasText,
    processed_page_count: partial,
    question_count: 1,
  };
}

function response(status: number, body: unknown): JsonResponse {
  return { status, body };
}

interface RecordedCall {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly path: string;
  readonly options?: JsonRequestOptions;
}

class QueueTransport implements JsonTransport {
  readonly calls: RecordedCall[] = [];
  fallback: (
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    options?: JsonRequestOptions,
  ) => JsonResponse = (method, path) => {
    throw new Error(`No response queued for ${method} ${path}`);
  };
  transform: (
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    value: JsonResponse,
  ) => JsonResponse = (_method, _path, value) => value;
  private readonly responses = new Map<string, JsonResponse[]>();

  enqueue(
    method: RecordedCall['method'],
    path: string,
    value: JsonResponse,
  ): void {
    this.enqueueMany(method, path, [value]);
  }

  enqueueMany(
    method: RecordedCall['method'],
    path: string,
    values: JsonResponse[],
  ): void {
    this.responses.set(`${method} ${path}`, values);
  }

  replaceFirst(
    method: RecordedCall['method'],
    path: string,
    value: JsonResponse,
  ): void {
    const key = `${method} ${path}`;
    const values = this.responses.get(key) ?? [];
    this.responses.set(key, [value, ...values.slice(1)]);
  }

  async request(
    method: RecordedCall['method'],
    path: string,
    options?: JsonRequestOptions,
  ): Promise<JsonResponse> {
    this.calls.push({ method, path, options });
    const key = `${method} ${path}`;
    const queued = this.responses.get(key);
    const value = queued?.shift() ?? this.fallback(method, path, options);
    return this.transform(method, path, value);
  }
}
