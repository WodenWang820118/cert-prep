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
import { buildPhase1AcceptanceEvidence } from '../phase1-acceptance-evidence.mts';
import {
  activePage,
  clickButtonText,
  escapeRegExp,
  log,
  screenshot,
  waitText,
} from '../packaged-flow-smoke/runner-context.mts';
import {
  ensureCaptureRuntimeReady,
  installPythonRuntimeIfNeeded,
} from '../packaged-flow-smoke/runtime-install-flow.mts';
import { waitForUploadDocumentResponse } from '../packaged-flow-smoke/streaming-capture-api.mts';
import { errorMessage, isRecord } from '../packaged-flow-smoke/text-utils.mts';
import {
  evaluateOcrTruth,
  type OcrActualPage,
  type OcrTruthEvaluation,
} from '../ocr-truth-contract.mts';
import {
  createOcrExecutionEvidenceRoot,
  readAndValidateOcrExecutionProof,
  type OcrExecutionProofSummary,
} from '../ocr-execution-proof.mts';
import {
  serializePrivacySafeOcrSemanticEvidence,
  type PrivacySafeOcrSemanticEvidence,
} from '../ocr-semantic-evidence.mts';
import {
  buildOcrPageRecordEvidence,
  type OcrPageRecordEvidence,
} from '../ocr-page-record-evidence.mts';
import type {
  SmokeMetrics,
  SmokeOptions,
  SmokeRunState,
  UploadedDocumentRef,
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
  type PackagedImageDocumentEvidence,
  waitForExpectedOcrImageDocument,
  waitForExpectedTerminalImageDocument,
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
  readonly document: PackagedImageDocumentEvidence;
  readonly ocrTruth?: OcrTruthEvaluation;
  readonly ocrSemanticEvidence?: PrivacySafeOcrSemanticEvidence;
  readonly ocrExecutionProof?: OcrExecutionProofSummary;
  readonly pageRecords?: OcrPageRecordEvidence;
  readonly acceptanceEvidence?: Record<string, unknown>;
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
  if (options.acceptanceRuntimeIdentity && !options.ocrExecutionProofExpected) {
    throw new Error('Phase 1 image acceptance requires exact OCR execution proof identity.');
  }
  if (options.ocrExecutionProofExpected) {
    run.options.ocrExecutionEvidenceRoot = await createOcrExecutionEvidenceRoot(options.outDir);
  }
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
  let ocrTruth: OcrTruthEvaluation | undefined;
  let ocrSemanticEvidence: PrivacySafeOcrSemanticEvidence | undefined;
  let ocrExecutionProof: OcrExecutionProofSummary | undefined;
  let pageRecords: OcrPageRecordEvidence | undefined;
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
      await ensureCaptureRuntimeReady(run);
    }
    const imageResult = await uploadAndVerifyImage(
      run,
      imagePath,
      options.timeoutMs,
      options.expectedTextIncludes,
      options.languageHint ?? 'auto',
      options.ocrTruth,
    );
    document = imageResult.document;
    ocrTruth = imageResult.ocrTruth;
    pageRecords = imageResult.pageRecords;
    if (ocrTruth && options.ocrTruth && imageResult.actualPages) {
      ocrSemanticEvidence = serializePrivacySafeOcrSemanticEvidence({
        truth: options.ocrTruth,
        evaluation: ocrTruth,
        actualPages: imageResult.actualPages,
      });
      run.metrics.ocr_semantic_evidence = ocrSemanticEvidence;
    }
    if (options.ocrExecutionProofExpected) {
      ocrExecutionProof = await readAndValidateOcrExecutionProof(
        run.options.ocrExecutionEvidenceRoot ?? '',
        options.ocrExecutionProofExpected,
      );
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
  if (!document && primaryError === null) {
    primaryError = new Error(
      'Packaged image upload did not produce document evidence.',
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
    writeFailureEvidence(
      run,
      cause,
      observedCleanup,
      cleanupVerified,
    );
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
  if (document === null) {
    throw new Error('Packaged image upload document evidence was unexpectedly absent.');
  }

  const acceptanceEvidence = options.acceptanceRuntimeIdentity
    ? buildPhase1AcceptanceEvidence({
        identity: options.acceptanceRuntimeIdentity,
        fixture: {
          name: fixtureName,
          sha256: fixtureSha256,
          truth: options.ocrTruth ?? (() => {
            throw new Error('Phase 1 image acceptance requires an OCR truth manifest.');
          })(),
        },
        preflight: run.metrics.ocr_preflight ?? (() => {
          throw new Error('Phase 1 image acceptance missed the OCR preflight.');
        })(),
        runtimeAttestation: run.metrics.runtime_attestation,
        pageRecords: pageRecords ?? (() => {
          throw new Error('Phase 1 image acceptance missed page-record evidence.');
        })(),
        ocrTruth: ocrTruth ?? (() => {
          throw new Error('Phase 1 image acceptance missed OCR truth evaluation.');
        })(),
        ocrSemanticEvidence: ocrSemanticEvidence ?? (() => {
          throw new Error('Phase 1 image acceptance missed privacy-safe OCR semantic evidence.');
        })(),
        ocrExecutionProof: ocrExecutionProof ?? (() => {
          throw new Error('Phase 1 image acceptance missed the OCR execution proof.');
        })(),
        cleanup: {
          app: cleanup.app,
          sidecar: cleanup.sidecar,
          cdpPort: cleanup.cdpPort,
          temporaryAppData: cleanup.temporaryAppData,
        },
        cleanupObservation: run.metrics.final_close?.ownedCleanupObservation,
      })
    : undefined;

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
    document,
    ...(ocrTruth ? { ocrTruth } : {}),
    ...(ocrSemanticEvidence ? { ocrSemanticEvidence } : {}),
    ...(ocrExecutionProof ? { ocrExecutionProof } : {}),
    ...(pageRecords ? { pageRecords } : {}),
    ...(acceptanceEvidence ? { acceptanceEvidence: { ...acceptanceEvidence, ocrDevice: document.ocr_device } } : {}),
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
  readonly document: PackagedImageDocumentEvidence;
  readonly textAnchors?: ImageTextAnchorEvidence;
  readonly ocrTruth?: OcrTruthEvaluation;
  readonly pageRecords?: OcrPageRecordEvidence;
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

  const uploadResponse = waitForUploadDocumentResponse(run);
  await clickButtonText(run, 'Upload files', { timeout: 120_000 });
  const uploadedDocument = await uploadResponse;
  if (!uploadedDocument) {
    throw new Error('Packaged image upload response was not captured.');
  }
  run.uploadedDocument = uploadedDocument;

  const readUploadedDocument = () => readDocument(run, uploadedDocument);
  const document = expectedTextIncludes?.length
    ? await waitForExpectedOcrImageDocumentWithOneRetry(
        run,
        readUploadedDocument,
        {
          timeoutMs,
          expectation: { filename: basename(imagePath), sha256: sha256File(imagePath) },
        },
      )
    : await waitForExpectedTerminalImageDocument(
        readUploadedDocument,
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
  if (run.options.acceptanceRuntimeIdentity && document.ocr_device !== 'windowsml-dml') throw new Error(`Local OCR acceptance requires persisted windowsml-dml device, found ${document.ocr_device}.`);
  let textAnchors: ImageTextAnchorEvidence | undefined;
  let truthEvaluation: OcrTruthEvaluation | undefined;
  let actualPages: readonly OcrActualPage[] | undefined;
  let pageRecords: OcrPageRecordEvidence | undefined;
  if (expectedTextIncludes?.length) {
    const chunks = await readDocumentChunks(run, uploadedDocument);
    if (run.options.acceptanceRuntimeIdentity) {
      pageRecords = buildOcrPageRecordEvidence({
        runId: process.env.E2E_ACCEPTANCE_RUN_ID ?? 'unknown',
        expectedDocumentId: uploadedDocument.documentId,
        expectedProjectId: uploadedDocument.projectId,
        document: document as unknown as Record<string, unknown>,
        chunks,
        expectedPageNumbers: ocrTruth?.pages.map((page) => page.pageNumber) ?? [1],
        appDataEmptyAtLaunch:
          run.metrics.acceptance_isolation_at_launch?.app_data_dir_empty_at_launch ===
          true,
        runtimeAttestation: run.metrics.runtime_attestation,
      });
      run.metrics.ocr_page_records = pageRecords;
      writeFileSync(
        join(run.options.outDir, 'ocr-page-record-evidence.json'),
        `${JSON.stringify(pageRecords, null, 2)}\n`,
        'utf8',
      );
    }
    textAnchors = inspectExpectedTextAnchors(chunks, expectedTextIncludes);
    if (ocrTruth) {
      actualPages = actualOcrPages(chunks);
      truthEvaluation = evaluateOcrTruth(ocrTruth, actualPages);
    }
    await waitText(run, /ready/i, 30_000, 'one-page image OCR terminal state visible');
    await screenshot(run, 'ocr-image-terminal');
  } else {
    await waitText(
      run,
      /Parsing finished, but no text was detected\./i,
      30_000,
      'one-page image terminal state visible',
    );
    await screenshot(run, 'static-image-terminal');
  }
  log(
    run,
    `image completed status=${document.status} pages=${document.processed_page_count}/${document.page_count} chunks=${document.chunks_count}`,
  );
  return {
    document,
    textAnchors,
    ocrTruth: truthEvaluation,
    pageRecords,
    actualPages,
  };
}

async function waitForExpectedOcrImageDocumentWithOneRetry(
  run: SmokeRunState,
  readDocument: () => Promise<unknown>,
  options: {
    readonly timeoutMs: number;
    readonly expectation: { readonly filename: string; readonly sha256: string };
  },
): Promise<PackagedImageDocumentEvidence> {
  try {
    return await waitForExpectedOcrImageDocument(readDocument, options);
  } catch (error) {
    if (!(error instanceof Error) || !/ended as ocr_failed\./u.test(error.message)) {
      throw error;
    }

    const retry = activePage(run)
      .getByRole('button', { name: /Retry parsing/i })
      .first();
    await retry.waitFor({ state: 'visible', timeout: 10_000 });
    run.metrics.observations.push(
      'JPEG OCR reached ocr_failed during the packaged image journey; retrying the product retry-parsing action once.',
    );
    await retry.click({ timeout: 30_000 });
    await waitForImageDocumentToLeaveFailure(readDocument, 30_000);
    return await waitForExpectedOcrImageDocument(readDocument, options);
  }
}

async function waitForImageDocumentToLeaveFailure(
  readDocument: () => Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const latest = await readDocument();
    if (isRecord(latest) && latest.status !== 'ocr_failed') return;
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('JPEG OCR retry did not leave the initial ocr_failed state.');
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
    acceptanceRuntimeIdentity: options.acceptanceRuntimeIdentity,
    ocrExecutionProofExpected: options.ocrExecutionProofExpected,
    candidateDistributionProfile: 'local_nonpublishable',
    waitForStreamingComplete: false,
    streamingCompleteTimeoutMs: options.timeoutMs,
    skipGpuSampling: true,
    productionSummary: false,
    allowCaptureChunkVariance: true,
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

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function readDocumentChunks(
  run: SmokeRunState,
  uploadedDocument: UploadedDocumentRef,
): Promise<readonly Record<string, unknown>[]> {
  const response = await activePage(run).request.get(
    `${uploadedDocument.apiBaseUrl}/projects/${encodeURIComponent(uploadedDocument.projectId)}/documents/${encodeURIComponent(uploadedDocument.documentId)}/chunks`,
    {
      headers: uploadedDocument.authorization
        ? { Authorization: uploadedDocument.authorization }
        : undefined,
      timeout: 10_000,
    },
  );
  if (!response.ok()) {
    throw new Error(`Packaged image chunks request returned HTTP ${response.status()}.`);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new Error('Packaged image chunks response was not a valid item list.');
  }
  return payload.items.filter(
    (item): item is Record<string, unknown> => isRecord(item),
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
    if (normalizedAnchor && normalizedText.includes(normalizedAnchor)) matched.push(anchor);
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
    if (typeof pageNumber !== 'number' || !Number.isInteger(pageNumber) || pageNumber < 1) {
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

function removeTemporaryAppData(options: PackagedImageUploadSmokeOptions): void {
  const outDir = resolve(options.outDir);
  const appDataDir = resolve(options.appDataDir);
  const relativeAppData = relative(outDir, appDataDir);
  if (relativeAppData && !relativeAppData.startsWith('..') && !isAbsolute(relativeAppData)) {
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
