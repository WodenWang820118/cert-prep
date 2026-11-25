import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RESILIENCE_CHECKS,
  validateResilienceEvidence,
  validateSessionRestartEvidence,
  type CandidateBinding,
  type InstallationBinding,
  type ResilienceCheck,
} from './evidence-contract.mts';

const candidate: CandidateBinding = {
  candidateId: 'a'.repeat(64),
  version: '0.1.0-alpha.1',
  tag: 'cert-prep-v0.1.0-alpha.1',
  commitSha: 'b'.repeat(40),
  harnessSha256: 'c'.repeat(64),
};

const installationBinding: InstallationBinding = {
  receiptSha256: 'd'.repeat(64),
  packageKind: 'nsis',
  installerRelativePath:
    'release/installers/Cert Prep_0.1.0-alpha.1_x64-setup.exe',
  installerSha256: 'e'.repeat(64),
  installedExeName: 'Cert Prep.exe',
  installedExeBytes: 1_024,
  installedExeSha256: 'f'.repeat(64),
  installedAt: '2026-07-13T23:55:00.000Z',
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

test('question evidence accepts exact effective Ollama attribution with null or absent fallback', () => {
  const evidence = validEvidence('question');
  const proof = evidence.proof as Record<string, unknown>;
  const terminal = proof.manualQuestionGenerationTerminalResponse as Record<string, unknown>;
  assert.equal(
    validateResilienceEvidence(evidence, 'question', context).check,
    'question',
  );

  const terminalWithoutFallback = { ...terminal };
  delete terminalWithoutFallback.fallback_reason;
  assert.equal(
    validateResilienceEvidence(
      {
        ...evidence,
        proof: {
          ...proof,
          manualQuestionGenerationTerminalResponse: terminalWithoutFallback,
        },
      },
      'question',
      context,
    ).check,
    'question',
  );
});

test('question evidence rejects configured-only or drifted manual terminal attribution', () => {
  const evidence = validEvidence('question');
  const proof = evidence.proof as Record<string, unknown>;
  const terminal = proof.manualQuestionGenerationTerminalResponse as Record<string, unknown>;
  const mutations: ReadonlyArray<
    readonly [string, (response: Record<string, unknown>) => void]
  > = [
    ['strategy', (response) => (response.strategy = 'deterministic_only')],
    ['status', (response) => (response.status = 'failed')],
    ['phase', (response) => (response.phase = 'failed')],
    ['zero generated count', (response) => (response.generated_count = 0)],
    [
      'insufficient generated count',
      (response) => (response.generated_count = 1),
    ],
    ['effective provider', (response) => delete response.effective_provider],
    ['effective model', (response) => delete response.effective_model],
    [
      'fallback reason',
      (response) => (response.fallback_reason = 'used fallback'),
    ],
  ];

  for (const [label, mutate] of mutations) {
    const changed = { ...terminal };
    mutate(changed);
    assert.throws(
      () =>
        validateResilienceEvidence(
          {
            ...evidence,
            proof: { ...proof, manualQuestionGenerationTerminalResponse: changed },
          },
          'question',
          context,
        ),
      /Resilience evidence contract failed for question/,
      label,
    );
  }

  const configuredOnly = { ...proof };
  delete configuredOnly.manualQuestionGenerationTerminalResponse;
  assert.throws(
    () =>
      validateResilienceEvidence(
        { ...evidence, proof: configuredOnly },
        'question',
        context,
      ),
    /manualQuestionGenerationTerminalResponse must be an object/,
  );
});

test('candidate binding accepts only the public tag or exact commit-bound local tag', () => {
  const localCandidate: CandidateBinding = {
    ...candidate,
    tag: `cert-prep-local-v${candidate.version}-${candidate.commitSha.slice(0, 12)}`,
  };
  assert.equal(
    validateResilienceEvidence(
      { ...validEvidence('ocr'), candidate: localCandidate },
      'ocr',
      { ...context, candidate: localCandidate },
    ).candidate.tag,
    localCandidate.tag,
  );
  assert.equal(
    validateSessionRestartEvidence(
      { ...validSessionRestartEvidence(), candidate: localCandidate },
      { ...context, candidate: localCandidate },
    ).candidate.tag,
    localCandidate.tag,
  );

  for (const tag of [
    `cert-prep-v${candidate.version}-${candidate.commitSha.slice(0, 12)}`,
    `cert-prep-local-v${candidate.version}`,
    `cert-prep-local-v${candidate.version}-${'d'.repeat(12)}`,
  ]) {
    const hybridCandidate = { ...candidate, tag };
    assert.throws(
      () =>
        validateResilienceEvidence(
          { ...validEvidence('ocr'), candidate: hybridCandidate },
          'ocr',
        ),
      /candidate identity is malformed/,
      tag,
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

test('every resilience and session proof requires a structurally valid installation binding', () => {
  for (const check of RESILIENCE_CHECKS) {
    const evidence = validEvidence(check);
    const proof = { ...(evidence.proof as Record<string, unknown>) };
    delete proof.installationBinding;
    assert.throws(
      () => validateResilienceEvidence({ ...evidence, proof }, check, context),
      /installationBinding must be an object/,
    );
  }

  const session = validSessionRestartEvidence();
  const sessionProof = { ...(session.proof as Record<string, unknown>) };
  delete sessionProof.installationBinding;
  assert.throws(
    () =>
      validateSessionRestartEvidence(
        { ...session, proof: sessionProof },
        context,
      ),
    /installationBinding must be an object/,
  );
});

test('installation binding rejects forged digests and unsafe installer paths', () => {
  const evidence = validEvidence('ocr');
  const proof = evidence.proof as Record<string, unknown>;
  for (const forged of [
    { ...installationBinding, receiptSha256: 'not-a-digest' },
    { ...installationBinding, installerRelativePath: '../foreign-setup.exe' },
    { ...installationBinding, packageKind: 'msi' },
    {
      ...installationBinding,
      installerRelativePath: 'release/installers/foreign.exe',
    },
    { ...installationBinding, installedExeName: 'Cert Prep' },
    { ...installationBinding, installedExeBytes: 0 },
    { ...installationBinding, installedAt: 'not-a-timestamp' },
  ]) {
    assert.throws(() =>
      validateResilienceEvidence(
        { ...evidence, proof: { ...proof, installationBinding: forged } },
        'ocr',
        context,
      ),
    );
  }

  assert.throws(
    () =>
      validateResilienceEvidence(
        {
          ...evidence,
          proof: {
            ...proof,
            installationBinding: {
              ...installationBinding,
              installedAt: '2026-07-14T00:00:02.000Z',
            },
          },
        },
        'ocr',
        context,
      ),
    /installedAt must not be after evidence startedAt/,
  );
});

test('OCR evidence requires exact cancel, terminal, distinct retry, same source, and late-publish proof', () => {
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
              source_id: 'source-other',
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
  assert.throws(
    () =>
      validateResilienceEvidence(
        {
          ...evidence,
          proof: {
            ...proof,
            retryTerminalResponse: {
              ...(proof.retryTerminalResponse as object),
              status: 'completed',
            },
          },
        },
        'ocr',
        context,
      ),
    /scope or terminal state/,
  );
});

test('partial cleanup requires chunks and page progress to be removed and the question count to be kept', () => {
  const evidence = validEvidence('partialDataRemoved');
  const proof = evidence.proof as Record<string, unknown>;
  const afterCanceled = proof.afterCanceled as Record<string, unknown>;
  const beforeCancel = proof.beforeCancel as Record<string, unknown>;
  assert.throws(
    () =>
      validateResilienceEvidence(
        {
          ...evidence,
          proof: {
            ...proof,
            afterCanceled: { ...afterCanceled, processedPageCount: 12 },
          },
        },
        'partialDataRemoved',
        context,
      ),
    /partial data cleanup/,
  );
  assert.throws(
    () =>
      validateResilienceEvidence(
        {
          ...evidence,
          proof: {
            ...proof,
            beforeCancel: { ...beforeCancel, questionCount: 2 },
            afterCanceled: { ...afterCanceled, questionCount: 1 },
          },
        },
        'partialDataRemoved',
        context,
      ),
    /partial data cleanup/,
  );
  assert.doesNotThrow(() =>
    validateResilienceEvidence(
      {
        ...evidence,
        proof: {
          ...proof,
          beforeCancel: { ...beforeCancel, questionCount: 2 },
          afterCanceled: { ...afterCanceled, questionCount: 2 },
        },
      },
      'partialDataRemoved',
      context,
    ),
  );
});

test('question/runtime/model cancellation requires durable exact commit evidence and a real 409', () => {
  for (const check of ['question', 'runtime', 'model'] as const) {
    const evidence = validEvidence(check);
    const proof = evidence.proof as Record<string, unknown>;
    const nonCancellableResponse = proof.nonCancellableResponse as Record<
      string,
      unknown
    >;
    assert.throws(
      () =>
        validateResilienceEvidence(
          {
            ...evidence,
            proof: {
              ...proof,
              nonCancellableResponse: {
                ...nonCancellableResponse,
                rejectionResponse: {
                  status: 200,
                  body: { code: 'operation_not_cancellable' },
                },
              },
            },
          },
          check,
          context,
        ),
      /non-cancellable commit evidence/,
    );
    assert.throws(
      () =>
        validateResilienceEvidence(
          {
            ...evidence,
            proof: {
              ...proof,
              nonCancellableResponse: {
                ...nonCancellableResponse,
                commitStartedAt: '2026-07-14T00:00:10.000Z',
              },
            },
          },
          check,
          context,
        ),
      /non-cancellable commit evidence/,
    );
    const observedResponse = nonCancellableResponse.observedResponse as Record<
      string,
      unknown
    >;
    assert.throws(
      () =>
        validateResilienceEvidence(
          {
            ...evidence,
            proof: {
              ...proof,
              nonCancellableResponse: {
                ...nonCancellableResponse,
                observedResponse: {
                  ...observedResponse,
                  id: 'operation-other',
                },
              },
            },
          },
          check,
          context,
        ),
      /scope or terminal state/,
    );
  }
});

test('question/runtime/model cancellation requires a stable canceled state and exact transition', () => {
  for (const check of ['question', 'runtime', 'model'] as const) {
    const evidence = validEvidence(check);
    const proof = { ...(evidence.proof as Record<string, unknown>) };
    delete proof.canceledState;
    assert.throws(
      () => validateResilienceEvidence({ ...evidence, proof }, check, context),
      /canceledState must be an object/,
    );
  }

  const question = validEvidence('question');
  const questionProof = question.proof as Record<string, unknown>;
  assert.throws(
    () =>
      validateResilienceEvidence(
        { ...question, proof: { ...questionProof, provider: 'fake' } },
        'question',
        context,
      ),
    /provider must equal ollama/,
  );
  assert.throws(
    () =>
      validateResilienceEvidence(
        {
          ...question,
          proof: {
            ...questionProof,
            uploadTriggeredJobs: {
              jobCount: 1,
              statuses: ['completed'],
              usableQuestionCount: 0,
            },
          },
        },
        'question',
        context,
      ),
    /question cancellation and manual publish transition/,
  );

  const runtime = validEvidence('runtime');
  const runtimeProof = runtime.proof as Record<string, unknown>;
  const requirementBefore = runtimeProof.requirementBefore as Record<
    string,
    unknown
  >;
  assert.throws(
    () =>
      validateResilienceEvidence(
        {
          ...runtime,
          proof: {
            ...runtimeProof,
            requirementBefore: {
              ...requirementBefore,
              unavailableReason: 'ollama_not_running',
            },
          },
        },
        'runtime',
        context,
      ),
    /must equal ollama_missing/,
  );

  const canceledState = runtimeProof.canceledState as Record<string, unknown>;
  const immediate = canceledState.immediate as Record<string, unknown>;
  assert.throws(
    () =>
      validateResilienceEvidence(
        {
          ...runtime,
          proof: {
            ...runtimeProof,
            canceledState: {
              ...canceledState,
              immediate: {
                ...immediate,
                installTargetPathRelative: 'runtimes/other-ollama',
              },
            },
          },
        },
        'runtime',
        context,
      ),
    /runtime installation target changed/,
  );

  assert.throws(
    () =>
      validateResilienceEvidence(
        {
          ...runtime,
          proof: {
            ...runtimeProof,
            requirementAfter: {
              kind: 'ollama',
              available: true,
              installedPathRelative: 'runtimes/other-ollama',
            },
          },
        },
        'runtime',
        context,
      ),
    /runtime installation target changed/,
  );

  assert.throws(
    () =>
      validateResilienceEvidence(
        {
          ...runtime,
          proof: {
            ...runtimeProof,
            requirementAfter: {
              kind: 'ollama',
              available: true,
              installedPathRelative: '../foreign-runtime',
            },
          },
        },
        'runtime',
        context,
      ),
    /safe relative path/,
  );

  const model = validEvidence('model');
  const modelProof = model.proof as Record<string, unknown>;
  assert.throws(
    () =>
      validateResilienceEvidence(
        {
          ...model,
          proof: {
            ...modelProof,
            tagsAfter: { modelNames: ['qwen3.5:4b', 'other-model'] },
          },
        },
        'model',
        context,
      ),
    /exact isolated Ollama model set/,
  );
});

test('durable non-cancellable proof may be observed after commit completed', () => {
  const evidence = validEvidence('runtime');
  const proof = evidence.proof as Record<string, unknown>;
  const nonCancellableResponse = proof.nonCancellableResponse as Record<
    string,
    unknown
  >;
  const observedResponse = nonCancellableResponse.observedResponse as Record<
    string,
    unknown
  >;

  assert.equal(
    validateResilienceEvidence(
      {
        ...evidence,
        proof: {
          ...proof,
          nonCancellableResponse: {
            ...nonCancellableResponse,
            observedResponse: {
              ...observedResponse,
              status: 'succeeded',
              phase: 'completed',
            },
          },
        },
      },
      'runtime',
      context,
    ).check,
    'runtime',
  );
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
              ...((evidence.proof as Record<string, unknown>)
                .firstRestart as object),
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
              ...((evidence.proof as Record<string, unknown>)
                .secondRestart as object),
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
    proof: {
      ...validProof(check),
      installationBinding,
    },
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
      installationBinding,
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
  const sourceId = 'source-1';
  const operationId = 'operation-1';
  const cancelResponse = operation(
    operationId,
    'cancel_requested',
    'canceling',
    false,
    projectId,
    sourceId,
  );
  const terminalResponse = operation(
    operationId,
    'canceled',
    'canceled',
    false,
    projectId,
    sourceId,
  );
  switch (check) {
    case 'upload':
      return {
        projectId,
        operationId,
        cancelResponse: { ...cancelResponse, source_id: null },
        terminalResponse: { ...terminalResponse, source_id: null },
        sourceCreated: false,
        uploadResponseObserved: false,
      };
    case 'ocr':
      return {
        projectId,
        sourceId,
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
    case 'question':
      return {
        ...scopedCancellation(
          {
            projectId,
            sourceId,
            provider: 'ollama',
            model: 'qwen3.5:4b',
          },
          operationId,
          cancelResponse,
          terminalResponse,
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
          commit_started_at: '2026-07-14T00:00:05.000Z',
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
    case 'runtime': {
      const unavailableRequirement = {
        kind: 'ollama',
        available: false,
        unavailableReason: 'ollama_missing',
        installTargetPathRelative: 'runtimes/ollama',
      };
      return {
        ...scopedCancellation(
          {
            kind: 'ollama',
            provider: 'ollama',
            model: 'qwen3.5:4b',
          },
          operationId,
          operation(operationId, 'cancel_requested', 'canceling', false),
          operation(operationId, 'canceled', 'canceled', false),
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
    case 'model': {
      const missingTags = { modelNames: [] };
      const missingHealth = {
        provider: 'ollama',
        model: 'qwen3.5:4b',
        available: false,
        unavailableReason: 'model_missing',
        effectiveModel: null,
      };
      return {
        ...scopedCancellation(
          { provider: 'ollama', model: 'qwen3.5:4b' },
          operationId,
          operation(operationId, 'cancel_requested', 'canceling', false),
          operation(operationId, 'canceled', 'canceled', false),
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
): Record<string, unknown> {
  const responseScope = {
    ...(scope.projectId ? { project_id: scope.projectId } : {}),
    ...(scope.sourceId ? { source_id: scope.sourceId } : {}),
    ...(scope.kind ? { kind: scope.kind } : {}),
    provider: scope.provider,
    model: scope.model,
  };
  const commitStartedAt = '2026-07-14T00:00:05.000Z';
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
