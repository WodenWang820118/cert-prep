import type { JsonTransport } from './api-client.mts';
import {
  requireApiErrorCode,
  requireJsonObject,
} from './api-client.mts';
import {
  booleanField,
  pollJson,
  stringField,
} from './scenario-utils.mts';

export type CancelableOperationKind = 'draft' | 'runtime' | 'model';

export interface CancelableOperationScenario {
  readonly kind: CancelableOperationKind;
  readonly startPath: string;
  readonly operationPath: (operationId: string) => string;
  readonly startData?: unknown;
  readonly projectId?: string;
  readonly documentId?: string;
  readonly timeoutMs: number;
}

export async function runCancelableOperationScenario(
  transport: JsonTransport,
  scenario: CancelableOperationScenario,
): Promise<Record<string, unknown>> {
  const first = exactOperation(
    requireJsonObject(
      await transport.request('POST', scenario.startPath, {
        data: scenario.startData,
      }),
      [200, 202],
      `${scenario.kind} cancellation start`,
    ),
    scenario,
  );
  const operationId = stringField(first.id, `${scenario.kind} operation id`);
  if (first.cancellable !== true) {
    throw new Error(`${scenario.kind} operation was not cancellable after start.`);
  }
  const operationPath = scenario.operationPath(operationId);
  const cancelResponse = exactOperation(
    requireJsonObject(
      await transport.request('DELETE', operationPath),
      [200, 202],
      `${scenario.kind} cancellation request`,
    ),
    scenario,
    operationId,
  );
  if (
    !['cancel_requested', 'canceled'].includes(String(cancelResponse.status)) ||
    cancelResponse.cancellable !== false
  ) {
    throw new Error(`${scenario.kind} cancel response was not persisted.`);
  }
  const terminalResponse = exactOperation(
    await pollJson(
      transport,
      operationPath,
      (body) => body.status === 'canceled',
      { timeoutMs: scenario.timeoutMs, label: `${scenario.kind} terminal` },
    ),
    scenario,
    operationId,
  );
  if (terminalResponse.cancellable !== false) {
    throw new Error(`${scenario.kind} canceled terminal remained cancellable.`);
  }

  const commitStart = exactOperation(
    requireJsonObject(
      await transport.request('POST', scenario.startPath, {
        data: scenario.startData,
      }),
      [200, 202],
      `${scenario.kind} commit probe start`,
    ),
    scenario,
  );
  const commitOperationId = stringField(
    commitStart.id,
    `${scenario.kind} commit operation id`,
  );
  const commitPath = scenario.operationPath(commitOperationId);
  const committing = exactOperation(
    await pollJson(
      transport,
      commitPath,
      (body) => body.phase === 'committing' && body.cancellable === false,
      {
        timeoutMs: scenario.timeoutMs,
        intervalMs: 25,
        label: `${scenario.kind} committing phase`,
      },
    ),
    scenario,
    commitOperationId,
  );
  const rejection = await transport.request('DELETE', commitPath);
  requireApiErrorCode(
    rejection,
    409,
    'operation_not_cancellable',
    `${scenario.kind} committing cancellation`,
  );

  return {
    ...(scenario.projectId ? { projectId: scenario.projectId } : {}),
    ...(scenario.documentId ? { documentId: scenario.documentId } : {}),
    operationId,
    cancelResponse,
    terminalResponse,
    nonCancellableResponse: {
      operationId: commitOperationId,
      phase: committing.phase,
      cancellable: committing.cancellable,
      httpStatus: rejection.status,
      errorCode: 'operation_not_cancellable',
    },
  };
}

function exactOperation(
  body: Record<string, unknown>,
  scenario: CancelableOperationScenario,
  expectedOperationId?: string,
): Record<string, unknown> {
  const value = {
    id: stringField(body.id, `${scenario.kind} response id`),
    status: stringField(body.status, `${scenario.kind} response status`),
    phase: stringField(body.phase, `${scenario.kind} response phase`),
    cancellable: booleanField(
      body.cancellable,
      `${scenario.kind} response cancellable`,
    ),
    ...(body.project_id === undefined
      ? {}
      : {
          project_id: stringField(
            body.project_id,
            `${scenario.kind} response project_id`,
          ),
        }),
    ...(body.document_id === undefined
      ? {}
      : {
          document_id: stringField(
            body.document_id,
            `${scenario.kind} response document_id`,
          ),
        }),
  };
  if (
    (expectedOperationId !== undefined && value.id !== expectedOperationId) ||
    (scenario.projectId !== undefined &&
      value.project_id !== scenario.projectId) ||
    (scenario.documentId !== undefined &&
      value.document_id !== scenario.documentId)
  ) {
    throw new Error(`${scenario.kind} response scope did not match the request.`);
  }
  return value;
}
