import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, join, relative } from 'node:path';

import {
  cleanupAfterRunWithTimeout,
  forceCrashAndReconnect,
  launchAppAndConnect,
  prepareRunDirectories,
} from '../packaged-flow-smoke/app-lifecycle.mts';
import { createProject } from '../packaged-flow-smoke/flow-steps.mts';
import { captureProjectApiAfterRestart } from '../packaged-flow-smoke/generation-readiness.mts';
import {
  installOcrRuntimeIfNeeded,
  installPythonRuntimeIfNeeded,
} from '../packaged-flow-smoke/runtime-install-flow.mts';
import { activePage } from '../packaged-flow-smoke/runner-context.mts';
import { unavailableGenerationReadinessSnapshot } from '../packaged-flow-smoke/generation-readiness.mts';
import type {
  SmokeMetrics,
  SmokeOptions,
  SmokeRunState,
} from '../packaged-flow-smoke/types.mts';
import {
  installProcessShutdownCleanup,
  processSnapshot,
  type ProcessSnapshot,
} from '../process-lifecycle/processes.mts';
import {
  playwrightJsonTransport,
  type FilePayload,
  type JsonTransport,
} from './api-client.mts';
import {
  runDocumentCancelRetryScenario,
  runUploadBeforeDocumentIdCancellation,
  type DocumentCancellationOptions,
  type DocumentCancellationProofs,
  type UploadCancellationProof,
} from './document-cancellation.mts';
import type {
  EvidenceArtifactReference,
  EvidenceEnvelopeOptions,
} from './evidence-writer.mts';
import { writeResilienceEvidence } from './evidence-writer.mts';
import type { ResilienceCheck } from './evidence-contract.mts';
import type { DocumentCancellationRunnerOptions } from './args.mts';

const DOCUMENT_CHECKS = [
  'upload',
  'ocr',
  'cancelVsCompleteRace',
  'crashRecovery',
  'partialDataRemoved',
] as const satisfies readonly ResilienceCheck[];

type DocumentCheck = (typeof DOCUMENT_CHECKS)[number];

export interface DocumentCancellationRunResult {
  readonly outputRoot: string;
  readonly evidence: Readonly<Record<DocumentCheck, EvidenceArtifactReference>>;
}

export interface DocumentRunnerDependencies {
  readonly now: () => Date;
  readonly prepareRunDirectories: typeof prepareRunDirectories;
  readonly processSnapshot: () => ProcessSnapshot;
  readonly launchAppAndConnect: typeof launchAppAndConnect;
  readonly installPythonRuntimeIfNeeded: typeof installPythonRuntimeIfNeeded;
  readonly installOcrRuntimeIfNeeded: typeof installOcrRuntimeIfNeeded;
  readonly createProject: typeof createProject;
  readonly createTransport: (run: SmokeRunState) => JsonTransport;
  readonly runUploadScenario: typeof runUploadBeforeDocumentIdCancellation;
  readonly runDocumentScenario: (
    options: DocumentCancellationOptions,
  ) => Promise<DocumentCancellationProofs>;
  readonly forceCrashAndReconnect: typeof forceCrashAndReconnect;
  readonly captureProjectApiAfterRestart: typeof captureProjectApiAfterRestart;
  readonly cleanupAfterRun: typeof cleanupAfterRunWithTimeout;
  readonly installShutdownCleanup: typeof installProcessShutdownCleanup;
  readonly writeEvidence: typeof writeResilienceEvidence;
  readonly stagingId: () => string;
}

const DEFAULT_DEPENDENCIES: DocumentRunnerDependencies = {
  now: () => new Date(),
  prepareRunDirectories,
  processSnapshot,
  launchAppAndConnect,
  installPythonRuntimeIfNeeded,
  installOcrRuntimeIfNeeded,
  createProject,
  createTransport: defaultTransport,
  runUploadScenario: runUploadBeforeDocumentIdCancellation,
  runDocumentScenario: runDocumentCancelRetryScenario,
  forceCrashAndReconnect,
  captureProjectApiAfterRestart,
  cleanupAfterRun: cleanupAfterRunWithTimeout,
  installShutdownCleanup: installProcessShutdownCleanup,
  writeEvidence: writeResilienceEvidence,
  stagingId: randomUUID,
};

export async function runDocumentCancellationAcceptance(
  options: DocumentCancellationRunnerOptions,
  dependencyOverrides: Partial<DocumentRunnerDependencies> = {},
): Promise<DocumentCancellationRunResult> {
  const dependencies: DocumentRunnerDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...dependencyOverrides,
  };
  const run = createRunState(options);
  dependencies.prepareRunDirectories(run);
  run.processBaseline = dependencies.processSnapshot();

  const removeShutdownCleanup = dependencies.installShutdownCleanup({
    cleanup: async () => {
      run.metrics.status = 'failed';
      await dependencies.cleanupAfterRun(run);
    },
  });

  let uploadProof: UploadCancellationProof | null = null;
  let documentProofs: DocumentCancellationProofs | null = null;
  let uploadStartedAt = '';
  let uploadCompletedAt = '';
  let documentStartedAt = '';
  let documentCompletedAt = '';
  let primaryError: unknown = null;
  let cleanupError: unknown = null;

  try {
    await dependencies.launchAppAndConnect(run);
    await dependencies.installPythonRuntimeIfNeeded(run);
    await dependencies.installOcrRuntimeIfNeeded(run);
    await dependencies.createProject(run);
    const projectApi = requireProjectApi(run);
    let transport = dependencies.createTransport(run);
    const pdf = filePayload(options.pdfPath);

    uploadStartedAt = dependencies.now().toISOString();
    uploadProof = await dependencies.runUploadScenario(
      transport,
      projectApi.projectId,
      pdf,
      options.timeoutMs,
    );
    uploadCompletedAt = dependencies.now().toISOString();
    requireOrderedWindow(uploadStartedAt, uploadCompletedAt, 'upload');

    documentStartedAt = dependencies.now().toISOString();
    documentProofs = await dependencies.runDocumentScenario({
      transport,
      projectId: projectApi.projectId,
      pdf,
      timeoutMs: options.timeoutMs,
      latePublishObservationWindowMs: options.latePublishObservationWindowMs,
      restartAfterCancel: async (beforeCrash) => {
        const preCrashStatus = beforeCrash.status;
        if (
          preCrashStatus !== 'running' &&
          preCrashStatus !== 'cancel_requested'
        ) {
          throw new Error(
            'OCR crash recovery reached a terminal state before the forced crash.',
          );
        }
        const previousAuthorization = requireProjectApi(run).authorization;
        await dependencies.forceCrashAndReconnect(run, 'OCR crash recovery');
        const restartedProjectApi =
          await dependencies.captureProjectApiAfterRestart(
            activePage(run),
            projectApi.projectId,
            options.timeoutMs,
          );
        if (restartedProjectApi.authorization === previousAuthorization) {
          throw new Error(
            'Restart API context reused the stale backend authorization token.',
          );
        }
        run.projectApi = restartedProjectApi;
        transport = dependencies.createTransport(run);
        return transport;
      },
    });
    documentCompletedAt = dependencies.now().toISOString();
    requireOrderedWindow(documentStartedAt, documentCompletedAt, 'document');
    if (documentProofs.crashRecovery === null) {
      throw new Error('OCR crash recovery did not produce restart evidence.');
    }
    run.metrics.status = 'completed';
  } catch (error) {
    primaryError = error;
    run.metrics.status = 'failed';
  } finally {
    try {
      await dependencies.cleanupAfterRun(run);
    } catch (error) {
      cleanupError = error;
    } finally {
      removeShutdownCleanup();
    }
  }

  if (primaryError !== null && cleanupError !== null) {
    throw new AggregateError(
      [primaryError, cleanupError],
      'Document cancellation scenario and cleanup both failed.',
    );
  }
  if (primaryError !== null) {
    throw primaryError;
  }
  if (cleanupError !== null) {
    throw cleanupError;
  }
  assertCleanupCompleted(run);
  if (!uploadProof || !documentProofs || !documentProofs.crashRecovery) {
    throw new Error(
      'Document cancellation proofs were incomplete after the run.',
    );
  }

  const envelopes = buildEvidenceEnvelopes({
    options,
    uploadProof,
    documentProofs: {
      ...documentProofs,
      crashRecovery: documentProofs.crashRecovery,
    },
    uploadStartedAt,
    uploadCompletedAt,
    documentStartedAt,
    documentCompletedAt,
  });
  const evidence = publishEvidenceAtomically(
    options.outputRoot,
    envelopes,
    dependencies,
  );
  return { outputRoot: options.outputRoot, evidence };
}

function createRunState(
  options: DocumentCancellationRunnerOptions,
): SmokeRunState {
  const smokeOptions: SmokeOptions = {
    workspaceRoot: options.workspaceRoot,
    exePath: options.installedExePath,
    pdfPath: options.pdfPath,
    outDir: options.diagnosticsRoot,
    appDataDir: join(options.diagnosticsRoot, 'app-data'),
    cdpPort: options.cdpPort,
    ocrProvider: 'windowsml',
    ocrPageWorkers: 1,
    llmProvider: 'auto',
    ollamaModel: 'qwen3.5:4b',
    ollamaFallbackModels: ['qwen3.5:2b'],
    acceptanceIsolation: true,
    candidateDistributionProfile: options.candidateDistributionProfile,
    waitForStreamingComplete: false,
    streamingCompleteTimeoutMs: options.timeoutMs,
    skipGpuSampling: true,
    productionSummary: false,
    allowOcrChunkVariance: true,
    verifyStreamingPracticeReady: false,
    recordVideo: false,
  };
  const metrics: SmokeMetrics = {
    status: 'running',
    started_at: new Date().toISOString(),
    out_dir: options.diagnosticsRoot,
    screenshots: [],
    ui_timings_ms: {},
    observations: [],
    errors: [],
    llm_provider: smokeOptions.llmProvider,
    llm_model: smokeOptions.ollamaModel,
    llm_configured_model: smokeOptions.ollamaModel,
    llm_fallback_models: smokeOptions.ollamaFallbackModels,
    generation_readiness_at_start: unavailableGenerationReadinessSnapshot(
      'capture_not_reached',
    ),
    ocr_provider: smokeOptions.ocrProvider,
    first_chunk_gate_ms: 15_000,
    first_chunk_under_gate: false,
    wait_for_streaming_complete: false,
    practice_ready_from_streamed_questions: false,
    app_data_dir: relative(
      options.workspaceRoot,
      smokeOptions.appDataDir ?? '',
    ),
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
    videoRecording: null,
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

function defaultTransport(run: SmokeRunState): JsonTransport {
  return playwrightJsonTransport(
    activePage(run).request,
    requireProjectApi(run),
  );
}

function requireProjectApi(
  run: SmokeRunState,
): NonNullable<SmokeRunState['projectApi']> {
  if (!run.projectApi) {
    throw new Error('Packaged project API context was not captured.');
  }
  return run.projectApi;
}

function filePayload(path: string): FilePayload {
  return {
    name: basename(path),
    mimeType: 'application/pdf',
    buffer: readFileSync(path),
  };
}

function assertCleanupCompleted(run: SmokeRunState): void {
  if (run.metrics.errors.length > 0) {
    throw new Error(
      `Packaged document-cancellation cleanup recorded errors: ${run.metrics.errors.join(' | ')}`,
    );
  }
  const finalClose = run.metrics.final_close;
  const processCleanup = run.metrics.process_cleanup;
  if (
    run.app !== null ||
    run.browser !== null ||
    !finalClose ||
    finalClose.residue.length !== 0 ||
    finalClose.residualProcesses.length !== 0 ||
    !processCleanup ||
    processCleanup.residue_after_close.length !== 0
  ) {
    throw new Error(
      'Packaged document-cancellation cleanup did not finish without residue.',
    );
  }
}

function buildEvidenceEnvelopes({
  options,
  uploadProof,
  documentProofs,
  uploadStartedAt,
  uploadCompletedAt,
  documentStartedAt,
  documentCompletedAt,
}: {
  readonly options: DocumentCancellationRunnerOptions;
  readonly uploadProof: UploadCancellationProof;
  readonly documentProofs: DocumentCancellationProofs & {
    readonly crashRecovery: Record<string, unknown>;
  };
  readonly uploadStartedAt: string;
  readonly uploadCompletedAt: string;
  readonly documentStartedAt: string;
  readonly documentCompletedAt: string;
}): Readonly<Record<DocumentCheck, EvidenceEnvelopeOptions>> {
  return {
    upload: envelope(
      options,
      uploadStartedAt,
      uploadCompletedAt,
      { ...uploadProof },
      [
        {
          at: uploadStartedAt,
          event: 'upload.cancel-started',
          projectId: uploadProof.projectId,
          operationId: uploadProof.operationId,
        },
        {
          at: uploadCompletedAt,
          event: 'upload.canceled',
          projectId: uploadProof.projectId,
          operationId: uploadProof.operationId,
          status: 'canceled',
        },
      ],
    ),
    ocr: envelope(
      options,
      documentStartedAt,
      documentCompletedAt,
      documentProofs.ocr,
      documentObservations(
        documentStartedAt,
        documentCompletedAt,
        documentProofs.ocr,
        'ocr.cancel-retry',
      ),
    ),
    cancelVsCompleteRace: envelope(
      options,
      documentStartedAt,
      documentCompletedAt,
      documentProofs.cancelVsCompleteRace,
      documentObservations(
        documentStartedAt,
        documentCompletedAt,
        documentProofs.ocr,
        'ocr.cancel-race-stable',
      ),
    ),
    crashRecovery: envelope(
      options,
      documentStartedAt,
      documentCompletedAt,
      documentProofs.crashRecovery,
      documentObservations(
        documentStartedAt,
        documentCompletedAt,
        documentProofs.ocr,
        'ocr.crash-recovery',
      ),
    ),
    partialDataRemoved: envelope(
      options,
      documentStartedAt,
      documentCompletedAt,
      documentProofs.partialDataRemoved,
      documentObservations(
        documentStartedAt,
        documentCompletedAt,
        documentProofs.partialDataRemoved,
        'ocr.partial-data-removed',
      ),
    ),
  };
}

function envelope(
  options: DocumentCancellationRunnerOptions,
  startedAt: string,
  completedAt: string,
  proof: Readonly<Record<string, unknown>>,
  observations: EvidenceEnvelopeOptions['observations'],
): EvidenceEnvelopeOptions {
  return {
    candidate: options.candidate,
    acceptanceRunId: options.acceptanceRunId,
    startedAt,
    completedAt,
    observations,
    proof: withInstallation(options, proof),
  };
}

function withInstallation(
  options: DocumentCancellationRunnerOptions,
  proof: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    ...proof,
    installationBinding: {
      receiptSha256: options.installation.receiptSha256,
      packageKind: options.installation.packageKind,
      installerRelativePath: options.installation.installerRelativePath,
      installerSha256: options.installation.installerSha256,
      installedExeName: options.installation.installedExeName,
      installedExeBytes: options.installation.installedExeBytes,
      installedExeSha256: options.installation.installedExeSha256,
      installedAt: options.installation.installedAt,
    },
  };
}

function documentObservations(
  startedAt: string,
  completedAt: string,
  proof: Readonly<Record<string, unknown>>,
  event: string,
): EvidenceEnvelopeOptions['observations'] {
  const projectId = optionalString(proof.projectId);
  const documentId = optionalString(proof.documentId);
  const operationId =
    optionalString(proof.operationId) ??
    optionalString(proof.initialOperationId);
  return [
    {
      at: startedAt,
      event: `${event}.started`,
      ...(projectId ? { projectId } : {}),
      ...(documentId ? { documentId } : {}),
      ...(operationId ? { operationId } : {}),
    },
    {
      at: completedAt,
      event: `${event}.verified`,
      ...(projectId ? { projectId } : {}),
      ...(documentId ? { documentId } : {}),
      ...(operationId ? { operationId } : {}),
    },
  ];
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function requireOrderedWindow(
  startedAt: string,
  completedAt: string,
  label: string,
): void {
  if (Date.parse(startedAt) >= Date.parse(completedAt)) {
    throw new Error(`${label} evidence timestamps were not strictly ordered.`);
  }
}

function publishEvidenceAtomically(
  outputRoot: string,
  envelopes: Readonly<Record<DocumentCheck, EvidenceEnvelopeOptions>>,
  dependencies: Pick<DocumentRunnerDependencies, 'stagingId' | 'writeEvidence'>,
): Readonly<Record<DocumentCheck, EvidenceArtifactReference>> {
  if (existsSync(outputRoot)) {
    throw new Error('Document cancellation evidence output already exists.');
  }
  const stagingRoot = join(
    join(outputRoot, '..'),
    `.${basename(outputRoot)}.preparing-${dependencies.stagingId()}`,
  );
  if (existsSync(stagingRoot)) {
    throw new Error(
      'Document cancellation evidence staging path already exists.',
    );
  }
  mkdirSync(stagingRoot);
  try {
    const evidence = Object.fromEntries(
      DOCUMENT_CHECKS.map((check) => [
        check,
        dependencies.writeEvidence(stagingRoot, check, envelopes[check]),
      ]),
    ) as Record<DocumentCheck, EvidenceArtifactReference>;
    assertExactEvidenceTree(stagingRoot, evidence);
    renameSync(stagingRoot, outputRoot);
    return evidence;
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

function assertExactEvidenceTree(
  stagingRoot: string,
  evidence: Readonly<Record<DocumentCheck, EvidenceArtifactReference>>,
): void {
  const cancellationRoot = join(stagingRoot, 'cancellation');
  const actualNames = readdirSync(cancellationRoot).sort();
  const expectedNames = DOCUMENT_CHECKS.map((check) => `${check}.json`).sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(
      'Document cancellation staging contained undeclared evidence files.',
    );
  }
  for (const check of DOCUMENT_CHECKS) {
    const reference = evidence[check];
    const path = join(stagingRoot, ...reference.path.split('/'));
    const payload = readFileSync(path);
    if (
      statSync(path).size !== reference.bytes ||
      createHash('sha256').update(payload).digest('hex') !== reference.sha256
    ) {
      throw new Error(
        `Document cancellation evidence digest drifted: ${check}.`,
      );
    }
  }
}
