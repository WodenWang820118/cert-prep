import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  buildValidResilienceEvidence,
  buildValidSessionRestartEvidence,
  FIXTURE_CANDIDATE,
} from './evidence-fixtures.mts';
import { writeSessionRestartEvidence } from './evidence-writer.mts';
import type { OwnedProcessesReleasedProof } from './owned-process-evidence.mts';
import type { RemainingResilienceOptions } from './remaining-options.mts';
import type { JsonTransport } from './api-client.mts';
import {
  runRemainingResilienceAcceptance,
  type RemainingResilienceRunnerDependencies,
  type RemainingScenarioProofs,
  type TimedProof,
  waitForValidatedManualDraftPublication,
} from './resilience-runner.mts';

test('remaining resilience runner atomically publishes four checks and session restart after cleanup', async () => {
  const fixture = runnerFixture();
  try {
    const calls: string[] = [];
    const result = await runRemainingResilienceAcceptance(
      fixture.options,
      testDependencies(calls),
    );

    assert.deepEqual(calls, [
      'prepare',
      'baseline',
      'ollama-start',
      'capture:90',
      'launch',
      'scenarios',
      'capture:90',
      'capture:100',
      'cleanup',
      'ollama-stop',
      'released:100',
    ]);
    assert.deepEqual(readdirSync(result.outputRoot).sort(), [
      'cancellation',
      'session-restart.json',
    ]);
    assert.deepEqual(
      readdirSync(join(result.outputRoot, 'cancellation')).sort(),
      [
        'draft.json',
        'model.json',
        'ownedProcessesReleased.json',
        'runtime.json',
      ],
    );
    const draft = JSON.parse(
      readFileSync(
        join(result.outputRoot, 'cancellation', 'draft.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const proof = draft.proof as Record<string, unknown>;
    const installation = proof.installationBinding as Record<string, unknown>;
    const manualTerminal = proof.manualDraftTerminalResponse as Record<
      string,
      unknown
    >;
    assert.equal(
      installation.receiptSha256,
      fixture.options.installation.receiptSha256,
    );
    assert.equal(installation.installedExeSha256, 'f'.repeat(64));
    assert.deepEqual(
      {
        operationId: manualTerminal.id,
        strategy: manualTerminal.strategy,
        status: manualTerminal.status,
        phase: manualTerminal.phase,
        generatedCount: manualTerminal.generated_count,
        effectiveProvider: manualTerminal.effective_provider,
        effectiveModel: manualTerminal.effective_model,
        fallbackReason: manualTerminal.fallback_reason,
      },
      {
        operationId: 'operation-commit',
        strategy: 'hybrid_reasoning',
        status: 'succeeded',
        phase: 'completed',
        generatedCount: 2,
        effectiveProvider: 'ollama',
        effectiveModel: 'qwen3.5:4b',
        fallbackReason: null,
      },
    );
    assert.equal(result.sessionRestart.path, 'session-restart.json');
  } finally {
    fixture.cleanup();
  }
});

test('remaining resilience runner publishes nothing when a scenario fails', async () => {
  const fixture = runnerFixture();
  try {
    const calls: string[] = [];
    await assert.rejects(
      runRemainingResilienceAcceptance(fixture.options, {
        ...testDependencies(calls),
        executeScenarios: async () => {
          calls.push('scenarios');
          throw new Error('model scenario failed');
        },
      }),
      /model scenario failed/,
    );
    assert.equal(existsSync(fixture.options.outputRoot), false);
    assert.equal(
      readdirSync(join(fixture.options.outputRoot, '..')).some((name) =>
        name.includes('.packaged-resilience.preparing-'),
      ),
      false,
    );
    assert.ok(calls.includes('cleanup'));
    assert.equal(
      calls.some((call) => call.startsWith('released:')),
      false,
    );
  } finally {
    fixture.cleanup();
  }
});

test('remaining resilience runner removes staging when session evidence write fails', async () => {
  const fixture = runnerFixture();
  try {
    const calls: string[] = [];
    await assert.rejects(
      runRemainingResilienceAcceptance(fixture.options, {
        ...testDependencies(calls),
        writeSessionEvidence: () => {
          throw new Error('session write failed');
        },
      }),
      /session write failed/,
    );
    assert.equal(existsSync(fixture.options.outputRoot), false);
    assert.equal(
      readdirSync(join(fixture.options.outputRoot, '..')).some((name) =>
        name.includes('.packaged-resilience.preparing-'),
      ),
      false,
    );
  } finally {
    fixture.cleanup();
  }
});

test('manual draft terminal with zero generated drafts fails before publication polling', async () => {
  let requestCount = 0;
  const transport: JsonTransport = {
    async request() {
      requestCount += 1;
      throw new Error('question drafts must not be polled');
    },
  };

  await assert.rejects(
    waitForValidatedManualDraftPublication(
      transport,
      {
        id: 'operation-commit',
        project_id: 'project-1',
        document_id: 'document-1',
        strategy: 'hybrid_reasoning',
        status: 'succeeded',
        phase: 'completed',
        cancellable: false,
        provider: 'ollama',
        model: 'qwen3.5:4b',
        effective_provider: 'ollama',
        effective_model: 'qwen3.5:4b',
        fallback_reason: null,
        generated_count: 0,
        commit_started_at: '2026-07-15T12:00:00.000Z',
      },
      {
        operationId: 'operation-commit',
        commitStartedAt: '2026-07-15T12:00:00.000Z',
        projectId: 'project-1',
        documentId: 'document-1',
      },
      10_000,
    ),
    /manual draft terminal cannot satisfy durable evidence; expected hybrid_reasoning, at least 2 generated drafts, exact effective Ollama attribution, and no fallback/,
  );
  assert.equal(requestCount, 0);
});

function testDependencies(
  calls: string[],
): Partial<RemainingResilienceRunnerDependencies> {
  const timestamps = [
    '2026-07-11T01:00:01.100Z',
    '2026-07-11T01:00:03.800Z',
    '2026-07-11T01:00:03.900Z',
  ];
  return {
    now: () => new Date(timestamps.shift() ?? '2026-07-11T01:00:03.900Z'),
    prepareRunDirectories(run) {
      calls.push('prepare');
      mkdirSync(run.options.outDir, { recursive: true });
      mkdirSync(run.options.appDataDir ?? join(run.options.outDir, 'app-data'));
    },
    processSnapshot() {
      calls.push('baseline');
      return { all: [], nodePids: new Set() };
    },
    async launchAppAndConnect(run) {
      calls.push('launch');
      run.app = {
        pid: 100,
        exitCode: null,
        killed: false,
      } as NonNullable<typeof run.app>;
    },
    async startIsolatedOllama({ host, modelsRoot }) {
      calls.push('ollama-start');
      return {
        pid: 90,
        host,
        modelsRoot,
        startedAt: '2026-07-11T01:00:00.000Z',
        async stop() {
          calls.push('ollama-stop');
        },
      };
    },
    async executeScenarios() {
      calls.push('scenarios');
      return validScenarioProofs();
    },
    async cleanupAfterRun(run) {
      calls.push('cleanup');
      run.app = null;
      run.browser = null;
      run.metrics.final_close = {
        label: 'final cleanup',
        app_pid: 100,
        normal_close_requested: true,
        exited_after_normal_close: true,
        forced: false,
        residue: [],
        gracefulExited: true,
        fallbackUsed: false,
        exitCode: 0,
        residualProcesses: [],
      };
      run.metrics.process_cleanup = {
        node_cleanup_summary: {
          baseline_node_count: 0,
          closed_count: 0,
          closed: [],
        },
        new_node_helpers_closed: [],
        residue_after_close: [],
      };
    },
    installShutdownCleanup() {
      return () => undefined;
    },
    createProcessTracker() {
      return {
        captureAppTree(appPid) {
          calls.push(`capture:${appPid}`);
          return [appPid, 101];
        },
        async proveReleased(appPid, closedAt) {
          calls.push(`released:${appPid}`);
          return validProcessProof(appPid, closedAt);
        },
      };
    },
    writeSessionEvidence: writeSessionRestartEvidence,
    stagingId: () => 'fixture-staging-id',
  };
}

function validScenarioProofs(): RemainingScenarioProofs {
  return {
    draft: timedFixture('draft'),
    runtime: timedFixture('runtime'),
    model: timedFixture('model'),
    sessionRestart: timedSessionFixture(),
  };
}

function timedFixture(check: 'draft' | 'runtime' | 'model'): TimedProof {
  const fixture = buildValidResilienceEvidence(check);
  return {
    startedAt: String(fixture.startedAt),
    completedAt: String(fixture.completedAt),
    proof: fixture.proof as Record<string, unknown>,
  };
}

function timedSessionFixture(): TimedProof {
  const fixture = buildValidSessionRestartEvidence();
  return {
    startedAt: String(fixture.startedAt),
    completedAt: String(fixture.completedAt),
    proof: fixture.proof as Record<string, unknown>,
  };
}

function validProcessProof(
  appPid: number,
  closedAt: string,
): OwnedProcessesReleasedProof {
  return {
    appPid,
    observedAppPids: [appPid],
    observedOwnedPids: [appPid, 101],
    finalOwnedPids: [],
    stableEmptySnapshots: 2,
    residueCount: 0,
    closedAt,
  };
}

interface RunnerFixture {
  readonly options: RemainingResilienceOptions;
  cleanup(): void;
}

function runnerFixture(): RunnerFixture {
  const workspaceRoot = mkdtempSync(
    join(tmpdir(), 'cert-prep-resilience-runner-'),
  );
  const pdfPath = join(workspaceRoot, 'acceptance.pdf');
  const installedExePath = join(workspaceRoot, 'Cert Prep.exe');
  writeFileSync(pdfPath, '%PDF-1.7 acceptance fixture');
  writeFileSync(installedExePath, 'candidate executable');
  const outputRoot = join(
    workspaceRoot,
    'tmp',
    'cert-prep-desktop',
    'packaged-resilience',
  );
  mkdirSync(join(outputRoot, '..'), { recursive: true });
  return {
    options: {
      workspaceRoot,
      candidateRoot: join(workspaceRoot, 'candidate'),
      installedExePath,
      pdfPath,
      outputRoot,
      diagnosticsRoot: `${outputRoot}.diagnostics`,
      acceptanceRunId: 'acceptance-run-0001',
      candidate: FIXTURE_CANDIDATE,
      candidateDistributionProfile: 'public_unsigned_alpha',
      installation: {
        receiptPath: join(workspaceRoot, 'install-receipt.json'),
        receiptSha256: 'd'.repeat(64),
        packageKind: 'nsis',
        installerRelativePath:
          'release/installers/Cert Prep_0.1.0-alpha.1_x64-setup.exe',
        installerSha256: 'b'.repeat(64),
        installedExeName: 'Cert Prep.exe',
        installedExeBytes: 20,
        installedExeSha256: 'f'.repeat(64),
        installedAt: '2026-07-11T00:55:00.000Z',
      },
      timeoutMs: 10_000,
      latePublishObservationWindowMs: 2_000,
      cdpPort: 9591,
      ollamaExePath: join(workspaceRoot, 'ollama.exe'),
      ollamaHost: '127.0.0.1:11591',
      ollamaModelsRoot: join(`${outputRoot}.diagnostics`, 'ollama-models'),
    },
    cleanup() {
      rmSync(workspaceRoot, { recursive: true, force: true });
    },
  };
}
