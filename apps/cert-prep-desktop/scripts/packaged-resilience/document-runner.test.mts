import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import type { Page } from 'playwright';

import type { SmokeRunState } from '../packaged-flow-smoke/types.mts';
import type { JsonTransport } from './api-client.mts';
import type {
  DocumentCancellationProofs,
  UploadCancellationProof,
} from './document-cancellation.mts';
import type { DocumentCancellationRunnerOptions } from './args.mts';
import {
  runDocumentCancellationAcceptance,
  type DocumentRunnerDependencies,
} from './document-runner.mts';
import { buildValidResilienceEvidence } from './evidence-fixtures.mts';
import { writeResilienceEvidence } from './evidence-writer.mts';
import type { ResilienceCheck } from './evidence-contract.mts';

const transport: JsonTransport = {
  request: async () => {
    throw new Error('transport should be owned by the injected scenarios');
  },
};

test('document runner publishes exactly five candidate-bound files after cleanup', async () => {
  const fixture = runnerFixture();
  const events: string[] = [];
  try {
    const result = await runDocumentCancellationAcceptance(
      fixture.options,
      runnerDependencies(events),
    );

    assert.deepEqual(Object.keys(result.evidence).sort(), [
      'cancelVsCompleteRace',
      'crashRecovery',
      'ocr',
      'partialDataRemoved',
      'upload',
    ]);
    assert.deepEqual(
      readdirSync(join(fixture.options.outputRoot, 'cancellation')).sort(),
      [
        'cancelVsCompleteRace.json',
        'crashRecovery.json',
        'ocr.json',
        'partialDataRemoved.json',
        'upload.json',
      ],
    );
    assert.equal(
      existsSync(join(fixture.options.outputRoot, 'session-restart.json')),
      false,
    );
    assert.equal(
      existsSync(
        join(
          fixture.options.outputRoot,
          'cancellation',
          'ownedProcessesReleased.json',
        ),
      ),
      false,
    );
    for (const check of [
      'upload',
      'ocr',
      'cancelVsCompleteRace',
      'crashRecovery',
      'partialDataRemoved',
    ] as const) {
      const artifact = JSON.parse(
        readFileSync(
          join(fixture.options.outputRoot, 'cancellation', `${check}.json`),
          'utf8',
        ),
      ) as { proof: { installationBinding: unknown } };
      assert.deepEqual(artifact.proof.installationBinding, {
        receiptSha256: fixture.options.installation.receiptSha256,
        packageKind: fixture.options.installation.packageKind,
        installerRelativePath:
          fixture.options.installation.installerRelativePath,
        installerSha256: fixture.options.installation.installerSha256,
        installedExeName: fixture.options.installation.installedExeName,
        installedExeBytes: fixture.options.installation.installedExeBytes,
        installedExeSha256: fixture.options.installation.installedExeSha256,
        installedAt: fixture.options.installation.installedAt,
      });
    }
    assert.deepEqual(events, [
      'launch',
      'python-runtime',
      'ocr-runtime',
      'create-project',
      'upload-scenario',
      'document-scenario',
      'forced-crash',
      'capture-restart-api',
      'cleanup',
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('document runner does not publish partial evidence when a scenario fails', async () => {
  const fixture = runnerFixture();
  const dependencies = runnerDependencies([]);
  try {
    await assert.rejects(
      runDocumentCancellationAcceptance(fixture.options, {
        ...dependencies,
        runUploadScenario: async () => {
          throw new Error('upload cancellation lost the race');
        },
      }),
      /upload cancellation lost the race/,
    );

    assert.equal(existsSync(fixture.options.outputRoot), false);
    assert.equal(
      readdirSync(join(fixture.options.outputRoot, '..')).some((name) =>
        name.includes('.preparing-'),
      ),
      false,
    );
  } finally {
    fixture.cleanup();
  }
});

test('document runner removes staging and output when evidence writing fails midway', async () => {
  const fixture = runnerFixture();
  const dependencies = runnerDependencies([]);
  let writeCalls = 0;
  try {
    await assert.rejects(
      runDocumentCancellationAcceptance(fixture.options, {
        ...dependencies,
        writeEvidence(stagingRoot, check, envelope) {
          writeCalls += 1;
          if (writeCalls === 3) {
            throw new Error('simulated evidence writer interruption');
          }
          return writeResilienceEvidence(stagingRoot, check, envelope);
        },
      }),
      /simulated evidence writer interruption/,
    );

    assert.equal(writeCalls, 3);
    assert.equal(existsSync(fixture.options.outputRoot), false);
    assert.equal(
      readdirSync(join(fixture.options.outputRoot, '..')).some((name) =>
        name.startsWith(`.${basename(fixture.options.outputRoot)}.preparing-`),
      ),
      false,
    );
  } finally {
    fixture.cleanup();
  }
});

test('document runner refuses evidence publication when cleanup records residue', async () => {
  const fixture = runnerFixture();
  const dependencies = runnerDependencies([]);
  try {
    await assert.rejects(
      runDocumentCancellationAcceptance(fixture.options, {
        ...dependencies,
        cleanupAfterRun: async (run) => {
          completeCleanup(run);
          run.metrics.errors.push('backend residue remained');
        },
      }),
      /cleanup recorded errors/,
    );

    assert.equal(existsSync(fixture.options.outputRoot), false);
  } finally {
    fixture.cleanup();
  }
});

function runnerDependencies(
  events: string[],
): Partial<DocumentRunnerDependencies> {
  let clock = Date.parse('2026-07-14T01:00:00.000Z');
  return {
    now: () => {
      clock += 1_000;
      return new Date(clock);
    },
    prepareRunDirectories(run) {
      mkdirSync(run.options.appDataDir ?? '', { recursive: true });
    },
    processSnapshot: () => ({ all: [], nodePids: new Set() }),
    async launchAppAndConnect(run) {
      events.push('launch');
      run.page = {} as Page;
    },
    async installPythonRuntimeIfNeeded() {
      events.push('python-runtime');
    },
    async installOcrRuntimeIfNeeded() {
      events.push('ocr-runtime');
    },
    async createProject(run) {
      events.push('create-project');
      run.projectApi = {
        apiBaseUrl: 'http://127.0.0.1:8000',
        authorization: 'Bearer original-token',
        projectId: 'project-1',
      };
    },
    createTransport: () => transport,
    async runUploadScenario() {
      events.push('upload-scenario');
      return uploadProof();
    },
    async runDocumentScenario(options) {
      events.push('document-scenario');
      if (!options.restartAfterCancel) {
        throw new Error('restart callback was not configured');
      }
      await options.restartAfterCancel({
        id: 'operation-1',
        status: 'cancel_requested',
        phase: 'canceling',
        cancellable: false,
      });
      return documentProofs();
    },
    async forceCrashAndReconnect(run) {
      events.push('forced-crash');
      run.page = {} as Page;
      run.projectApi = null;
      return {
        appPid: 100,
        termination: {
          attempted: true,
          method: 'taskkill_process_tree',
          exitCode: 0,
          error: null,
        },
      };
    },
    async captureProjectApiAfterRestart() {
      events.push('capture-restart-api');
      return {
        apiBaseUrl: 'http://127.0.0.1:8001',
        authorization: 'Bearer restarted-token',
        projectId: 'project-1',
      };
    },
    async cleanupAfterRun(run) {
      events.push('cleanup');
      completeCleanup(run);
    },
    installShutdownCleanup: () => () => undefined,
    stagingId: () => 'fixed-staging-id',
  };
}

function completeCleanup(run: SmokeRunState): void {
  run.app = null;
  run.browser = null;
  run.page = null;
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
}

function uploadProof(): UploadCancellationProof {
  return proof('upload') as unknown as UploadCancellationProof;
}

function documentProofs(): DocumentCancellationProofs {
  return {
    ocr: proof('ocr'),
    partialDataRemoved: proof('partialDataRemoved'),
    cancelVsCompleteRace: proof('cancelVsCompleteRace'),
    crashRecovery: proof('crashRecovery'),
  };
}

function proof(check: ResilienceCheck): Record<string, unknown> {
  const value = {
    ...(buildValidResilienceEvidence(check).proof as Record<string, unknown>),
  };
  delete value.installationBinding;
  return value;
}

interface RunnerFixture {
  readonly options: DocumentCancellationRunnerOptions;
  cleanup(): void;
}

function runnerFixture(): RunnerFixture {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cert-prep-runner-'));
  const pdfPath = join(workspaceRoot, 'acceptance.pdf');
  const installedExePath = join(workspaceRoot, 'Cert Prep.exe');
  writeFileSync(pdfPath, '%PDF-1.7 acceptance fixture');
  writeFileSync(installedExePath, 'candidate executable');
  const outputRoot = join(
    workspaceRoot,
    'tmp',
    'cert-prep-desktop',
    'packaged-document-cancellation',
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
      candidate: {
        candidateId: 'e'.repeat(64),
        version: '0.1.0-alpha.1',
        tag: 'cert-prep-v0.1.0-alpha.1',
        commitSha: 'a'.repeat(40),
        harnessSha256: 'c'.repeat(64),
      },
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
        installedAt: '2026-07-14T00:00:00.000Z',
      },
      timeoutMs: 10_000,
      latePublishObservationWindowMs: 2_000,
      cdpPort: 9591,
    },
    cleanup() {
      rmSync(workspaceRoot, { recursive: true, force: true });
    },
  };
}
