import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  loadLocalCandidateOllamaFallbackPlan,
  runLocalCandidateOllamaFallbackAcceptance,
  writeLocalCandidateOllamaFallbackEvidence,
  type LocalCandidateOllamaFallbackPlan,
} from './local-candidate-ollama-fallback.mts';
import type { DocumentCancellationRunnerOptions } from '../packaged-resilience/args.mts';
import type { SmokeMetrics } from './types.mts';

test('local forced-Ollama plan launches the receipt-bound executable with verified local OCR', async () => {
  const fixture = planFixture();
  try {
    const plan = await loadLocalCandidateOllamaFallbackPlan(
      {},
      fixture.workspaceRoot,
      async () => fixture.installedCandidate,
    );

    assert.equal(
      plan.smokeOptions.exePath,
      fixture.installedCandidate.installedExePath,
    );
    assert.equal(plan.smokeOptions.pdfPath, fixture.installedCandidate.pdfPath);
    assert.equal(plan.smokeOptions.outDir, fixture.installedCandidate.outputRoot);
    assert.equal(
      plan.smokeOptions.appDataDir,
      join(fixture.installedCandidate.outputRoot, 'app-data'),
    );
    assert.equal(plan.smokeOptions.acceptanceLane, 'ollama-fallback');
    assert.equal(plan.smokeOptions.ollamaFallbackTrigger, 'declined-terms');
    assert.equal(plan.smokeOptions.llmProvider, 'auto');
    assert.equal(plan.smokeOptions.ollamaModel, 'qwen3.5:4b');
    assert.deepEqual(plan.smokeOptions.ollamaFallbackModels, ['qwen3.5:2b']);
    assert.equal(plan.smokeOptions.ocrProvider, 'windowsml');
    assert.equal(
      plan.smokeOptions.candidateDistributionProfile,
      'local_nonpublishable',
    );
    assert.equal(plan.smokeOptions.streamingCompleteTimeoutMs, 123_456);
  } finally {
    fixture.cleanup();
  }
});

test('Nx exposes a candidate-bound local target without rebuilding the executable', () => {
  const project = JSON.parse(
    readFileSync(
      join(process.cwd(), 'apps', 'cert-prep-desktop', 'project.json'),
      'utf8',
    ),
  ) as {
    targets: Record<
      string,
      {
        cache?: boolean;
        dependsOn?: readonly string[];
        options?: { command?: string };
      }
    >;
  };
  const target = project.targets['local-ollama-fallback-acceptance-nsis'];
  assert.ok(target);
  assert.equal(target.cache, false);
  assert.equal(target.dependsOn, undefined);
  assert.equal(
    target.options?.command,
    'node apps/cert-prep-desktop/scripts/packaged-streaming-ollama-fallback-local-windowsml.mts',
  );
});

test('local forced-Ollama plan rejects public candidates and non-NSIS receipts', async (t) => {
  const fixture = planFixture();
  try {
    await t.test('public candidate', async () => {
      await assert.rejects(
        loadLocalCandidateOllamaFallbackPlan(
          {},
          fixture.workspaceRoot,
          async () => ({
            ...fixture.installedCandidate,
            candidateDistributionProfile: 'public_unsigned_alpha',
          }),
        ),
        /requires an exact local_nonpublishable candidate/,
      );
    });
    await t.test('MSI receipt', async () => {
      await assert.rejects(
        loadLocalCandidateOllamaFallbackPlan(
          {},
          fixture.workspaceRoot,
          async () => ({
            ...fixture.installedCandidate,
            installation: {
              ...fixture.installedCandidate.installation,
              packageKind: 'msi',
            },
          }),
        ),
        /requires the schema-v1 NSIS install receipt/,
      );
    });
  } finally {
    fixture.cleanup();
  }
});

test('local forced-Ollama evidence binds candidate, run, receipt, exe, installer, and output hashes', () => {
  const fixture = planFixture();
  try {
    const plan = fixture.plan();
    const metrics = completedMetrics(fixture.installedCandidate.outputRoot);
    writePassedArtifacts(fixture.installedCandidate.outputRoot, metrics);

    const evidence = writeLocalCandidateOllamaFallbackEvidence(plan, metrics);
    assert.equal(evidence.schemaVersion, 1);
    assert.equal(evidence.passed, true);
    assert.equal(
      (evidence.candidate as Record<string, unknown>).candidateId,
      fixture.installedCandidate.candidate.candidateId,
    );
    assert.equal(
      (evidence.candidate as Record<string, unknown>).distributionProfile,
      'local_nonpublishable',
    );
    assert.equal(
      (evidence.installation as Record<string, unknown>).packageKind,
      'nsis',
    );
    const artifacts = evidence.artifacts as Record<
      string,
      Record<string, unknown>
    >;
    assert.equal(
      artifacts.metrics.sha256,
      sha256(join(fixture.installedCandidate.outputRoot, 'metrics.json')),
    );
    assert.equal(
      artifacts.productionSummary.sha256,
      sha256(
        join(
          fixture.installedCandidate.outputRoot,
          'production-summary.json',
        ),
      ),
    );
    const execution = evidence.execution as Record<string, unknown>;
    const observed = execution.observedAttribution as Record<string, unknown>;
    assert.equal(observed.providerPreference, 'auto');
    assert.equal(observed.configuredProvider, 'ollama');
    assert.equal(observed.effectiveProvider, 'ollama');
    assert.equal(observed.configuredModel, 'cert-prep-qwen3.5-4b-study-8k');
    assert.equal(observed.effectiveModel, 'cert-prep-qwen3.5-4b-study-8k');
    assert.equal(
      observed.providerFallbackReason,
      'FastFlowLM terms were declined.',
    );
    assert.equal(observed.modelFallbackReason, null);
    const release = observed.resourceRelease as Record<string, unknown>;
    assert.equal(
      (release.process as Record<string, unknown>).preCloseReleaseProven,
      true,
    );
    assert.equal(
      (release.model as Record<string, unknown>).effectiveModel,
      'cert-prep-qwen3.5-4b-study-8k',
    );
    const written = JSON.parse(
      readFileSync(
        join(
          fixture.installedCandidate.outputRoot,
          'local-ollama-fallback-evidence.json',
        ),
        'utf8',
      ),
    );
    assert.deepEqual(written, evidence);
    assert.throws(
      () => writeLocalCandidateOllamaFallbackEvidence(plan, metrics),
      /evidence already exists/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('local forced-Ollama evidence rejects incomplete or forged production output', async (t) => {
  const fixture = planFixture();
  try {
    const plan = fixture.plan();
    const metrics = completedMetrics(fixture.installedCandidate.outputRoot);
    await t.test('failed check', () => {
      writePassedArtifacts(fixture.installedCandidate.outputRoot, metrics, {
        checks: passingChecks({ acceptance_lane_provider_exact: false }),
      });
      assert.throws(
        () => writeLocalCandidateOllamaFallbackEvidence(plan, metrics),
        /does not prove the real declined-terms Ollama fallback lane/,
      );
    });
    await t.test('missing required check', () => {
      const checks = passingChecks();
      delete checks.acceptance_lane_job_evidence_bound;
      writePassedArtifacts(fixture.installedCandidate.outputRoot, metrics, {
        checks,
      });
      assert.throws(
        () => writeLocalCandidateOllamaFallbackEvidence(plan, metrics),
        /does not prove the real declined-terms Ollama fallback lane/,
      );
    });
    await t.test('provider attribution drift', () => {
      writePassedArtifacts(fixture.installedCandidate.outputRoot, metrics, {
        configured_provider: 'fastflowlm',
      });
      assert.throws(
        () => writeLocalCandidateOllamaFallbackEvidence(plan, metrics),
        /does not prove the real declined-terms Ollama fallback lane/,
      );
    });
    await t.test('model attribution drift', () => {
      writePassedArtifacts(fixture.installedCandidate.outputRoot, metrics, {
        effective_model: 'deterministic-fake',
      });
      assert.throws(
        () => writeLocalCandidateOllamaFallbackEvidence(plan, metrics),
        /not an accepted real Ollama model/,
      );
    });
    await t.test('fallback reason drift', () => {
      writePassedArtifacts(fixture.installedCandidate.outputRoot, metrics, {
        provider_fallback_reason: 'different reason',
      });
      assert.throws(
        () => writeLocalCandidateOllamaFallbackEvidence(plan, metrics),
        /does not prove the real declined-terms Ollama fallback lane/,
      );
    });
    await t.test('process release drift', () => {
      writePassedArtifacts(fixture.installedCandidate.outputRoot, metrics, {
        resources_released_at_end: processRelease({
          alive_owned_processes: [{ pid: 42, name: 'ollama.exe' }],
        }),
      });
      assert.throws(
        () => writeLocalCandidateOllamaFallbackEvidence(plan, metrics),
        /does not prove released Ollama process resources/,
      );
    });
  } finally {
    fixture.cleanup();
  }
});

test('local forced-Ollama module runs its CLI when executed directly', () => {
  const result = spawnSync(
    process.execPath,
    [
      join(
        process.cwd(),
        'apps',
        'cert-prep-desktop',
        'scripts',
        'packaged-flow-smoke',
        'local-candidate-ollama-fallback.mts',
      ),
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {},
      windowsHide: true,
    },
  );
  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /CERT_PREP_RESILIENCE_CANDIDATE_ROOT is required/,
  );
});

test('local forced-Ollama orchestration revalidates the binding after the smoke run', async () => {
  const fixture = planFixture();
  try {
    const metrics = completedMetrics(fixture.installedCandidate.outputRoot);
    let launchedExecutable = '';
    const evidence = await runLocalCandidateOllamaFallbackAcceptance(
      {},
      fixture.workspaceRoot,
      {
        loadDocumentOptions: async () => fixture.installedCandidate,
        reloadInstalledCandidate: async () => fixture.installedCandidate,
        runSmoke: async (options) => {
          launchedExecutable = options.exePath;
          writePassedArtifacts(fixture.installedCandidate.outputRoot, metrics);
          return metrics;
        },
      },
    );
    assert.equal(
      launchedExecutable,
      fixture.installedCandidate.installedExePath,
    );
    assert.equal(evidence.passed, true);

    const changed = {
      ...fixture.installedCandidate,
      installation: {
        ...fixture.installedCandidate.installation,
        installedExeSha256: '0'.repeat(64),
      },
    };
    await assert.rejects(
      runLocalCandidateOllamaFallbackAcceptance(
        {},
        fixture.workspaceRoot,
        {
          loadDocumentOptions: async () => fixture.installedCandidate,
          reloadInstalledCandidate: async () => changed,
          runSmoke: async () => metrics,
        },
      ),
      /binding changed during forced-Ollama acceptance/,
    );
  } finally {
    fixture.cleanup();
  }
});

interface PlanFixture {
  readonly workspaceRoot: string;
  readonly installedCandidate: DocumentCancellationRunnerOptions;
  plan(): LocalCandidateOllamaFallbackPlan;
  cleanup(): void;
}

function planFixture(): PlanFixture {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'local-ollama-fallback-'));
  const candidateRoot = join(workspaceRoot, 'candidate');
  const outputRoot = join(
    workspaceRoot,
    'tmp',
    'cert-prep-desktop',
    'packaged-streaming-ollama-fallback-local',
  );
  const installedExePath = join(workspaceRoot, 'installed', 'Cert Prep.exe');
  const pdfPath = join(workspaceRoot, 'acceptance.pdf');
  const receiptPath = join(workspaceRoot, 'install-receipt.json');
  mkdirSync(dirname(installedExePath), { recursive: true });
  mkdirSync(join(outputRoot, '..'), { recursive: true });
  writeFileSync(installedExePath, 'installed candidate executable');
  writeFileSync(pdfPath, '%PDF-1.7 acceptance fixture');
  writeFileSync(receiptPath, '{}');
  const installedCandidate: DocumentCancellationRunnerOptions = {
    workspaceRoot,
    candidateRoot,
    installedExePath,
    pdfPath,
    outputRoot,
    diagnosticsRoot: `${outputRoot}.diagnostics`,
    acceptanceRunId: 'acceptance-run-0001',
    candidate: {
      candidateId: 'a'.repeat(64),
      version: '0.1.0-alpha.1',
      tag: `cert-prep-local-v0.1.0-alpha.1-${'b'.repeat(12)}`,
      commitSha: 'b'.repeat(40),
      harnessSha256: 'c'.repeat(64),
    },
    candidateDistributionProfile: 'local_nonpublishable',
    installation: {
      receiptPath,
      receiptSha256: 'd'.repeat(64),
      packageKind: 'nsis',
      installerRelativePath:
        'release/installers/Cert Prep_0.1.0-alpha.1_x64-setup.exe',
      installerSha256: 'e'.repeat(64),
      installedExeName: 'Cert Prep.exe',
      installedExeBytes: 30,
      installedExeSha256: 'f'.repeat(64),
      installedAt: '2026-07-15T00:00:00.000Z',
    },
    timeoutMs: 123_456,
    latePublishObservationWindowMs: 2_000,
    cdpPort: 9_591,
  };
  return {
    workspaceRoot,
    installedCandidate,
    plan() {
      return {
        installedCandidate,
        smokeOptions: {
          workspaceRoot,
          exePath: installedExePath,
          pdfPath,
          outDir: outputRoot,
          appDataDir: join(outputRoot, 'app-data'),
          cdpPort: 9_591,
          ocrProvider: 'windowsml',
          ocrPageWorkers: 1,
          llmProvider: 'auto',
          ollamaModel: 'qwen3.5:4b',
          ollamaFallbackModels: ['qwen3.5:2b'],
          acceptanceLane: 'ollama-fallback',
          candidateDistributionProfile: 'local_nonpublishable',
          ollamaFallbackTrigger: 'declined-terms',
          streamingDraftPageLimit: 1,
          streamingDraftWorkers: 1,
          waitForStreamingComplete: true,
          streamingCompleteTimeoutMs: 123_456,
          skipGpuSampling: false,
          productionSummary: true,
          allowOcrChunkVariance: true,
          verifyStreamingPracticeReady: true,
          recordVideo: false,
        },
      };
    },
    cleanup() {
      rmSync(workspaceRoot, { recursive: true, force: true });
    },
  };
}

function completedMetrics(outputRoot: string): SmokeMetrics {
  return {
    status: 'completed',
    started_at: '2026-07-15T00:01:00.000Z',
    finished_at: '2026-07-15T00:02:00.000Z',
    out_dir: outputRoot,
    screenshots: [],
    ui_timings_ms: {},
    observations: [],
    errors: [],
    llm_provider: 'auto',
    llm_model: 'qwen3.5:4b',
    llm_fallback_models: ['qwen3.5:2b'],
    ocr_provider: 'windowsml',
    first_chunk_gate_ms: 15_000,
    first_chunk_under_gate: true,
    streaming_questions: {
      job_snapshots: [],
      question_snapshots: [],
      status_counts: {},
    },
  };
}

function writePassedArtifacts(
  outputRoot: string,
  metrics: SmokeMetrics,
  summaryOverrides: Readonly<Record<string, unknown>> = {},
): void {
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(
    join(outputRoot, 'metrics.json'),
    `${JSON.stringify(metrics, null, 2)}\n`,
  );
  const summary = {
    schema_version: 4,
    status: 'passed',
    acceptance_lane: 'ollama-fallback',
    provider_preference: 'auto',
    configured_provider: 'ollama',
    llm_provider: 'ollama',
    configured_model: 'cert-prep-qwen3.5-4b-study-8k',
    effective_model: 'cert-prep-qwen3.5-4b-study-8k',
    provider_fallback_reason: 'FastFlowLM terms were declined.',
    model_fallback_reason: null,
    resources_released_at_end: processRelease(),
    checks: passingChecks(),
    ollama_fallback_acceptance: {
      schema_version: 1,
      trigger: 'declined-terms',
      overrides_used: false,
      fake_provider_observed: false,
      provider_fallback_reason: 'FastFlowLM terms were declined.',
      model_fallback_reason: null,
      resource_release: {
        captured_at: '2026-07-15T00:01:55.000Z',
        effective_model: 'cert-prep-qwen3.5-4b-study-8k',
        loaded_models: [],
        released: true,
      },
    },
    ...summaryOverrides,
  };
  writeFileSync(
    join(outputRoot, 'production-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
}

function passingChecks(
  overrides: Readonly<Record<string, boolean>> = {},
): Record<string, boolean> {
  return {
    acceptance_lane_preference_exact: true,
    acceptance_lane_provider_exact: true,
    acceptance_lane_model_exact: true,
    acceptance_lane_provider_fallback_reason_present: true,
    acceptance_lane_model_fallback_reason_separate: true,
    acceptance_lane_route_persisted: true,
    acceptance_lane_no_overrides_or_fake: true,
    acceptance_lane_runtime_real: true,
    acceptance_lane_job_evidence_bound: true,
    acceptance_lane_usable_and_full_exam: true,
    acceptance_lane_ollama_model_released: true,
    acceptance_lane_fresh_run_isolation: true,
    acceptance_lane_process_isolation: true,
    ...overrides,
  };
}

function processRelease(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    captured_at: '2026-07-15T00:01:58.000Z',
    released: true,
    pre_close_captured_at: '2026-07-15T00:01:57.000Z',
    pre_close_release_proven: true,
    pre_close_stable_empty_snapshots: 2,
    stable_empty_snapshots: 2,
    observed_owned_processes: [{ pid: 41, name: 'ollama.exe' }],
    alive_owned_processes: [],
    ...overrides,
  };
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
