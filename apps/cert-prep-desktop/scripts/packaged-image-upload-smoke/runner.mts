// JPEG leg of the real OCR acceptance (see ../acceptance-real.spec.mts):
// launches the packaged app, uploads one scanned image, waits for real OCR, and
// checks the text against the expectation file.
import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import { removeAcceptanceAppDataDirectory } from '../acceptance-app-data.mts';
import { DEFAULT_LLM_MODEL } from '../package-qa/constants.mts';
import {
  cleanupAfterRunWithTimeout,
  launchAppAndConnect,
  prepareRunDirectories,
} from '../packaged-flow-smoke/app-lifecycle.mts';
import { createProject } from '../packaged-flow-smoke/flow-steps.mts';
import { unavailableGenerationReadinessSnapshot } from '../packaged-flow-smoke/generation-readiness.mts';
import { createSmokeRunState } from '../packaged-flow-smoke/run-state.mts';
import {
  activePage,
  clickButtonText,
  escapeRegExp,
  log,
  screenshot,
  waitText,
} from '../packaged-flow-smoke/runner-context.mts';
import {
  CAPTURE_REQUIREMENT_INSTALL_TIMEOUT_MS,
  ensureCaptureRuntimeReady,
  installPythonRuntimeIfNeeded,
} from '../packaged-flow-smoke/runtime-install-flow.mts';
import { waitForUploadSourceResponse } from '../packaged-flow-smoke/question-generation-observer-api.mts';
import { errorMessage, isRecord } from '../packaged-flow-smoke/text-utils.mts';
import {
  evaluateOcrTruth,
  type OcrActualPage,
  type OcrTruthEvaluation,
} from '../ocr-truth-contract.mts';
import {
  serializePrivacySafeOcrSemanticEvidence,
  type PrivacySafeOcrSemanticEvidence,
} from '../ocr-semantic-evidence.mts';
import type {
  SmokeMetrics,
  SmokeOptions,
  SmokeRunState,
  UploadedSourceRef,
} from '../packaged-flow-smoke/types.mts';
import {
  installProcessShutdownCleanup,
  processSnapshot,
  waitForLoopbackPortClosed,
} from '../process-lifecycle/processes.mts';
import type { PackagedImageUploadSmokeOptions } from './args.mts';
import {
  PACKAGED_STATIC_IMAGE_FILENAME,
  PACKAGED_STATIC_IMAGE_HEIGHT,
  PACKAGED_STATIC_IMAGE_WIDTH,
  packagedStaticImage,
  type PackagedImageSourceEvidence,
  waitForExpectedOcrImageSource,
  waitForExpectedTerminalImageSource,
} from './image-contract.mts';

export interface PackagedImageUploadSmokeEvidence {
  readonly status: 'completed';
  readonly cleanupVerified: true;
  readonly cleanup: {
    readonly app: true;
    readonly sidecar: true;
    readonly cdpPort: true;
    readonly temporaryAppData: true;
  };
  readonly fixture: {
    readonly filename: string;
    readonly sha256: string;
    readonly width?: number;
    readonly height?: number;
  };
  readonly source: PackagedImageSourceEvidence;
  readonly ocrTruth?: OcrTruthEvaluation;
  readonly ocrSemanticEvidence?: PrivacySafeOcrSemanticEvidence;
  readonly screenshots: readonly string[];
}

export interface PackagedImageCleanupEvidence {
  readonly app: boolean;
  readonly sidecar: boolean;
  readonly cdpPort: boolean;
  readonly temporaryAppData: boolean;
}

export class PackagedImageUploadSmokeError extends Error {
  readonly cleanup: PackagedImageCleanupEvidence;
  readonly cleanupVerified: boolean;

  constructor(
    message: string,
    cleanup: PackagedImageCleanupEvidence,
    cleanupVerified: boolean,
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = 'PackagedImageUploadSmokeError';
    this.cleanup = cleanup;
    this.cleanupVerified = cleanupVerified;
  }
}

export function packagedImageFailureEvidence(input: {
  readonly error: unknown;
  readonly screenshots: readonly string[];
  readonly observations: readonly string[];
  readonly errors: readonly string[];
  readonly cleanup: PackagedImageCleanupEvidence;
  readonly cleanupVerified: boolean;
}): Record<string, unknown> {
  return {
    status: 'failed',
    error: errorMessage(input.error),
    screenshots: input.screenshots,
    observations: input.observations,
    errors: input.errors,
    cleanup: input.cleanup,
    cleanupVerified: input.cleanupVerified,
  };
}

interface ImageTextAnchorEvidence {
  readonly matched: readonly string[];
  readonly missing: readonly string[];
}

export async function runPackagedImageUploadSmoke(
  options: PackagedImageUploadSmokeOptions,
): Promise<PackagedImageUploadSmokeEvidence> {
  if (!existsSync(options.exePath)) {
    throw new Error(`Missing packaged exe: ${options.exePath}`);
  }
  const imagePath = options.imagePath
    ? options.imagePath
    : join(options.outDir, PACKAGED_STATIC_IMAGE_FILENAME);
  if (options.imagePath) {
    if (!existsSync(imagePath) || statSync(imagePath).size === 0) {
      throw new Error(`Missing or empty image fixture: ${imagePath}`);
    }
  } else {
    writeFileSync(imagePath, packagedStaticImage());
  }
  const imageBytes = readFileSync(imagePath);
  const fixtureName = basename(imagePath);
  const fixtureSha256 = createHash('sha256').update(imageBytes).digest('hex');
  const run = createRunState(options, imagePath);
  prepareRunDirectories(run);
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

  let source: PackagedImageSourceEvidence | null = null;
  let ocrTruth: OcrTruthEvaluation | undefined;
  let ocrSemanticEvidence: PrivacySafeOcrSemanticEvidence | undefined;
  let primaryError: unknown = null;
  let cleanupError: unknown = null;
  let launchAttempted = false;
  try {
    log(run, `artifact dir ${options.outDir}`);
    launchAttempted = true;
    await launchAppAndConnect(run);
    await installPythonRuntimeIfNeeded(run);
    await createProject(run);
    if (options.acceptanceIsolation) {
      await ensureCaptureRuntimeReady(
        run,
        Math.max(CAPTURE_REQUIREMENT_INSTALL_TIMEOUT_MS, options.timeoutMs),
      );
    }
    const imageResult = await uploadAndVerifyImage(
      run,
      imagePath,
      options.timeoutMs,
      options.expectedTextIncludes,
      options.languageHint ?? 'auto',
      options.ocrTruth,
    );
    source = imageResult.source;
    ocrTruth = imageResult.ocrTruth;
    if (ocrTruth && options.ocrTruth && imageResult.actualPages) {
      ocrSemanticEvidence = serializePrivacySafeOcrSemanticEvidence({
        truth: options.ocrTruth,
        evaluation: ocrTruth,
        actualPages: imageResult.actualPages,
      });
      run.metrics.ocr_semantic_evidence = ocrSemanticEvidence;
    }
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
      removeTemporaryAppData(options);
    } catch (error) {
      cleanupError = error;
      run.metrics.errors.push(`cleanup failed: ${errorMessage(error)}`);
    } finally {
      removeShutdownCleanup();
    }
  }

  const observedCleanup = await collectCleanupEvidence(
    run,
    options,
    launchAttempted,
  );
  const cleanupVerified =
    run.app === null &&
    run.browser === null &&
    Object.values(observedCleanup).every(Boolean);
  if (!cleanupVerified && cleanupError === null) {
    cleanupError = new Error(
      'Packaged image upload cleanup did not finish without residue.',
    );
  }
  if (!source && primaryError === null) {
    primaryError = new Error(
      'Packaged image upload did not produce source evidence.',
    );
  }
  if (primaryError !== null || cleanupError !== null) {
    const cause =
      primaryError !== null && cleanupError !== null
        ? new AggregateError(
            [primaryError, cleanupError],
            'Packaged image upload and cleanup both failed.',
          )
        : (primaryError ?? cleanupError);
    const message =
      primaryError !== null && cleanupError !== null
        ? 'Packaged image upload and cleanup both failed.'
        : errorMessage(cause);
    writeFailureEvidence(run, cause, observedCleanup, cleanupVerified);
    throw new PackagedImageUploadSmokeError(
      message,
      observedCleanup,
      cleanupVerified,
      cause,
    );
  }

  const cleanup: PackagedImageUploadSmokeEvidence['cleanup'] = {
    app: true,
    sidecar: true,
    cdpPort: true,
    temporaryAppData: true,
  };
  if (source === null) {
    throw new Error(
      'Packaged image upload source evidence was unexpectedly absent.',
    );
  }

  const evidence: PackagedImageUploadSmokeEvidence = {
    status: 'completed',
    cleanupVerified: true,
    cleanup,
    fixture: {
      filename: fixtureName,
      sha256: fixtureSha256,
      ...(fixtureName === PACKAGED_STATIC_IMAGE_FILENAME
        ? {
            width: PACKAGED_STATIC_IMAGE_WIDTH,
            height: PACKAGED_STATIC_IMAGE_HEIGHT,
          }
        : {}),
    },
    source,
    ...(ocrTruth ? { ocrTruth } : {}),
    ...(ocrSemanticEvidence ? { ocrSemanticEvidence } : {}),
    screenshots: run.metrics.screenshots,
  };
  writeFileSync(
    join(options.outDir, 'image-upload-evidence.json'),
    `${JSON.stringify(privacySafeImageEvidence(evidence), null, 2)}\n`,
  );
  return evidence;
}

function privacySafeImageEvidence(
  evidence: PackagedImageUploadSmokeEvidence,
): Record<string, unknown> {
  const safeEvidence = { ...evidence };
  delete safeEvidence.ocrTruth;
  return safeEvidence;
}

async function uploadAndVerifyImage(
  run: SmokeRunState,
  imagePath: string,
  timeoutMs: number,
  expectedTextIncludes: readonly string[] | undefined,
  languageHint: string,
  ocrTruth: PackagedImageUploadSmokeOptions['ocrTruth'],
): Promise<{
  readonly source: PackagedImageSourceEvidence;
  readonly textAnchors?: ImageTextAnchorEvidence;
  readonly ocrTruth?: OcrTruthEvaluation;
  readonly actualPages?: readonly OcrActualPage[];
}> {
  const page = activePage(run);
  const input = page.getByLabel('Source files', { exact: true });
  await input.waitFor({ state: 'attached', timeout: 30_000 });
  await page
    .locator('label')
    .filter({ hasText: 'Language' })
    .locator('select')
    .selectOption(languageHint);
  await input.setInputFiles(imagePath);
  await waitText(
    run,
    new RegExp(escapeRegExp(basename(imagePath))),
    10_000,
    'image selected',
  );
  await screenshot(run, 'static-image-selected');

  const uploadResponse = waitForUploadSourceResponse(run);
  await clickButtonText(run, 'Upload files', { timeout: 120_000 });
  const uploadedSource = await uploadResponse;
  if (!uploadedSource) {
    throw new Error('Packaged image upload response was not captured.');
  }
  run.uploadedSource = uploadedSource;

  const readUploadedSource = () => readSource(run, uploadedSource);
  const source = expectedTextIncludes?.length
    ? await waitForExpectedOcrImageSourceWithOneRetry(
        run,
        readUploadedSource,
        {
          timeoutMs,
          expectation: {
            filename: basename(imagePath),
            sha256: sha256File(imagePath),
          },
        },
      )
    : await waitForExpectedTerminalImageSource(readUploadedSource, {
        timeoutMs,
      });
  if (
    source.id !== uploadedSource.sourceId ||
    source.project_id !== uploadedSource.projectId
  ) {
    throw new Error(
      'Packaged image terminal evidence did not match the captured upload source.',
    );
  }
  let textAnchors: ImageTextAnchorEvidence | undefined;
  let truthEvaluation: OcrTruthEvaluation | undefined;
  let actualPages: readonly OcrActualPage[] | undefined;
  if (expectedTextIncludes?.length) {
    const chunks = await readSourceChunks(run, uploadedSource);
    textAnchors = inspectExpectedTextAnchors(chunks, expectedTextIncludes);
    if (textAnchors.missing.length > 0) {
      throw new Error(
        `Persisted OCR text is missing ${textAnchors.missing.length} expected anchor(s).`,
      );
    }
    if (ocrTruth) {
      actualPages = actualOcrPages(chunks);
      truthEvaluation = evaluateOcrTruth(ocrTruth, actualPages);
    }
    await waitText(
      run,
      /ready/i,
      30_000,
      'one-page image OCR terminal state visible',
    );
    await screenshot(run, 'ocr-image-terminal');
  } else {
    await waitText(
      run,
      /The source was accepted, but no reviewable text was found\./i,
      30_000,
      'one-page image terminal state visible',
    );
    await screenshot(run, 'static-image-terminal');
  }
  log(
    run,
    `image completed status=${source.status} pages=${source.processed_page_count}/${source.page_count} chunks=${source.chunks_count}`,
  );
  return {
    source,
    textAnchors,
    ocrTruth: truthEvaluation,
    actualPages,
  };
}

async function waitForExpectedOcrImageSourceWithOneRetry(
  run: SmokeRunState,
  readSource: () => Promise<unknown>,
  options: {
    readonly timeoutMs: number;
    readonly expectation: {
      readonly filename: string;
      readonly sha256: string;
    };
  },
): Promise<PackagedImageSourceEvidence> {
  try {
    return await waitForExpectedOcrImageSource(readSource, options);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !/ended as extraction_failed\./u.test(error.message)
    ) {
      throw error;
    }

    const retry = activePage(run)
      .getByRole('button', { name: /Retry source processing/i })
      .first();
    await retry.waitFor({ state: 'visible', timeout: 10_000 });
    run.metrics.observations.push(
      'JPEG OCR reached extraction_failed during the packaged image journey; retrying the product retry-parsing action once.',
    );
    await retry.click({ timeout: 30_000 });
    await waitForImageSourceToLeaveFailure(readSource, 30_000);
    return await waitForExpectedOcrImageSource(readSource, options);
  }
}

async function waitForImageSourceToLeaveFailure(
  readSource: () => Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const latest = await readSource();
    if (isRecord(latest) && latest.status !== 'extraction_failed') return;
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('JPEG OCR retry did not leave the initial extraction_failed state.');
}

async function readSource(
  run: SmokeRunState,
  uploadedSource: UploadedSourceRef,
): Promise<unknown> {
  const response = await activePage(run).request.get(
    `${uploadedSource.apiBaseUrl}/projects/${encodeURIComponent(uploadedSource.projectId)}/sources/${encodeURIComponent(uploadedSource.sourceId)}`,
    {
      headers: uploadedSource.authorization
        ? { Authorization: uploadedSource.authorization }
        : undefined,
      timeout: 10_000,
    },
  );
  if (!response.ok()) {
    throw new Error(
      `Packaged image source poll returned HTTP ${response.status()}.`,
    );
  }
  const payload = await response.json().catch(() => null);
  if (!isRecord(payload)) {
    throw new Error('Packaged image source poll was not valid JSON.');
  }
  return payload;
}

function createRunState(
  options: PackagedImageUploadSmokeOptions,
  imagePath: string,
): SmokeRunState {
  const smokeOptions: SmokeOptions = {
    workspaceRoot: options.workspaceRoot,
    exePath: options.exePath,
    pdfPath: imagePath,
    outDir: options.outDir,
    appDataDir: options.appDataDir,
    cdpPort: options.cdpPort,
    llmProvider: options.llmProvider ?? 'auto',
    acceptanceIsolation: true,
    captureRuntimeWorkerMirrorUrl: options.captureRuntimeWorkerMirrorUrl,
    acceptanceArtifactRoot: options.acceptanceArtifactRoot,
    candidateDistributionProfile: 'local_nonpublishable',
    waitForQuestionJobs: false,
    questionJobsCompleteTimeoutMs: options.timeoutMs,
    skipGpuSampling: true,
    productionSummary: false,
    allowCaptureChunkVariance: true,
    verifyGeneratedQuestionsPracticeReady: false,
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
    first_chunk_gate_ms: 15_000,
    first_chunk_under_gate: false,
    wait_for_question_jobs: false,
    practice_ready_from_generated_questions: false,
    app_data_dir: relative(options.workspaceRoot, options.appDataDir),
    question_generation: {
      job_snapshots: [],
      question_snapshots: [],
      status_counts: {},
    },
  };
  return createSmokeRunState(smokeOptions, metrics);
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function readSourceChunks(
  run: SmokeRunState,
  uploadedSource: UploadedSourceRef,
): Promise<readonly Record<string, unknown>[]> {
  const response = await activePage(run).request.get(
    `${uploadedSource.apiBaseUrl}/projects/${encodeURIComponent(uploadedSource.projectId)}/sources/${encodeURIComponent(uploadedSource.sourceId)}/chunks`,
    {
      headers: uploadedSource.authorization
        ? { Authorization: uploadedSource.authorization }
        : undefined,
      timeout: 10_000,
    },
  );
  if (!response.ok()) {
    throw new Error(
      `Packaged image chunks request returned HTTP ${response.status()}.`,
    );
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new Error(
      'Packaged image chunks response was not a valid item list.',
    );
  }
  return payload.items.filter((item): item is Record<string, unknown> =>
    isRecord(item),
  );
}

function inspectExpectedTextAnchors(
  chunks: readonly Record<string, unknown>[],
  expectedTextIncludes: readonly string[],
): ImageTextAnchorEvidence {
  const text = chunks
    .map((chunk) => chunk.raw_text)
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
  if (!text.trim()) {
    throw new Error('OCR result did not expose non-empty raw_text chunks.');
  }
  const normalizedText = normalizeOcrText(text);
  const matched: string[] = [];
  const missing: string[] = [];
  for (const anchor of expectedTextIncludes) {
    const normalizedAnchor = normalizeOcrText(anchor);
    if (normalizedAnchor && normalizedText.includes(normalizedAnchor))
      matched.push(anchor);
    else missing.push(anchor);
  }
  return { matched, missing };
}

function actualOcrPages(
  chunks: readonly Record<string, unknown>[],
): readonly { pageNumber: number; text: string }[] {
  const pages = new Map<number, string[]>();
  for (const chunk of chunks) {
    const pageNumber = chunk.page_number;
    if (
      typeof pageNumber !== 'number' ||
      !Number.isInteger(pageNumber) ||
      pageNumber < 1
    ) {
      throw new Error('OCR result chunks did not expose a valid page_number.');
    }
    const text =
      typeof chunk.raw_text === 'string'
        ? chunk.raw_text
        : typeof chunk.text === 'string'
          ? chunk.text
          : '';
    if (!text.trim()) {
      throw new Error(`OCR result page ${pageNumber} exposed no raw text.`);
    }
    const page = pages.get(pageNumber) ?? [];
    page.push(text);
    pages.set(pageNumber, page);
  }
  return [...pages.entries()]
    .sort(([left], [right]) => left - right)
    .map(([pageNumber, texts]) => ({ pageNumber, text: texts.join('\n') }));
}

function removeTemporaryAppData(
  options: PackagedImageUploadSmokeOptions,
): void {
  const outDir = resolve(options.outDir);
  const appDataDir = resolve(options.appDataDir);
  const relativeAppData = relative(outDir, appDataDir);
  if (
    relativeAppData &&
    !relativeAppData.startsWith('..') &&
    !isAbsolute(relativeAppData)
  ) {
    rmSync(appDataDir, { recursive: true, force: true });
  } else {
    removeAcceptanceAppDataDirectory(options.workspaceRoot, appDataDir);
  }
  if (existsSync(appDataDir)) {
    throw new Error(
      `Packaged image cleanup could not remove temporary app-data: ${appDataDir}.`,
    );
  }
}

function normalizeOcrText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

async function collectCleanupEvidence(
  run: SmokeRunState,
  options: PackagedImageUploadSmokeOptions,
  launchAttempted: boolean,
): Promise<PackagedImageCleanupEvidence> {
  const finalClose = run.metrics.final_close;
  const processCleanup = run.metrics.process_cleanup;
  return {
    app:
      run.app === null &&
      run.browser === null &&
      (!launchAttempted ||
        (finalClose !== undefined &&
          finalClose.exited_after_normal_close === true &&
          finalClose.residue.length === 0 &&
          finalClose.residualProcesses.length === 0)),
    sidecar:
      !launchAttempted ||
      (processCleanup !== undefined &&
        processCleanup.residue_after_close.length === 0),
    cdpPort: await waitForLoopbackPortClosed(options.cdpPort),
    temporaryAppData: !existsSync(options.appDataDir),
  };
}

function writeFailureEvidence(
  run: SmokeRunState,
  error: unknown,
  cleanup: PackagedImageCleanupEvidence,
  cleanupVerified: boolean,
): void {
  writeFileSync(
    join(run.options.outDir, 'image-upload-evidence.json'),
    `${JSON.stringify(
      packagedImageFailureEvidence({
        error,
        screenshots: run.metrics.screenshots,
        observations: run.metrics.observations,
        errors: run.metrics.errors,
        cleanup,
        cleanupVerified,
      }),
      null,
      2,
    )}\n`,
  );
}
