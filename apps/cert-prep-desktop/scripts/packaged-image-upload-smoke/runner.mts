import { existsSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { DEFAULT_LLM_MODEL } from '../package-qa/constants.mts';
import {
  cleanupAfterRunWithTimeout,
  launchAppAndConnect,
  prepareRunDirectories,
} from '../packaged-flow-smoke/app-lifecycle.mts';
import { createProject } from '../packaged-flow-smoke/flow-steps.mts';
import { unavailableGenerationReadinessSnapshot } from '../packaged-flow-smoke/generation-readiness.mts';
import {
  activePage,
  clickButtonText,
  escapeRegExp,
  log,
  screenshot,
  waitText,
} from '../packaged-flow-smoke/runner-context.mts';
import {
  installOcrRuntimeIfNeeded,
  installPythonRuntimeIfNeeded,
} from '../packaged-flow-smoke/runtime-install-flow.mts';
import { waitForUploadDocumentResponse } from '../packaged-flow-smoke/streaming-capture-api.mts';
import { errorMessage, isRecord } from '../packaged-flow-smoke/text-utils.mts';
import type {
  SmokeMetrics,
  SmokeOptions,
  SmokeRunState,
  UploadedDocumentRef,
} from '../packaged-flow-smoke/types.mts';
import {
  installProcessShutdownCleanup,
  processSnapshot,
} from '../process-lifecycle/processes.mts';
import type { PackagedImageUploadSmokeOptions } from './args.mts';
import {
  PACKAGED_STATIC_IMAGE_FILENAME,
  PACKAGED_STATIC_IMAGE_HEIGHT,
  PACKAGED_STATIC_IMAGE_SHA256,
  PACKAGED_STATIC_IMAGE_WIDTH,
  packagedStaticImage,
  type PackagedImageDocumentEvidence,
  waitForExpectedTerminalImageDocument,
} from './image-contract.mts';

export interface PackagedImageUploadSmokeEvidence {
  readonly status: 'completed';
  readonly fixture: {
    readonly filename: string;
    readonly sha256: string;
    readonly width: number;
    readonly height: number;
  };
  readonly document: PackagedImageDocumentEvidence;
  readonly screenshots: readonly string[];
}

export async function runPackagedImageUploadSmoke(
  options: PackagedImageUploadSmokeOptions,
): Promise<PackagedImageUploadSmokeEvidence> {
  if (!existsSync(options.exePath)) {
    throw new Error(`Missing packaged exe: ${options.exePath}`);
  }
  const run = createRunState(options);
  prepareRunDirectories(run);
  const imagePath = join(options.outDir, PACKAGED_STATIC_IMAGE_FILENAME);
  writeFileSync(imagePath, packagedStaticImage());
  run.processBaseline = processSnapshot();

  const removeShutdownCleanup = installProcessShutdownCleanup({
    cleanup: async (reason, error) => {
      run.metrics.status = 'failed';
      run.metrics.errors.push(
        `shutdown cleanup started after ${reason}: ${error ? errorMessage(error) : 'no error payload'}`,
      );
      await cleanupAfterRunWithTimeout(run);
    },
  });

  let document: PackagedImageDocumentEvidence | null = null;
  let primaryError: unknown = null;
  let cleanupError: unknown = null;
  try {
    log(run, `artifact dir ${options.outDir}`);
    await launchAppAndConnect(run);
    await installPythonRuntimeIfNeeded(run);
    await installOcrRuntimeIfNeeded(run);
    await createProject(run);
    document = await uploadAndVerifyStaticImage(run, imagePath, options.timeoutMs);
    run.metrics.status = 'completed';
  } catch (error) {
    primaryError = error;
    run.metrics.status = 'failed';
    run.metrics.errors.push(errorMessage(error));
    if (run.page) {
      await screenshot(run, 'image-upload-failure').catch(() => undefined);
    }
  } finally {
    try {
      await cleanupAfterRunWithTimeout(run);
    } catch (error) {
      cleanupError = error;
      run.metrics.errors.push(`cleanup failed: ${errorMessage(error)}`);
    } finally {
      removeShutdownCleanup();
    }
  }

  if (primaryError !== null && cleanupError !== null) {
    writeFailureEvidence(run, primaryError);
    throw new AggregateError(
      [primaryError, cleanupError],
      'Packaged image upload and cleanup both failed.',
    );
  }
  if (primaryError !== null) {
    writeFailureEvidence(run, primaryError);
    throw primaryError;
  }
  if (cleanupError !== null) {
    writeFailureEvidence(run, cleanupError);
    throw cleanupError;
  }
  if (!document) {
    throw new Error('Packaged image upload did not produce document evidence.');
  }
  try {
    assertCleanupCompleted(run);
  } catch (error) {
    writeFailureEvidence(run, error);
    throw error;
  }

  const evidence: PackagedImageUploadSmokeEvidence = {
    status: 'completed',
    fixture: {
      filename: PACKAGED_STATIC_IMAGE_FILENAME,
      sha256: PACKAGED_STATIC_IMAGE_SHA256,
      width: PACKAGED_STATIC_IMAGE_WIDTH,
      height: PACKAGED_STATIC_IMAGE_HEIGHT,
    },
    document,
    screenshots: run.metrics.screenshots,
  };
  writeFileSync(
    join(options.outDir, 'image-upload-evidence.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  return evidence;
}

async function uploadAndVerifyStaticImage(
  run: SmokeRunState,
  imagePath: string,
  timeoutMs: number,
): Promise<PackagedImageDocumentEvidence> {
  const page = activePage(run);
  const input = page.getByLabel('Source files', { exact: true });
  await input.waitFor({ state: 'attached', timeout: 30_000 });
  await input.setInputFiles(imagePath);
  await waitText(
    run,
    new RegExp(escapeRegExp(PACKAGED_STATIC_IMAGE_FILENAME)),
    10_000,
    'deterministic PNG selected',
  );
  await screenshot(run, 'static-image-selected');

  const uploadResponse = waitForUploadDocumentResponse(run);
  await clickButtonText(run, 'Upload files', { timeout: 120_000 });
  const uploadedDocument = await uploadResponse;
  if (!uploadedDocument) {
    throw new Error('Packaged image upload response was not captured.');
  }
  run.uploadedDocument = uploadedDocument;

  const document = await waitForExpectedTerminalImageDocument(
    () => readDocument(run, uploadedDocument),
    { timeoutMs },
  );
  if (
    document.id !== uploadedDocument.documentId ||
    document.project_id !== uploadedDocument.projectId
  ) {
    throw new Error(
      'Packaged image terminal evidence did not match the captured upload document.',
    );
  }
  await waitText(
    run,
    /Parsing finished, but no text was detected\./i,
    30_000,
    'one-page image terminal state visible',
  );
  await screenshot(run, 'static-image-terminal');
  log(
    run,
    `static PNG completed status=${document.status} pages=${document.processed_page_count}/${document.page_count} chunks=${document.chunks_count}`,
  );
  return document;
}

async function readDocument(
  run: SmokeRunState,
  uploadedDocument: UploadedDocumentRef,
): Promise<unknown> {
  const response = await activePage(run).request.get(
    `${uploadedDocument.apiBaseUrl}/projects/${encodeURIComponent(uploadedDocument.projectId)}/documents/${encodeURIComponent(uploadedDocument.documentId)}`,
    {
      headers: uploadedDocument.authorization
        ? { Authorization: uploadedDocument.authorization }
        : undefined,
      timeout: 10_000,
    },
  );
  if (!response.ok()) {
    throw new Error(
      `Packaged image document poll returned HTTP ${response.status()}.`,
    );
  }
  const payload = await response.json().catch(() => null);
  if (!isRecord(payload)) {
    throw new Error('Packaged image document poll was not valid JSON.');
  }
  return payload;
}

function createRunState(
  options: PackagedImageUploadSmokeOptions,
): SmokeRunState {
  const smokeOptions: SmokeOptions = {
    workspaceRoot: options.workspaceRoot,
    exePath: options.exePath,
    pdfPath: join(options.outDir, PACKAGED_STATIC_IMAGE_FILENAME),
    outDir: options.outDir,
    appDataDir: options.appDataDir,
    cdpPort: options.cdpPort,
    ocrProvider: options.ocrProvider,
    ocrPageWorkers: 1,
    llmProvider: 'auto',
    acceptanceIsolation: true,
    candidateDistributionProfile: 'local_nonpublishable',
    waitForStreamingComplete: false,
    streamingCompleteTimeoutMs: options.timeoutMs,
    skipGpuSampling: true,
    productionSummary: false,
    allowOcrChunkVariance: true,
    verifyStreamingPracticeReady: false,
  };
  const metrics: SmokeMetrics = {
    status: 'running',
    started_at: new Date().toISOString(),
    out_dir: options.outDir,
    screenshots: [],
    ui_timings_ms: {},
    observations: [],
    errors: [],
    llm_provider: smokeOptions.llmProvider,
    llm_model: DEFAULT_LLM_MODEL,
    llm_configured_model: DEFAULT_LLM_MODEL,
    generation_readiness_at_start: unavailableGenerationReadinessSnapshot(
      'capture_not_reached',
    ),
    ocr_provider: smokeOptions.ocrProvider,
    first_chunk_gate_ms: 15_000,
    first_chunk_under_gate: false,
    wait_for_streaming_complete: false,
    practice_ready_from_streamed_questions: false,
    app_data_dir: relative(options.workspaceRoot, options.appDataDir),
    streaming_questions: {
      job_snapshots: [],
      question_snapshots: [],
      status_counts: {},
    },
  };
  return {
    options: smokeOptions,
    metrics,
    app: null,
    appExit: null,
    resourceSampling: null,
    browser: null,
    page: null,
    port: options.cdpPort,
    processBaseline: { all: [], nodePids: new Set() },
    projectApi: null,
    uploadedDocument: null,
    streamingDraftParseStartedAt: null,
    streamingDraftCaptureOpen: false,
    streamingApiPollErrorCaptured: false,
  };
}

function assertCleanupCompleted(run: SmokeRunState): void {
  const finalClose = run.metrics.final_close;
  const processCleanup = run.metrics.process_cleanup;
  if (
    run.metrics.errors.length > 0 ||
    run.app !== null ||
    run.browser !== null ||
    !finalClose ||
    finalClose.residue.length !== 0 ||
    finalClose.residualProcesses.length !== 0 ||
    !processCleanup ||
    processCleanup.residue_after_close.length !== 0
  ) {
    throw new Error(
      `Packaged image upload cleanup did not finish without residue: ${run.metrics.errors.join(' | ')}`,
    );
  }
}

function writeFailureEvidence(run: SmokeRunState, error: unknown): void {
  writeFileSync(
    join(run.options.outDir, 'image-upload-evidence.json'),
    `${JSON.stringify(
      {
        status: 'failed',
        error: errorMessage(error),
        screenshots: run.metrics.screenshots,
        observations: run.metrics.observations,
        cleanup_errors: run.metrics.errors,
      },
      null,
      2,
    )}\n`,
  );
}
