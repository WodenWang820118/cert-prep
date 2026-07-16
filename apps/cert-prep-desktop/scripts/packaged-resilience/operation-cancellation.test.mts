import assert from 'node:assert/strict';
import test from 'node:test';

import type { JsonResponse, JsonTransport } from './api-client.mts';
import {
  runCancelableOperationScenario,
  type CancelableOperationScenario,
} from './operation-cancellation.mts';

interface ScriptedRequest {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly path: string;
  readonly response: JsonResponse;
}

class ScriptedTransport implements JsonTransport {
  readonly #requests: ScriptedRequest[];
  #index = 0;

  constructor(requests: readonly ScriptedRequest[]) {
    this.#requests = [...requests];
  }

  async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
  ): Promise<JsonResponse> {
    const request = this.#requests[this.#index];
    assert.ok(request, `Unexpected ${method} ${path}.`);
    assert.equal(method, request.method);
    assert.equal(path, request.path);
    this.#index += 1;
    return request.response;
  }

  assertConsumed(): void {
    assert.equal(this.#index, this.#requests.length);
  }
}

test('records a live committing draft response and exact 409 rejection', async () => {
  const scenario: CancelableOperationScenario = {
    kind: 'draft',
    startPath: '/projects/project-1/documents/document-1/draft-operations',
    operationPath: (operationId) =>
      `/projects/project-1/documents/document-1/draft-operations/${operationId}`,
    startData: { limit: 5 },
    projectId: 'project-1',
    documentId: 'document-1',
    provider: 'fake',
    model: 'fixture-draft-model',
    timeoutMs: 1_000,
  };
  const scope = {
    project_id: scenario.projectId,
    document_id: scenario.documentId,
    provider: scenario.provider,
    model: scenario.model,
  };
  const observedResponse = operation(
    'commit-operation',
    'running',
    'committing',
    false,
    scope,
    '2026-07-14T00:00:05.000Z',
  );
  const rejectionResponse = {
    status: 409,
    body: {
      code: 'operation_not_cancellable',
      message: 'The operation has already started committing.',
    },
  } satisfies JsonResponse;
  const transport = new ScriptedTransport(
    successfulRequests(scenario, scope, observedResponse, rejectionResponse),
  );

  const proof = await runCancelableOperationScenario(transport, scenario);

  assert.deepEqual(
    {
      projectId: proof.projectId,
      documentId: proof.documentId,
      provider: proof.provider,
      model: proof.model,
    },
    {
      projectId: scenario.projectId,
      documentId: scenario.documentId,
      provider: scenario.provider,
      model: scenario.model,
    },
  );
  const nonCancellable = proof.nonCancellableResponse as Record<
    string,
    unknown
  >;
  assert.equal(nonCancellable.operationId, 'commit-operation');
  assert.equal(nonCancellable.commitStartedAt, '2026-07-14T00:00:05.000Z');
  assert.strictEqual(nonCancellable.observedResponse, observedResponse);
  assert.strictEqual(nonCancellable.rejectionResponse, rejectionResponse);
  transport.assertConsumed();
});

test('proves canceled state before starting the non-cancellable commit probe', async () => {
  let transport: ScriptedTransport | null = null;
  const scenario: CancelableOperationScenario = {
    kind: 'model',
    startPath: '/llm/model-downloads',
    operationPath: (operationId) => `/llm/model-downloads/${operationId}`,
    provider: 'ollama',
    model: 'qwen3.5:4b',
    timeoutMs: 1_000,
    afterCanceled: async (terminalResponse) => {
      assert.equal(terminalResponse.status, 'canceled');
      assert.ok(transport);
      const clean = await transport.request('GET', '/isolated-ollama/clean');
      assert.deepEqual(clean.body, { modelNames: [] });
      return {
        observationWindowMs: 1_000,
        immediate: clean.body as Record<string, unknown>,
        afterWindow: clean.body as Record<string, unknown>,
      };
    },
  };
  const scope = { provider: scenario.provider, model: scenario.model };
  const observedResponse = operation(
    'commit-operation',
    'running',
    'committing',
    false,
    scope,
    '2026-07-14T00:00:05.000Z',
  );
  const requests = successfulRequests(scenario, scope, observedResponse, {
    status: 409,
    body: { code: 'operation_not_cancellable' },
  });
  requests.splice(3, 0, {
    method: 'GET',
    path: '/isolated-ollama/clean',
    response: { status: 200, body: { modelNames: [] } },
  });
  transport = new ScriptedTransport(requests);

  const proof = await runCancelableOperationScenario(transport, scenario);

  assert.deepEqual(proof.canceledState, {
    observationWindowMs: 1_000,
    immediate: { modelNames: [] },
    afterWindow: { modelNames: [] },
  });
  transport.assertConsumed();
});

test('consumes an already completed runtime commit transition before rejecting cancel', async () => {
  const scenario: CancelableOperationScenario = {
    kind: 'runtime',
    startPath: '/runtime/installations/windowsml_ocr',
    operationPath: (operationId) => `/runtime/installations/${operationId}`,
    operationKind: 'windowsml_ocr',
    provider: 'windowsml',
    model: 'fixture-runtime-model',
    timeoutMs: 1_000,
  };
  const scope = {
    kind: scenario.operationKind,
    provider: scenario.provider,
    model: scenario.model,
  };
  const observedResponse = operation(
    'commit-operation',
    'succeeded',
    'completed',
    false,
    scope,
    '2026-07-14T00:00:05.000Z',
  );
  const rejectionResponse = {
    status: 409,
    body: { detail: { code: 'operation_not_cancellable' } },
  } satisfies JsonResponse;
  const transport = new ScriptedTransport(
    successfulRequests(scenario, scope, observedResponse, rejectionResponse),
  );

  const proof = await runCancelableOperationScenario(transport, scenario);

  const nonCancellable = proof.nonCancellableResponse as Record<
    string,
    unknown
  >;
  assert.strictEqual(nonCancellable.observedResponse, observedResponse);
  assert.strictEqual(nonCancellable.rejectionResponse, rejectionResponse);
  assert.equal(proof.kind, scenario.operationKind);
  transport.assertConsumed();
});

test('rejects model scope drift on the durable commit response', async () => {
  const scenario: CancelableOperationScenario = {
    kind: 'model',
    startPath: '/llm/model-downloads',
    operationPath: (operationId) => `/llm/model-downloads/${operationId}`,
    provider: 'ollama',
    model: 'qwen3.5:4b',
    timeoutMs: 1_000,
  };
  const scope = { provider: scenario.provider, model: scenario.model };
  const driftedResponse = operation(
    'commit-operation',
    'succeeded',
    'completed',
    false,
    { ...scope, model: 'unexpected:model' },
    '2026-07-14T00:00:05.000Z',
  );
  const requests = successfulRequests(scenario, scope, driftedResponse, {
    status: 409,
    body: { code: 'operation_not_cancellable' },
  }).slice(0, -1);
  const transport = new ScriptedTransport(requests);

  await assert.rejects(
    runCancelableOperationScenario(transport, scenario),
    /model response scope did not match the request/,
  );
  transport.assertConsumed();
});

test('fails fast when the commit probe terminates before committing', async () => {
  const scenario: CancelableOperationScenario = {
    kind: 'draft',
    startPath: '/projects/project-1/documents/document-1/draft-operations',
    operationPath: (operationId) =>
      `/projects/project-1/documents/document-1/draft-operations/${operationId}`,
    startData: { limit: 5 },
    projectId: 'project-1',
    documentId: 'document-1',
    provider: 'ollama',
    model: 'qwen3.5:4b',
    timeoutMs: 1_000,
  };
  const scope = {
    project_id: scenario.projectId,
    document_id: scenario.documentId,
    provider: scenario.provider,
    model: scenario.model,
  };
  const failedResponse = {
    ...operation('commit-operation', 'failed', 'failed', false, scope, null),
    error: 'Ollama returned invalid JSON',
  };
  const requests = successfulRequests(scenario, scope, failedResponse, {
    status: 409,
    body: { code: 'operation_not_cancellable' },
  }).slice(0, -1);
  const transport = new ScriptedTransport(requests);

  await assert.rejects(
    runCancelableOperationScenario(transport, scenario),
    /commit probe reached failed before durable commit transition: Ollama returned invalid JSON/,
  );
  transport.assertConsumed();
});

function successfulRequests(
  scenario: CancelableOperationScenario,
  scope: Readonly<Record<string, string>>,
  observedResponse: Record<string, unknown>,
  rejectionResponse: JsonResponse,
): ScriptedRequest[] {
  const canceledOperationPath = scenario.operationPath('cancel-operation');
  const commitOperationPath = scenario.operationPath('commit-operation');
  return [
    {
      method: 'POST',
      path: scenario.startPath,
      response: {
        status: 202,
        body: operation(
          'cancel-operation',
          'running',
          'working',
          true,
          scope,
          null,
        ),
      },
    },
    {
      method: 'DELETE',
      path: canceledOperationPath,
      response: {
        status: 202,
        body: operation(
          'cancel-operation',
          'cancel_requested',
          'canceling',
          false,
          scope,
          null,
        ),
      },
    },
    {
      method: 'GET',
      path: canceledOperationPath,
      response: {
        status: 200,
        body: operation(
          'cancel-operation',
          'canceled',
          'canceled',
          false,
          scope,
          null,
        ),
      },
    },
    {
      method: 'POST',
      path: scenario.startPath,
      response: {
        status: 202,
        body: operation(
          'commit-operation',
          'running',
          'working',
          true,
          scope,
          null,
        ),
      },
    },
    {
      method: 'GET',
      path: commitOperationPath,
      response: { status: 200, body: observedResponse },
    },
    {
      method: 'DELETE',
      path: commitOperationPath,
      response: rejectionResponse,
    },
  ];
}

function operation(
  id: string,
  status: string,
  phase: string,
  cancellable: boolean,
  scope: Readonly<Record<string, string>>,
  commitStartedAt: string | null,
): Record<string, unknown> {
  return {
    id,
    status,
    phase,
    cancellable,
    commit_started_at: commitStartedAt,
    ...scope,
  };
}
