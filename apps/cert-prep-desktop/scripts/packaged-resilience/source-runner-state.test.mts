import assert from 'node:assert/strict';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import type { SmokeRunState } from '../packaged-flow-smoke/types.mts';
import type { SourceCancellationRunnerOptions } from './args.mts';
import { runSourceCancellationAcceptance } from './source-runner.mts';

// Pins the run state the source runner hands to the shared smoke helpers.
test('source runner builds the packaged smoke run state from its options', async () => {
  const workspaceRoot = join(process.cwd(), 'workspace-fixture');
  const diagnosticsRoot = join(workspaceRoot, 'tmp', 'diagnostics');
  const options = {
    workspaceRoot,
    installedExePath: join(workspaceRoot, 'Cert Prep.exe'),
    pdfPath: join(workspaceRoot, 'acceptance.pdf'),
    diagnosticsRoot,
    candidateDistributionProfile: 'public_unsigned_alpha',
    timeoutMs: 12_345,
    cdpPort: 9591,
  } as unknown as SourceCancellationRunnerOptions;
  let seen: SmokeRunState | undefined;
  let startedAt = '';

  await assert.rejects(
    runSourceCancellationAcceptance(options, {
      prepareRunDirectories(run) {
        seen = structuredClone(run);
        startedAt = run.metrics.started_at;
        throw new Error('stop after run-state capture');
      },
    }),
    /stop after run-state capture/,
  );

  assert.ok(seen);
  assert.deepEqual(seen.options, {
    workspaceRoot,
    exePath: options.installedExePath,
    pdfPath: options.pdfPath,
    outDir: diagnosticsRoot,
    appDataDir: join(diagnosticsRoot, 'app-data'),
    cdpPort: 9591,
    llmProvider: 'auto',
    acceptanceIsolation: true,
    candidateDistributionProfile: 'public_unsigned_alpha',
    waitForQuestionJobs: false,
    questionJobsCompleteTimeoutMs: 12_345,
    skipGpuSampling: true,
    productionSummary: false,
    allowCaptureChunkVariance: true,
    verifyGeneratedQuestionsPracticeReady: false,
  });
  assert.equal(Number.isNaN(Date.parse(startedAt)), false);
  assert.deepEqual(seen.metrics, {
    status: 'running',
    started_at: startedAt,
    out_dir: diagnosticsRoot,
    screenshots: [],
    ui_timings_ms: {},
    observations: [],
    errors: [],
    llm_provider: 'auto',
    llm_model: seen.metrics.llm_model,
    llm_configured_model: seen.metrics.llm_model,
    generation_readiness_at_start: seen.metrics.generation_readiness_at_start,
    first_chunk_gate_ms: 15_000,
    first_chunk_under_gate: false,
    wait_for_question_jobs: false,
    practice_ready_from_generated_questions: false,
    app_data_dir: relative(workspaceRoot, join(diagnosticsRoot, 'app-data')),
    question_generation: {
      job_snapshots: [],
      question_snapshots: [],
      status_counts: {},
    },
  });
  assert.deepEqual(
    { ...seen, options: null, metrics: null },
    {
      options: null,
      metrics: null,
      app: null,
      appExit: null,
      resourceSampling: null,
      browser: null,
      page: null,
      port: 9591,
      processBaseline: { all: [], nodePids: new Set() },
      projectApi: null,
      uploadedSource: null,
      questionObservationStartedAt: null,
      questionObservationActive: false,
      questionGenerationApiPollErrorCaptured: false,
    },
  );
});
