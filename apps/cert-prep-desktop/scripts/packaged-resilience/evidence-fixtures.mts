import type {
  CandidateBinding,
  ResilienceCheck,
} from './evidence-contract.mts';

export const FIXTURE_CANDIDATE: CandidateBinding = {
  candidateId: 'e'.repeat(64),
  version: '0.1.0-alpha.1',
  tag: 'cert-prep-v0.1.0-alpha.1',
  commitSha: 'a'.repeat(40),
  harnessSha256: 'c'.repeat(64),
};

export interface EvidenceFixtureOptions {
  readonly candidate?: CandidateBinding;
  readonly acceptanceRunId?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export function buildValidResilienceEvidence(
  check: ResilienceCheck,
  options: EvidenceFixtureOptions = {},
): Record<string, unknown> {
  const candidate = options.candidate ?? FIXTURE_CANDIDATE;
  return {
    schemaVersion: 2,
    check,
    passed: true,
    candidate,
    acceptanceRunId: options.acceptanceRunId ?? 'acceptance-run-0001',
    startedAt: options.startedAt ?? '2026-07-11T01:00:01.100Z',
    completedAt: options.completedAt ?? '2026-07-11T01:00:03.900Z',
    observations: [
      {
        at: options.startedAt ?? '2026-07-11T01:00:01.100Z',
        event: `${check}.started`,
      },
      {
        at: options.completedAt ?? '2026-07-11T01:00:03.900Z',
        event: `${check}.verified`,
      },
    ],
    proof: validProof(check),
  };
}

export function buildValidSessionRestartEvidence(
  options: EvidenceFixtureOptions = {},
): Record<string, unknown> {
  const candidate = options.candidate ?? FIXTURE_CANDIDATE;
  return {
    schemaVersion: 2,
    check: 'sessionRestart',
    passed: true,
    candidate,
    acceptanceRunId: options.acceptanceRunId ?? 'acceptance-run-0001',
    startedAt: options.startedAt ?? '2026-07-11T01:00:01.100Z',
    completedAt: options.completedAt ?? '2026-07-11T01:00:03.900Z',
    observations: [
      {
        at: options.startedAt ?? '2026-07-11T01:00:01.100Z',
        event: 'session.answer-recorded',
        sessionId: 'session-1',
      },
      {
        at: options.completedAt ?? '2026-07-11T01:00:03.900Z',
        event: 'session.second-restart-verified',
        sessionId: 'session-1',
      },
    ],
    proof: {
      projectId: 'project-1',
      sessionId: 'session-1',
      answeredBeforeFirstRestart: 1,
      firstRestart: {
        projectId: 'project-1',
        activeSessionIds: ['session-1'],
        explicitAction: 'resume',
        resumedSessionId: 'session-1',
        restoredAttemptCount: 1,
      },
      completion: {
        sessionId: 'session-1',
        status: 'completed',
        questionCount: 2,
        attemptCount: 2,
      },
      secondRestart: {
        sessionId: 'session-1',
        activeSessionIds: [],
        completedSessionStatus: 'completed',
      },
    },
  };
}

function validProof(check: ResilienceCheck): Record<string, unknown> {
  const projectId = 'project-1';
  const documentId = 'document-1';
  const operationId = 'operation-1';
  const cancel = operation(
    operationId,
    'cancel_requested',
    'canceling',
    false,
    projectId,
    documentId,
  );
  const terminal = operation(
    operationId,
    'canceled',
    'canceled',
    false,
    projectId,
    documentId,
  );
  if (check === 'upload') {
    return {
      projectId,
      operationId,
      cancelResponse: { ...cancel, document_id: null },
      terminalResponse: { ...terminal, document_id: null },
      documentCreated: false,
      uploadResponseObserved: false,
    };
  }
  if (check === 'ocr') {
    return {
      projectId,
      documentId,
      initialOperationId: operationId,
      retryOperationId: 'operation-2',
      cancelResponse: cancel,
      canceledResponse: terminal,
      retryResponse: operation(
        'operation-2',
        'running',
        'ocr',
        true,
        projectId,
        documentId,
      ),
      retryTerminalResponse: operation(
        'operation-2',
        'completed',
        'completed',
        false,
        projectId,
        documentId,
      ),
      readyDocumentResponse: {
        id: documentId,
        project_id: projectId,
        status: 'ready',
      },
      sameDocumentRetry: true,
      latePublishSuppressed: true,
      latePublishObservationWindowMs: 2_000,
    };
  }
  if (check === 'draft') {
    return cancellationProof(projectId, documentId, operationId, cancel, terminal);
  }
  if (check === 'runtime' || check === 'model') {
    return cancellationProof(
      undefined,
      undefined,
      operationId,
      operation(operationId, 'cancel_requested', 'canceling', false),
      operation(operationId, 'canceled', 'canceled', false),
    );
  }
  if (check === 'cancelVsCompleteRace') {
    return {
      operationId,
      winner: 'canceled',
      cancelHttpStatus: 202,
      terminalResponse: operation(operationId, 'canceled', 'canceled', false),
      terminalStateStable: true,
      lateTerminalStatuses: ['canceled', 'canceled'],
    };
  }
  if (check === 'crashRecovery') {
    return {
      operationId,
      beforeCrashResponse: operation(operationId, 'running', 'ocr', true),
      afterRestartResponse: operation(
        operationId,
        'cancel_requested',
        'recovering',
        true,
      ),
      terminalResponse: operation(operationId, 'canceled', 'canceled', false),
      sameOperationId: true,
      restartCount: 1,
    };
  }
  if (check === 'partialDataRemoved') {
    return {
      projectId,
      documentId,
      operationId,
      beforeCancel: { chunksCount: 2, nonZeroDerivedMetricCount: 3 },
      afterCanceled: {
        chunksCount: 0,
        chunksEndpointItems: 0,
        hasText: false,
        processedPageCount: 0,
        ocrDurationMs: 0,
        parseWallDurationMs: 0,
        renderDurationMs: 0,
        ocrEngineDurationMs: 0,
        firstChunkMs: 0,
        examItemCount: 0,
      },
      originalPdfRetryable: true,
      latePublishSuppressed: true,
      latePublishObservationWindowMs: 2_000,
    };
  }
  return {
    appPid: 100,
    observedOwnedPids: [100, 101],
    finalOwnedPids: [],
    stableEmptySnapshots: 2,
    residueCount: 0,
    closedAt: '2026-07-11T01:00:03.900Z',
  };
}

function cancellationProof(
  projectId: string | undefined,
  documentId: string | undefined,
  operationId: string,
  cancelResponse: Record<string, unknown>,
  terminalResponse: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(projectId ? { projectId } : {}),
    ...(documentId ? { documentId } : {}),
    operationId,
    cancelResponse,
    terminalResponse,
    nonCancellableResponse: {
      operationId: 'operation-commit',
      phase: 'committing',
      cancellable: false,
      httpStatus: 409,
      errorCode: 'operation_not_cancellable',
    },
  };
}

function operation(
  id: string,
  status: string,
  phase: string,
  cancellable: boolean,
  projectId?: string,
  documentId?: string,
): Record<string, unknown> {
  return {
    id,
    status,
    phase,
    cancellable,
    ...(projectId ? { project_id: projectId } : {}),
    ...(documentId ? { document_id: documentId } : {}),
  };
}
