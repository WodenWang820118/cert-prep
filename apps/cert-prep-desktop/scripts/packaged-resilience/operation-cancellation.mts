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

interface CancelableOperationScenarioBase {
  readonly kind: CancelableOperationKind;
  readonly startPath: string;
  readonly operationPath: (operationId: string) => string;
  readonly startData?: unknown;
  readonly timeoutMs: number;
}

export type CancelableOperationScenario =
  | (CancelableOperationScenarioBase & {
      readonly kind: 'draft';
      readonly projectId: string;
      readonly documentId: string;
      readonly provider: string;
      readonly model: string;
    })
  | (CancelableOperationScenarioBase & {
      readonly kind: 'runtime';
      readonly operationKind: string;
      readonly provider: string;
      readonly model: string;
    })
  | (CancelableOperationScenarioBase & {
      readonly kind: 'model';
      readonly provider: string;
      readonly model: string;
    });

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
  const commitObserved = exactOperation(
    await pollJson(
      transport,
      commitPath,
      (body) => {
        const scoped = exactOperation(
          body,
          scenario,
          commitOperationId,
        );
        return optionalCommitStartedAt(
          scoped.commit_started_at,
          `${scenario.kind} commit_started_at`,
        ) !== null;
      },
      {
        timeoutMs: scenario.timeoutMs,
        label: `${scenario.kind} durable commit transition`,
      },
    ),
    scenario,
    commitOperationId,
  );
  const commitStartedAt = optionalCommitStartedAt(
    commitObserved.commit_started_at,
    `${scenario.kind} commit_started_at`,
  );
  if (commitStartedAt === null) {
    throw new Error(`${scenario.kind} commit transition was not persisted.`);
  }
  const commitPhase = stringField(
    commitObserved.phase,
    `${scenario.kind} committed response phase`,
  );
  if (
    !['committing', 'completed'].includes(commitPhase) ||
    commitObserved.cancellable !== false
  ) {
    throw new Error(
      `${scenario.kind} durable commit response was not non-cancellable.`,
    );
  }
  const rejection = await transport.request('DELETE', commitPath);
  requireApiErrorCode(
    rejection,
    409,
    'operation_not_cancellable',
    `${scenario.kind} committing cancellation`,
  );

  return {
    ...proofScope(scenario),
    operationId,
    cancelResponse,
    terminalResponse,
    nonCancellableResponse: {
      operationId: commitOperationId,
      commitStartedAt,
      observedResponse: commitObserved,
      rejectionResponse: rejection,
    },
  };
}

function exactOperation(
  body: Record<string, unknown>,
  scenario: CancelableOperationScenario,
  expectedOperationId?: string,
): Record<string, unknown> {
  const operationId = stringField(body.id, `${scenario.kind} response id`);
  stringField(body.status, `${scenario.kind} response status`);
  stringField(body.phase, `${scenario.kind} response phase`);
  booleanField(body.cancellable, `${scenario.kind} response cancellable`);
  optionalCommitStartedAt(
    body.commit_started_at,
    `${scenario.kind} response commit_started_at`,
  );
  if (
    expectedOperationId !== undefined &&
    operationId !== expectedOperationId
  ) {
    throw new Error(`${scenario.kind} response scope did not match the request.`);
  }
  assertOperationScope(body, scenario);
  return body;
}

function assertOperationScope(
  body: Record<string, unknown>,
  scenario: CancelableOperationScenario,
): void {
  const provider = stringField(
    body.provider,
    `${scenario.kind} response provider`,
  );
  const model = stringField(body.model, `${scenario.kind} response model`);
  const matchesCommonScope =
    provider === scenario.provider && model === scenario.model;
  const matchesKindScope =
    scenario.kind !== 'runtime' ||
    stringField(body.kind, 'runtime response kind') === scenario.operationKind;
  const matchesDocumentScope =
    scenario.kind !== 'draft' ||
    (stringField(body.project_id, 'draft response project_id') ===
      scenario.projectId &&
      stringField(body.document_id, 'draft response document_id') ===
        scenario.documentId);
  if (!matchesCommonScope || !matchesKindScope || !matchesDocumentScope) {
    throw new Error(`${scenario.kind} response scope did not match the request.`);
  }
}

function optionalCommitStartedAt(value: unknown, label: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = stringField(value, label);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new Error(`${label} must be a valid timestamp.`);
  }
  return normalized;
}

function proofScope(
  scenario: CancelableOperationScenario,
): Record<string, string> {
  const common = { provider: scenario.provider, model: scenario.model };
  if (scenario.kind === 'draft') {
    return {
      ...common,
      projectId: scenario.projectId,
      documentId: scenario.documentId,
    };
  }
  if (scenario.kind === 'runtime') {
    return { ...common, kind: scenario.operationKind };
  }
  return common;
}
