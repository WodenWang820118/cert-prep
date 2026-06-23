import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { parsePackagedFlowSmokeArgs } from './args.mts';
import { cleanupAfterRunWithTimeout, launchAppAndConnect, restartAndVerifyPersistence } from './app-lifecycle.mts';
import {
  createAndEditQuestion,
  createProject,
  runFullExamWrongAnswer,
  runRandomQuizCorrectClear,
  uploadAndParsePdf,
  verifyStreamingPracticeReady,
} from './flow-steps.mts';
import { processSnapshot } from './processes.mts';
import { preparePackagedBackendRuntimeForSmoke } from './runtime-sync.mts';
import { installOcrRuntimeIfNeeded, installPythonRuntimeIfNeeded } from './runtime-install-flow.mts';
import { startResourceSampling } from './resource-sampling.mts';
import { log, screenshot } from './runner-context.mts';
import { writeStreamingBaselineArtifacts } from './streaming-baseline-report.mts';
import { refreshFirstChunkGateMetrics } from './streaming-capture.mts';
import { FIRST_CHUNK_GATE_MS } from './streaming-evidence.mts';
import { errorMessage, normalizePath } from './text-utils.mts';
import type { SmokeMetrics, SmokeRunState } from './types.mts';

async function runFlow(run: SmokeRunState): Promise<void> {
  if (!existsSync(run.options.exePath)) {
    throw new Error(`Missing packaged exe: ${run.options.exePath}`);
  }
  if (!existsSync(run.options.pdfPath)) {
    throw new Error(`Missing QA PDF: ${run.options.pdfPath}`);
  }

  log(run, `artifact dir ${run.options.outDir}`);
  run.processBaseline = processSnapshot();
  run.resourceSampling = startResourceSampling({
    skipGpuSampling: run.options.skipGpuSampling,
    outDir: run.options.outDir,
    workspaceRoot: run.options.workspaceRoot,
    observe: (message) => run.metrics.observations.push(message),
  });
  if (Object.keys(run.resourceSampling.artifacts).length > 0) {
    run.metrics.resource_sampling = run.resourceSampling.artifacts;
    run.metrics.gpu_sampling = run.resourceSampling.artifacts.nvidia_smi_csv;
  }
  preparePackagedBackendRuntimeForSmoke({
    workspaceRoot: run.options.workspaceRoot,
    outDir: run.options.outDir,
    appDataDir: run.options.appDataDir,
    metrics: run.metrics,
  });
  await launchAppAndConnect(run);
  await installPythonRuntimeIfNeeded(run);
  await installOcrRuntimeIfNeeded(run);
  await createProject(run);
  await uploadAndParsePdf(run);
  if (run.options.waitForStreamingComplete) {
    if (run.options.verifyStreamingPracticeReady) {
      await verifyStreamingPracticeReady(run);
    }
    run.metrics.status = 'completed';
    log(run, 'streaming baseline completed');
    return;
  }
  await createAndEditQuestion(run);
  await runFullExamWrongAnswer(run);
  await runRandomQuizCorrectClear(run);
  await restartAndVerifyPersistence(run);
  run.metrics.status = 'completed';
  log(run, 'flow completed');
}

function saveMetrics(run: SmokeRunState): void {
  refreshFirstChunkGateMetrics(run);
  run.metrics.finished_at = new Date().toISOString();
  writeFileSync(
    join(run.options.outDir, 'metrics.json'),
    `${JSON.stringify(run.metrics, null, 2)}\n`,
  );
}

function writeCloseoutArtifacts(
  run: SmokeRunState,
  label: string,
  { recordBaselineFailure }: { readonly recordBaselineFailure: boolean },
): void {
  try {
    run.metrics.observations.push(`closeout checkpoint: ${label}`);
    writeStreamingBaselineArtifacts(run, { recordFailure: recordBaselineFailure });
    saveMetrics(run);
  } catch (error) {
    run.metrics.errors.push(
      `${label} artifact write failed: ${errorMessage(error)}`,
    );
  }
}

function logFinalMetricsSummary(run: SmokeRunState): void {
  console.log(
    JSON.stringify(
      {
        status: run.metrics.status,
        error_count: run.metrics.errors.length,
        out_dir: normalizePath(relative(run.options.workspaceRoot, run.options.outDir)),
        metrics_json: normalizePath(
          relative(run.options.workspaceRoot, join(run.options.outDir, 'metrics.json')),
        ),
        streaming_baseline: run.metrics.streaming_baseline ?? null,
        production_summary: run.metrics.production_summary ?? null,
      },
      null,
      2,
    ),
  );
}

export async function runPackagedFlowSmokeCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const parsedOptions = parsePackagedFlowSmokeArgs(argv);
  const initialMetrics: SmokeMetrics = {
    status: 'running',
    started_at: new Date().toISOString(),
    out_dir: parsedOptions.outDir,
    screenshots: [],
    ui_timings_ms: {},
    observations: [],
    errors: [],
    llm_model: parsedOptions.ollamaModel,
    llm_configured_model: parsedOptions.ollamaModel,
    llm_fallback_models: parsedOptions.ollamaFallbackModels,
    ocr_provider: parsedOptions.ocrProvider,
    first_chunk_gate_ms: FIRST_CHUNK_GATE_MS,
    first_chunk_under_gate: false,
    streaming_draft_page_limit: parsedOptions.streamingDraftPageLimit,
    streaming_draft_workers: parsedOptions.streamingDraftWorkers,
    wait_for_streaming_complete: parsedOptions.waitForStreamingComplete,
    practice_ready_from_streamed_questions: false,
    app_data_dir: parsedOptions.appDataDir
      ? normalizePath(relative(parsedOptions.workspaceRoot, parsedOptions.appDataDir))
      : undefined,
    streaming_questions: {
      job_snapshots: [],
      question_snapshots: [],
      status_counts: {},
    },
  };
  const run: SmokeRunState = {
    options: parsedOptions,
    metrics: initialMetrics,
    app: null,
    appExit: null,
    nvidia: null,
    resourceSampling: null,
    browser: null,
    page: null,
    port: parsedOptions.cdpPort,
    processBaseline: { all: [], nodePids: new Set() },
    uploadedDocument: null,
    streamingDraftParseStartedAt: null,
    streamingDraftCaptureOpen: false,
    streamingApiPollErrorCaptured: false,
  };
  mkdirSync(run.options.outDir, { recursive: true });

  try {
    await runFlow(run);
  } catch (error) {
    run.metrics.status = 'failed';
    run.metrics.errors.push(error instanceof Error && error.stack ? error.stack : errorMessage(error));
    log(run, `FAILED ${error instanceof Error && error.stack ? error.stack : errorMessage(error)}`);
    if (run.page) {
      await screenshot(run, 'failure-state').catch((screenshotError) => {
        run.metrics.observations.push(
          `failure screenshot skipped: ${errorMessage(screenshotError)}`,
        );
      });
    }
  } finally {
    writeCloseoutArtifacts(run, 'pre-cleanup', { recordBaselineFailure: false });
    await cleanupAfterRunWithTimeout(run).catch((error) => {
      run.metrics.errors.push(`cleanup failed: ${errorMessage(error)}`);
    });
    writeCloseoutArtifacts(run, 'final', { recordBaselineFailure: true });
    logFinalMetricsSummary(run);
  }

  process.exitCode = run.metrics.status === 'completed' && run.metrics.errors.length === 0 ? 0 : 1;
}
