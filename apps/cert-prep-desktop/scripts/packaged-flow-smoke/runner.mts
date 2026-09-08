import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { removeAcceptanceAppDataDirectory } from '../acceptance-app-data.mts';
import { parsePackagedFlowSmokeArgs } from './args.mts';
import { DEFAULT_LLM_MODEL } from '../package-qa/constants.mts';
import {
  cleanupAfterRunWithTimeout,
  launchAppAndConnect,
  prepareRunDirectories,
  restartAndVerifyPersistence,
} from './app-lifecycle.mts';
import {
  createAndEditQuestion,
  createProject,
  runFullExamWrongAnswer,
  runRandomQuizCorrectClear,
  uploadAndParsePdf,
  verifyMarkdownExport,
  verifyStreamingPracticeReady,
} from './flow-steps.mts';
import { ensureCaptureRuntimeReady } from './runtime-install-flow.mts';
import {
  installProcessShutdownCleanup,
  processSnapshot,
  waitForLoopbackPortClosed,
} from '../process-lifecycle/processes.mts';
import { installPythonRuntimeIfNeeded } from './runtime-install-flow.mts';
import { startResourceSampling } from './resource-sampling.mts';
import { log, screenshot } from './runner-context.mts';
import { writeStreamingBaselineArtifacts } from './streaming-baseline-report.mts';
import { refreshFirstChunkGateMetrics } from './streaming-capture.mts';
import { FIRST_CHUNK_GATE_MS } from './streaming-evidence.mts';
import { errorMessage, normalizePath } from './text-utils.mts';
import { unavailableGenerationReadinessSnapshot } from './generation-readiness.mts';
import { buildPhase1AcceptanceEvidence } from '../phase1-acceptance-evidence.mts';
import {
  createOcrExecutionEvidenceRoot,
  readAndValidateOcrExecutionProof,
} from '../ocr-execution-proof.mts';
import {
  assertWebmArtifact,
  writeAcceptanceManifest,
} from '../acceptance-artifacts.mts';
import type { SmokeMetrics, SmokeOptions, SmokeRunState } from './types.mts';

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
  }
  await launchAppAndConnect(run);
  await installPythonRuntimeIfNeeded(run);
  await createProject(run);
  if (run.options.acceptanceIsolation) {
    await ensureCaptureRuntimeReady(run);
  }
  await uploadAndParsePdf(run);
  if (run.options.ocrExecutionProofExpected) {
    run.metrics.ocr_execution_proof = await readAndValidateOcrExecutionProof(
      run.options.ocrExecutionEvidenceRoot ?? '',
      run.options.ocrExecutionProofExpected,
    );
  }
  if (run.options.acceptanceOcrOnly) {
    run.metrics.status = 'completed';
    log(run, 'OCR-only acceptance completed');
    return;
  }
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
  if (!run.options.acceptanceVerifyMarkdownExport) {
    await runRandomQuizCorrectClear(run);
  } else {
    // The Capture Workbench review/export must complete before the app is
    // relaunched; persistence is checked by restartAndVerifyPersistence below.
    await verifyMarkdownExport(run);
  }
  await restartAndVerifyPersistence(run);
  if (run.metrics.restart?.verified !== true) {
    throw new Error(
      'Cert Prep review/project persistence was not verified after restart.',
    );
  }
  run.metrics.status = 'completed';
  log(run, 'flow completed');
}

function saveMetrics(run: SmokeRunState): void {
  refreshFirstChunkGateMetrics(run);
  run.metrics.finished_at = new Date().toISOString();
  const privacySafeMetrics = { ...run.metrics };
  delete privacySafeMetrics.ocr_truth;
  writeFileSync(
    join(run.options.outDir, 'metrics.json'),
    `${JSON.stringify(privacySafeMetrics, null, 2)}\n`,
  );
}

function writeCloseoutArtifacts(
  run: SmokeRunState,
  label: string,
  {
    finalized,
    recordBaselineFailure,
  }: {
    readonly finalized: boolean;
    readonly recordBaselineFailure: boolean;
  },
): void {
  try {
    run.metrics.observations.push(`closeout checkpoint: ${label}`);
    writeStreamingBaselineArtifacts(run, {
      finalized,
      recordFailure: recordBaselineFailure,
    });
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
        out_dir: normalizePath(
          relative(run.options.workspaceRoot, run.options.outDir),
        ),
        metrics_json: normalizePath(
          relative(
            run.options.workspaceRoot,
            join(run.options.outDir, 'metrics.json'),
          ),
        ),
        streaming_baseline: run.metrics.streaming_baseline ?? null,
        production_summary: run.metrics.production_summary ?? null,
      },
      null,
      2,
    ),
  );
}

export async function runPackagedFlowSmokeCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const metrics = await runPackagedFlowSmoke(parsePackagedFlowSmokeArgs(argv));
  process.exitCode =
    metrics.status === 'completed' && metrics.errors.length === 0 ? 0 : 1;
}

export async function runPackagedFlowSmoke(
  parsedOptions: SmokeOptions,
): Promise<SmokeMetrics> {
  const initialMetrics: SmokeMetrics = {
    status: 'running',
    started_at: new Date().toISOString(),
    out_dir: normalizePath(
      relative(parsedOptions.workspaceRoot, parsedOptions.outDir),
    ),
    screenshots: [],
    ui_timings_ms: {},
    observations: [],
    errors: [],
    llm_provider: parsedOptions.llmProvider,
    llm_model: DEFAULT_LLM_MODEL,
    llm_configured_model: DEFAULT_LLM_MODEL,
    generation_readiness_at_start: unavailableGenerationReadinessSnapshot(
      'capture_not_reached',
    ),
    first_chunk_gate_ms: FIRST_CHUNK_GATE_MS,
    first_chunk_under_gate: false,
    streaming_draft_page_limit: parsedOptions.streamingDraftPageLimit,
    streaming_draft_workers: parsedOptions.streamingDraftWorkers,
    wait_for_streaming_complete: parsedOptions.waitForStreamingComplete,
    practice_ready_from_streamed_questions: false,
    app_data_dir: parsedOptions.appDataDir
      ? normalizePath(
          relative(parsedOptions.workspaceRoot, parsedOptions.appDataDir),
        )
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
    resourceSampling: null,
    browser: null,
    page: null,
    port: parsedOptions.cdpPort,
    processBaseline: { all: [], nodePids: new Set() },
    projectApi: null,
    uploadedDocument: null,
    streamingDraftParseStartedAt: null,
    streamingDraftCaptureOpen: false,
    streamingApiPollErrorCaptured: false,
    acceptanceVideoPaths: [],
    acceptanceTracePaths: [],
    acceptanceTraceOwned: false,
    acceptanceConsoleErrors: [],
    acceptancePageErrors: [],
    acceptanceCaptureSequence: 0,
    acceptanceCaptureActive: false,
  };
  prepareRunDirectories(run);
  if (run.options.ocrExecutionProofExpected) {
    run.options.ocrExecutionEvidenceRoot = await createOcrExecutionEvidenceRoot(
      run.options.outDir,
    );
  }
  const removeShutdownCleanup = installProcessShutdownCleanup({
    cleanup: async (reason, error) => {
      run.metrics.status = 'failed';
      run.metrics.errors.push(
        `shutdown cleanup started after ${reason}: ${error ? errorMessage(error) : 'no error payload'}`,
      );
      writeCloseoutArtifacts(run, `shutdown-${reason}-pre-cleanup`, {
        finalized: false,
        recordBaselineFailure: false,
      });
      await cleanupAfterRunWithTimeout(run);
      writeCloseoutArtifacts(run, `shutdown-${reason}-final`, {
        finalized: true,
        recordBaselineFailure: true,
      });
      await finalizeAcceptanceArtifacts(run);
      logFinalMetricsSummary(run);
    },
  });

  try {
    await runFlow(run);
  } catch (error) {
    run.metrics.status = 'failed';
    run.metrics.errors.push(
      error instanceof Error && error.stack ? error.stack : errorMessage(error),
    );
    log(
      run,
      `FAILED ${error instanceof Error && error.stack ? error.stack : errorMessage(error)}`,
    );
    if (run.page) {
      await screenshot(run, 'failure-state').catch((screenshotError) => {
        run.metrics.observations.push(
          `failure screenshot skipped: ${errorMessage(screenshotError)}`,
        );
      });
    }
  } finally {
    try {
      writeCloseoutArtifacts(run, 'pre-cleanup', {
        finalized: false,
        recordBaselineFailure: false,
      });
      await cleanupAfterRunWithTimeout(run).catch((error) => {
        run.metrics.errors.push(`cleanup failed: ${errorMessage(error)}`);
      });
      writeCloseoutArtifacts(run, 'final', {
        finalized: true,
        recordBaselineFailure: true,
      });
      await finalizeAcceptanceArtifacts(run);
      logFinalMetricsSummary(run);
    } finally {
      removeShutdownCleanup();
    }
  }

  return run.metrics;
}

async function finalizeAcceptanceArtifacts(run: SmokeRunState): Promise<void> {
  const artifactRoot = run.options.acceptanceArtifactRoot;
  if (!artifactRoot) return;

  for (const videoPath of run.acceptanceVideoPaths ?? []) {
    try {
      await assertWebmArtifact(videoPath);
    } catch (error) {
      run.metrics.errors.push(
        `acceptance video validation failed: ${errorMessage(error)}`,
      );
    }
  }

  const reportPath = join(artifactRoot, 'acceptance-report.html');
  const reportErrors = run.metrics.errors
    .map((error) => escapeHtml(error))
    .join('<br>');
  writeFileSync(
    reportPath,
    `<!doctype html><meta charset="utf-8"><title>Cert Prep acceptance</title><h1>Cert Prep acceptance</h1><p>Status: ${run.metrics.status}</p><p>Errors:</p><pre>${reportErrors || 'none'}</pre>`,
    'utf8',
  );

  const workspaceRoot = resolve(run.options.workspaceRoot);
  const appDataDir = run.options.appDataDir
    ? resolve(run.options.appDataDir)
    : undefined;
  let temporaryAppData = true;
  if (appDataDir) {
    if (resolve(appDataDir).startsWith(`${resolve(artifactRoot)}\\`)) {
      rmSync(appDataDir, { recursive: true, force: true });
      temporaryAppData = !existsSync(appDataDir);
    } else {
      try {
        removeAcceptanceAppDataDirectory(workspaceRoot, appDataDir);
        temporaryAppData = !existsSync(appDataDir);
      } catch {
        temporaryAppData = false;
      }
    }
  }
  const artifactInputs = [
    ...(run.metrics.screenshots ?? []).map((path) => ({
      path: resolve(workspaceRoot, path),
      kind: 'screenshot',
    })),
    ...(run.acceptanceVideoPaths ?? []).map((path) => ({
      path,
      kind: 'video',
    })),
    ...(run.acceptanceTracePaths ?? []).map((path) => ({
      path,
      kind: 'trace',
    })),
    { path: join(run.options.outDir, 'metrics.json'), kind: 'report' },
    { path: reportPath, kind: 'report' },
  ].filter((artifact) => existsSync(artifact.path));
  const finalClose = run.metrics.final_close;
  const cdpPortClosed =
    finalClose !== undefined && (await waitForLoopbackPortClosed(run.port));
  const cleanup = {
    app:
      finalClose?.exited_after_normal_close === true &&
      finalClose.residualProcesses.length === 0,
    sidecar:
      finalClose?.residualProcesses.length === 0 &&
      run.metrics.process_cleanup !== undefined &&
      run.metrics.process_cleanup.residue_after_close.length === 0,
    cdpPort: cdpPortClosed,
    temporaryAppData,
  };
  if (!Object.values(cleanup).every(Boolean)) {
    run.metrics.errors.push('Acceptance cleanup proof was incomplete.');
  }

  const evidence = buildPackagedFlowAcceptanceEvidence(run, cleanup);
  if (evidence) {
    run.metrics.acceptance_evidence = evidence;
  }

  await writeAcceptanceManifest(artifactRoot, {
    project: 'cert-prep',
    runId: process.env.E2E_ACCEPTANCE_RUN_ID ?? 'unknown',
    status:
      run.metrics.status === 'completed' && run.metrics.errors.length === 0
        ? 'completed'
        : 'failed',
    recordVideo: run.options.acceptanceRecordVideo === true,
    artifacts: artifactInputs,
    errors: run.metrics.errors,
    consoleErrors: run.acceptanceConsoleErrors ?? [],
    pageErrors: run.acceptancePageErrors ?? [],
    cleanup,
    fixture: run.options.acceptanceFixture
      ? {
          name: run.options.acceptanceFixture.name,
          sha256: run.options.acceptanceFixture.sha256,
        }
      : undefined,
    evidence,
  });
}

function buildPackagedFlowAcceptanceEvidence(
  run: SmokeRunState,
  cleanup: Record<string, boolean>,
): Record<string, unknown> | undefined {
  const identity = run.options.acceptanceRuntimeIdentity;
  const fixture = run.options.acceptanceFixture;
  const preflight = run.metrics.ocr_preflight;
  const ocrTruth = run.metrics.ocr_truth;
  const ocrSemanticEvidence = run.metrics.ocr_semantic_evidence;
  if (!identity) return undefined;
  if (!fixture || !fixture.truth || !preflight || !ocrTruth || !ocrSemanticEvidence) {
    run.metrics.errors.push(
      'Acceptance OCR evidence was incomplete: fixture, identity, preflight, and truth are required.',
    );
    return undefined;
  }
  const completion = run.metrics.ocr_completion;
  const sourcePageCount = completion?.total_pages;
  const pageScope =
    run.options.acceptancePdfPageScope === 'page-1'
      ? {
          sourcePageCount: sourcePageCount ?? 0,
          requestedPageNumbers: [1] as const,
          processedPageNumbers: [1] as const,
          uiRawPageNumbers: [1] as const,
          uiStructuredPageNumbers: [1] as const,
        }
      : undefined;
  if (
    pageScope &&
    (!Number.isSafeInteger(pageScope.sourcePageCount) ||
      pageScope.sourcePageCount < 1 ||
      completion?.pages_processed !== 1 ||
      completion.chunks !== 1)
  ) {
    run.metrics.errors.push(
      'Acceptance PDF page scope completion metrics were not source=N>=1, processed=1, chunks=1.',
    );
    return undefined;
  }
  try {
    const evidence = buildPhase1AcceptanceEvidence({
      identity,
      fixture: {
        name: fixture.name,
        sha256: fixture.sha256,
        truth: fixture.truth,
      },
      preflight,
      runtimeAttestation: run.metrics.runtime_attestation,
      pageRecords: run.metrics.ocr_page_records ?? (() => {
        throw new Error('Phase 1 PDF acceptance missed page-record evidence.');
      })(),
      ocrTruth,
      ocrSemanticEvidence,
      ocrExecutionProof: run.metrics.ocr_execution_proof,
      cleanup: {
        app: cleanup.app === true,
        sidecar: cleanup.sidecar === true,
        cdpPort: cleanup.cdpPort === true,
        temporaryAppData: cleanup.temporaryAppData === true,
      },
      cleanupObservation: run.metrics.final_close?.ownedCleanupObservation,
      ...(pageScope ? { pageScope } : {}),
    });
    return { ...evidence, ocrDevice: (run.metrics as SmokeMetrics & { ocr_device?: string }).ocr_device };
  } catch (error) {
    run.metrics.errors.push(`Acceptance OCR evidence invalid: ${errorMessage(error)}`);
    return undefined;
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character] ?? character,
  );
}
