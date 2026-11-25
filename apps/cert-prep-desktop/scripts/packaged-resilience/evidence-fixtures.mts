import type {
  CandidateBinding,
  InstallationBinding,
  ResilienceCheck,
} from './evidence-contract.mts';

export const FIXTURE_CANDIDATE: CandidateBinding = {
  candidateId: 'e'.repeat(64),
  version: '0.1.0-alpha.1',
  tag: 'cert-prep-v0.1.0-alpha.1',
  commitSha: 'a'.repeat(40),
  harnessSha256: 'c'.repeat(64),
};

export const FIXTURE_INSTALLATION_BINDING: InstallationBinding = {
  receiptSha256: 'd'.repeat(64),
  packageKind: 'nsis',
  installerRelativePath:
    'release/installers/Cert Prep_0.1.0-alpha.1_x64-setup.exe',
  installerSha256: 'b'.repeat(64),
  installedExeName: 'Cert Prep.exe',
  installedExeBytes: 20,
  installedExeSha256: 'f'.repeat(64),
  installedAt: '2026-07-11T00:55:00.000Z',
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
  const startedAt = options.startedAt ?? '2026-07-11T01:00:01.100Z';
  const completedAt = options.completedAt ?? '2026-07-11T01:00:03.900Z';
  const commitStartedAt = new Date(
    (Date.parse(startedAt) + Date.parse(completedAt)) / 2,
  ).toISOString();
  return {
    schemaVersion: 2,
    check,
    passed: true,
    candidate,
    acceptanceRunId: options.acceptanceRunId ?? 'acceptance-run-0001',
    startedAt,
    completedAt,
    observations: [
      {
        at: startedAt,
        event: `${check}.started`,
      },
      {
        at: completedAt,
        event: `${check}.verified`,
      },
    ],
    proof: {
      ...validProof(check, commitStartedAt),
      installationBinding: FIXTURE_INSTALLATION_BINDING,
    },
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
      installationBinding: FIXTURE_INSTALLATION_BINDING,
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

function validProof(
  check: ResilienceCheck,
  commitStartedAt: string,
): Record<string, unknown> {
  const projectId = 'project-1';
  const sourceId = 'source-1';
  const operationId = 'operation-1';
  const cancel = operation(
    operationId,
    'cancel_requested',
    'canceling',
    false,
    projectId,
    sourceId,
  );
  const terminal = operation(
    operationId,
    'canceled',
    'canceled',
    false,
    projectId,
    sourceId,
  );
  if (check === 'upload') {
    return {
      projectId,
      operationId,
      cancelResponse: { ...cancel, source_id: null },
      terminalResponse: { ...terminal, source_id: null },
      sourceCreated: false,
      uploadResponseObserved: false,
    };
  }
  if (check === 'ocr') {
    return {
      projectId,
      sourceId,
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
        sourceId,
      ),
      retryTerminalResponse: operation(
        'operation-2',
        'succeeded',
        'completed',
        false,
        projectId,
        sourceId,
      ),
      readySourceResponse: {
        id: sourceId,
        project_id: projectId,
        status: 'ready',
      },
      sameSourceRetry: true,
      latePublishSuppressed: true,
      latePublishObservationWindowMs: 2_000,
    };
  }
  if (check === 'question') {
    return {
      ...cancellationProof(
        {
          projectId,
          sourceId,
          provider: 'ollama',
          model: 'qwen3.5:4b',
        },
        operationId,
        cancel,
        terminal,
        commitStartedAt,
      ),
      manualQuestionGenerationTerminalResponse: {
        id: 'operation-commit',
        project_id: projectId,
        source_id: sourceId,
        limit: 2,
        strategy: 'hybrid_reasoning',
        status: 'succeeded',
        phase: 'completed',
        cancellable: false,
        provider: 'ollama',
        model: 'qwen3.5:4b',
        effective_provider: 'ollama',
        effective_model: 'qwen3.5:4b',
        fallback_reason: null,
        generated_count: 2,
        commit_started_at: commitStartedAt,
      },
      canceledState: {
        observationWindowMs: 2_000,
        immediate: { usableQuestionCount: 0 },
        afterWindow: { usableQuestionCount: 0 },
      },
      uploadTriggeredJobs: {
        jobCount: 2,
        statuses: ['skipped_missing_model', 'skipped_missing_model'],
        usableQuestionCount: 0,
      },
      usableQuestionCountBeforeManual: 0,
      usableQuestionCountAfterManual: 2,
    };
  }
  if (check === 'runtime') {
    const unavailableRequirement = {
      kind: 'ollama',
      available: false,
      unavailableReason: 'ollama_missing',
      installTargetPathRelative: 'runtimes/ollama',
    };
    return {
      ...cancellationProof(
        {
          kind: 'ollama',
          provider: 'ollama',
          model: 'qwen3.5:4b',
        },
        operationId,
        operation(operationId, 'cancel_requested', 'canceling', false),
        operation(operationId, 'canceled', 'canceled', false),
        commitStartedAt,
      ),
      requirementBefore: unavailableRequirement,
      canceledState: {
        observationWindowMs: 2_000,
        immediate: unavailableRequirement,
        afterWindow: unavailableRequirement,
      },
      requirementAfter: {
        kind: 'ollama',
        available: true,
        installedPathRelative: 'runtimes/ollama',
      },
    };
  }
  if (check === 'model') {
    const missingTags = { modelNames: [] };
    const missingHealth = {
      provider: 'ollama',
      model: 'qwen3.5:4b',
      available: false,
      unavailableReason: 'model_missing',
      effectiveModel: null,
    };
    return {
      ...cancellationProof(
        { provider: 'ollama', model: 'qwen3.5:4b' },
        operationId,
        operation(operationId, 'cancel_requested', 'canceling', false),
        operation(operationId, 'canceled', 'canceled', false),
        commitStartedAt,
      ),
      tagsBefore: missingTags,
      healthBefore: missingHealth,
      canceledState: {
        observationWindowMs: 2_000,
        immediate: { tags: missingTags, health: missingHealth },
        afterWindow: { tags: missingTags, health: missingHealth },
      },
      tagsAfter: { modelNames: ['qwen3.5:4b'] },
      healthAfter: {
        provider: 'ollama',
        model: 'qwen3.5:4b',
        available: true,
        unavailableReason: null,
        effectiveModel: 'qwen3.5:4b',
      },
    };
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
      sourceId,
      operationId,
      beforeCancel: { chunksCount: 2, nonZeroDerivedMetricCount: 1, questionCount: 0 },
      afterCanceled: {
        chunksCount: 0,
        chunksEndpointItems: 0,
        hasText: false,
        processedPageCount: 0,
        questionCount: 0,
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
  scope: {
    readonly projectId?: string;
    readonly sourceId?: string;
    readonly kind?: string;
    readonly provider: string;
    readonly model: string;
  },
  operationId: string,
  cancelResponse: Record<string, unknown>,
  terminalResponse: Record<string, unknown>,
  commitStartedAt: string,
): Record<string, unknown> {
  const responseScope = {
    ...(scope.projectId ? { project_id: scope.projectId } : {}),
    ...(scope.sourceId ? { source_id: scope.sourceId } : {}),
    ...(scope.kind ? { kind: scope.kind } : {}),
    provider: scope.provider,
    model: scope.model,
  };
  return {
    ...(scope.projectId ? { projectId: scope.projectId } : {}),
    ...(scope.sourceId ? { sourceId: scope.sourceId } : {}),
    ...(scope.kind ? { kind: scope.kind } : {}),
    provider: scope.provider,
    model: scope.model,
    operationId,
    cancelResponse: { ...cancelResponse, ...responseScope },
    terminalResponse: { ...terminalResponse, ...responseScope },
    nonCancellableResponse: {
      operationId: 'operation-commit',
      commitStartedAt,
      observedResponse: {
        id: 'operation-commit',
        status: 'running',
        phase: 'committing',
        cancellable: false,
        commit_started_at: commitStartedAt,
        ...responseScope,
      },
      rejectionResponse: {
        status: 409,
        body: { code: 'operation_not_cancellable' },
      },
    },
  };
}

function operation(
  id: string,
  status: string,
  phase: string,
  cancellable: boolean,
  projectId?: string,
  sourceId?: string,
): Record<string, unknown> {
  return {
    id,
    status,
    phase,
    cancellable,
    ...(projectId ? { project_id: projectId } : {}),
    ...(sourceId ? { source_id: sourceId } : {}),
  };
}
