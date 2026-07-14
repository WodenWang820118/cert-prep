import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RESILIENCE_CHECKS,
  validateResilienceEvidence,
  validateSessionRestartEvidence,
  type CandidateBinding,
  type ResilienceCheck,
} from './evidence-contract.mts';

const candidate: CandidateBinding = {
  candidateId: 'a'.repeat(64),
  version: '0.1.0-alpha.1',
  tag: 'cert-prep-v0.1.0-alpha.1',
  commitSha: 'b'.repeat(40),
  harnessSha256: 'c'.repeat(64),
};

const context = {
  candidate,
  acceptanceRunId: 'acceptance-run-0001',
  acceptanceStartedAt: '2026-07-14T00:00:00.000Z',
  acceptanceCompletedAt: '2026-07-14T00:10:00.000Z',
};

test('all nine candidate-bound resilience contracts accept exact scoped proof', () => {
  for (const check of RESILIENCE_CHECKS) {
    assert.equal(
      validateResilienceEvidence(validEvidence(check), check, context).check,
      check,
    );
  }
});

test('candidate, acceptance run, evidence window, and structured observations fail closed', () => {
  const evidence = validEvidence('ocr');
  assert.throws(
    () =>
      validateResilienceEvidence(
        {
          ...evidence,
          candidate: { ...candidate, candidateId: 'd'.repeat(64) },
        },
        'ocr',
        context,
      ),
    /candidate candidateId/,
  );
  assert.throws(
    () =>
      validateResilienceEvidence(
        { ...evidence, acceptanceRunId: 'another-run-0001' },
        'ocr',
        context,
      ),
    /acceptanceRunId/,
  );
  assert.throws(
    () =>
      validateResilienceEvidence(
        { ...evidence, completedAt: '2026-07-14T00:11:00.000Z' },
        'ocr',
        context,
      ),
    /outside the completed acceptance run/,
  );
  assert.throws(
    () =>
      validateResilienceEvidence(
        { ...evidence, observations: ['bare boolean by prose'] },
        'ocr',
        context,
      ),
    /observation 0 must be an object/,
  );
});

test('OCR evidence requires exact cancel, terminal, distinct retry, same document, and late-publish proof', () => {
  const evidence = validEvidence('ocr');
  const proof = evidence.proof as Record<string, unknown>;
  assert.throws(
    () =>
      validateResilienceEvidence(
        {
          ...evidence,
          proof: { ...proof, retryOperationId: proof.initialOperationId },
        },
        'ocr',
        context,
      ),
    /retry operation id must be distinct/,
  );
  assert.throws(
    () =>
      validateResilienceEvidence(
        {
          ...evidence,
          proof: {
            ...proof,
            canceledResponse: {
              ...(proof.canceledResponse as object),
              document_id: 'document-other',
            },
          },
        },
        'ocr',
        context,
      ),
    /scope or terminal state/,
  );
  assert.throws(
    () =>
      validateResilienceEvidence(
        { ...evidence, proof: { ...proof, latePublishSuppressed: false } },
        'ocr',
        context,
      ),
    /cancel-to-retry terminal sequence/,
  );
});

test('partial cleanup requires chunks and every derived metric to remain zero', () => {
  const evidence = validEvidence('partialDataRemoved');
  const proof = evidence.proof as Record<string, unknown>;
  const afterCanceled = proof.afterCanceled as Record<string, unknown>;
  assert.throws(
    () =>
      validateResilienceEvidence(
        {
          ...evidence,
          proof: {
            ...proof,
            afterCanceled: { ...afterCanceled, firstChunkMs: 12 },
          },
        },
        'partialDataRemoved',
        context,
      ),
    /partial data cleanup/,
  );
});

test('draft/runtime/model cancellation requires a real 409 committing-phase response', () => {
  for (const check of ['draft', 'runtime', 'model'] as const) {
    const evidence = validEvidence(check);
    const proof = evidence.proof as Record<string, unknown>;
    assert.throws(
      () =>
        validateResilienceEvidence(
          {
            ...evidence,
            proof: {
              ...proof,
              nonCancellableResponse: {
                ...(proof.nonCancellableResponse as object),
                httpStatus: 200,
              },
            },
          },
          check,
          context,
        ),
      /non-cancellable commit evidence/,
    );
  }
});

test('race, crash recovery, and process residue cannot pass from one terminal sample', () => {
  const race = validEvidence('cancelVsCompleteRace');
  assert.throws(
    () =>
      validateResilienceEvidence(
        {
          ...race,
          proof: {
            ...(race.proof as object),
            lateTerminalStatuses: ['canceled'],
          },
        },
        'cancelVsCompleteRace',
        context,
      ),
    /race winner was not stable/,
  );
  const crash = validEvidence('crashRecovery');
  assert.throws(
    () =>
      validateResilienceEvidence(
        {
          ...crash,
          proof: { ...(crash.proof as object), sameOperationId: false },
        },
        'crashRecovery',
        context,
      ),
    /persisted recovery/,
  );
  const processes = validEvidence('ownedProcessesReleased');
  assert.throws(
    () =>
      validateResilienceEvidence(
        {
          ...processes,
          proof: {
            ...(processes.proof as object),
            finalOwnedPids: [44],
          },
        },
        'ownedProcessesReleased',
        context,
      ),
    /owned process closeout/,
  );
});

test('session restart needs answer, explicit Resume, completion, and a clean second restart', () => {
  const evidence = validSessionRestartEvidence();
  assert.equal(
    validateSessionRestartEvidence(evidence, context).check,
    'sessionRestart',
  );
  assert.throws(
    () =>
      validateSessionRestartEvidence(
        {
          ...evidence,
          proof: {
            ...(evidence.proof as object),
            firstRestart: {
              ...((evidence.proof as Record<string, unknown>).firstRestart as object),
              explicitAction: 'automatic',
            },
          },
        },
        context,
      ),
    /explicit Resume/,
  );
  assert.throws(
    () =>
      validateSessionRestartEvidence(
        {
          ...evidence,
          proof: {
            ...(evidence.proof as object),
            secondRestart: {
              ...((evidence.proof as Record<string, unknown>).secondRestart as object),
              activeSessionIds: ['session-1'],
            },
          },
        },
        context,
      ),
    /still exposed a resumable session/,
  );
});

export function validEvidence(check: ResilienceCheck): Record<string, unknown> {
  return {
    schemaVersion: 2,
    check,
    passed: true,
    candidate,
    acceptanceRunId: 'acceptance-run-0001',
    startedAt: '2026-07-14T00:00:01.000Z',
    completedAt: '2026-07-14T00:00:09.000Z',
    observations: [
      {
        at: '2026-07-14T00:00:02.000Z',
        event: `${check}.started`,
        projectId: 'project-1',
      },
      {
        at: '2026-07-14T00:00:08.000Z',
        event: `${check}.terminal`,
        status: 'canceled',
      },
    ],
    proof: validProof(check),
  };
}

export function validSessionRestartEvidence(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    check: 'sessionRestart',
    passed: true,
    candidate,
    acceptanceRunId: 'acceptance-run-0001',
    startedAt: '2026-07-14T00:00:01.000Z',
    completedAt: '2026-07-14T00:00:09.000Z',
    observations: [
      {
        at: '2026-07-14T00:00:02.000Z',
        event: 'session.answer-recorded',
        sessionId: 'session-1',
      },
      {
        at: '2026-07-14T00:00:08.000Z',
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
  const cancelResponse = operation(
    operationId,
    'cancel_requested',
    'canceling',
    false,
    projectId,
    documentId,
  );
  const terminalResponse = operation(
    operationId,
    'canceled',
    'canceled',
    false,
    projectId,
    documentId,
  );
  switch (check) {
    case 'upload':
      return {
        projectId,
        operationId,
        cancelResponse: { ...cancelResponse, document_id: null },
        terminalResponse: { ...terminalResponse, document_id: null },
        documentCreated: false,
        uploadResponseObserved: false,
      };
    case 'ocr':
      return {
        projectId,
        documentId,
        initialOperationId: operationId,
        retryOperationId: 'operation-2',
        cancelResponse,
        canceledResponse: terminalResponse,
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
    case 'draft':
      return scopedCancellation(
        projectId,
        documentId,
        operationId,
        cancelResponse,
        terminalResponse,
      );
    case 'runtime':
    case 'model':
      return scopedCancellation(
        undefined,
        undefined,
        operationId,
        operation(operationId, 'cancel_requested', 'canceling', false),
        operation(operationId, 'canceled', 'canceled', false),
      );
    case 'cancelVsCompleteRace':
      return {
        operationId,
        winner: 'canceled',
        cancelHttpStatus: 202,
        terminalResponse: operation(operationId, 'canceled', 'canceled', false),
        terminalStateStable: true,
        lateTerminalStatuses: ['canceled', 'canceled'],
      };
    case 'crashRecovery':
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
    case 'partialDataRemoved':
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
    case 'ownedProcessesReleased':
      return {
        appPid: 100,
        observedOwnedPids: [100, 101],
        finalOwnedPids: [],
        stableEmptySnapshots: 2,
        residueCount: 0,
        closedAt: '2026-07-14T00:00:08.000Z',
      };
  }
}

function scopedCancellation(
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
