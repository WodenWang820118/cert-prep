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

import { DEFAULT_LLM_MODEL } from '../package-qa/constants.mts';
import {
  cleanupAfterRunWithTimeout,
  forceCrashAndReconnect,
  launchAppAndConnect,
  prepareRunDirectories,
} from '../packaged-flow-smoke/app-lifecycle.mts';
import { createProject } from '../packaged-flow-smoke/flow-steps.mts';
import { captureProjectApiAfterRestart } from '../packaged-flow-smoke/generation-readiness.mts';
import { installPythonRuntimeIfNeeded } from '../packaged-flow-smoke/runtime-install-flow.mts';
import { activePage } from '../packaged-flow-smoke/runner-context.mts';
import { unavailableGenerationReadinessSnapshot } from '../packaged-flow-smoke/generation-readiness.mts';
import { createSmokeRunState } from '../packaged-flow-smoke/run-state.mts';
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
  runSourceCancelRetryScenario,
  runUploadBeforeSourceIdCancellation,
  type SourceCancellationOptions,
  type SourceCancellationProofs,
  type UploadCancellationProof,
} from './source-cancellation.mts';
import type {
  EvidenceArtifactReference,
  EvidenceEnvelopeOptions,
} from './evidence-writer.mts';
import { writeResilienceEvidence } from './evidence-writer.mts';
import type { ResilienceCheck } from './evidence-contract.mts';
import type { SourceCancellationRunnerOptions } from './args.mts';

const SOURCE_CHECKS = [
  'upload',
  'ocr',
  'cancelVsCompleteRace',
  'crashRecovery',
  'partialDataRemoved',
] as const satisfies readonly ResilienceCheck[];

type SourceCheck = (typeof SOURCE_CHECKS)[number];

export interface SourceCancellationRunResult {
  readonly outputRoot: string;
  readonly evidence: Readonly<Record<SourceCheck, EvidenceArtifactReference>>;
}

export interface SourceRunnerDependencies {
  readonly now: () => Date;
  readonly prepareRunDirectories: typeof prepareRunDirectories;
  readonly processSnapshot: () => ProcessSnapshot;
  readonly launchAppAndConnect: typeof launchAppAndConnect;
  readonly installPythonRuntimeIfNeeded: typeof installPythonRuntimeIfNeeded;
  readonly createProject: typeof createProject;
  readonly createTransport: (run: SmokeRunState) => JsonTransport;
  readonly runUploadScenario: typeof runUploadBeforeSourceIdCancellation;
  readonly runSourceScenario: (
    options: SourceCancellationOptions,
  ) => Promise<SourceCancellationProofs>;
  readonly forceCrashAndReconnect: typeof forceCrashAndReconnect;
  readonly captureProjectApiAfterRestart: typeof captureProjectApiAfterRestart;
  readonly cleanupAfterRun: typeof cleanupAfterRunWithTimeout;
  readonly installShutdownCleanup: typeof installProcessShutdownCleanup;
  readonly writeEvidence: typeof writeResilienceEvidence;
  readonly stagingId: () => string;
}

const DEFAULT_DEPENDENCIES: SourceRunnerDependencies = {
  now: () => new Date(),
  prepareRunDirectories,
  processSnapshot,
  launchAppAndConnect,
  installPythonRuntimeIfNeeded,
  createProject,
  createTransport: defaultTransport,
  runUploadScenario: runUploadBeforeSourceIdCancellation,
  runSourceScenario: runSourceCancelRetryScenario,
  forceCrashAndReconnect,
  captureProjectApiAfterRestart,
  cleanupAfterRun: cleanupAfterRunWithTimeout,
  installShutdownCleanup: installProcessShutdownCleanup,
  writeEvidence: writeResilienceEvidence,
  stagingId: randomUUID,
};

export async function runSourceCancellationAcceptance(
  options: SourceCancellationRunnerOptions,
  dependencyOverrides: Partial<SourceRunnerDependencies> = {},
): Promise<SourceCancellationRunResult> {
  const dependencies: SourceRunnerDependencies = {
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
  let sourceProofs: SourceCancellationProofs | null = null;
  let uploadStartedAt = '';
  let uploadCompletedAt = '';
  let sourceStartedAt = '';
  let sourceCompletedAt = '';
  let primaryError: unknown = null;
  let cleanupError: unknown = null;

  try {
    await dependencies.launchAppAndConnect(run);
    await dependencies.installPythonRuntimeIfNeeded(run);
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

    sourceStartedAt = dependencies.now().toISOString();
    sourceProofs = await dependencies.runSourceScenario({
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
            'Capture Runtime crash recovery reached a terminal state before the forced crash.',
          );
        }
        const previousAuthorization = requireProjectApi(run).authorization;
        await dependencies.forceCrashAndReconnect(run, 'Capture Runtime crash recovery');
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
    sourceCompletedAt = dependencies.now().toISOString();
    requireOrderedWindow(sourceStartedAt, sourceCompletedAt, 'source');
    if (sourceProofs.crashRecovery === null) {
      throw new Error('Capture Runtime crash recovery did not produce restart evidence.');
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
      'Source cancellation scenario and cleanup both failed.',
    );
  }
  if (primaryError !== null) {
    throw primaryError;
  }
  if (cleanupError !== null) {
    throw cleanupError;
  }
  assertCleanupCompleted(run);
  if (!uploadProof || !sourceProofs || !sourceProofs.crashRecovery) {
    throw new Error(
      'Source cancellation proofs were incomplete after the run.',
    );
  }

  const envelopes = buildEvidenceEnvelopes({
    options,
    uploadProof,
    sourceProofs: {
      ...sourceProofs,
      crashRecovery: sourceProofs.crashRecovery,
    },
    uploadStartedAt,
    uploadCompletedAt,
    sourceStartedAt,
    sourceCompletedAt,
  });
  const evidence = publishEvidenceAtomically(
    options.outputRoot,
    envelopes,
    dependencies,
  );
  return { outputRoot: options.outputRoot, evidence };
}

function createRunState(
  options: SourceCancellationRunnerOptions,
): SmokeRunState {
  const smokeOptions: SmokeOptions = {
    workspaceRoot: options.workspaceRoot,
    exePath: options.installedExePath,
    pdfPath: options.pdfPath,
    outDir: options.diagnosticsRoot,
    appDataDir: join(options.diagnosticsRoot, 'app-data'),
    cdpPort: options.cdpPort,
    llmProvider: 'auto',
    acceptanceIsolation: true,
    candidateDistributionProfile: options.candidateDistributionProfile,
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
    out_dir: options.diagnosticsRoot,
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
    app_data_dir: relative(
      options.workspaceRoot,
      smokeOptions.appDataDir ?? '',
    ),
    question_generation: {
      job_snapshots: [],
      question_snapshots: [],
      status_counts: {},
    },
  };
  return createSmokeRunState(smokeOptions, metrics);
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
      `Packaged source-cancellation cleanup recorded errors: ${run.metrics.errors.join(' | ')}`,
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
      'Packaged source-cancellation cleanup did not finish without residue.',
    );
  }
}

function buildEvidenceEnvelopes({
  options,
  uploadProof,
  sourceProofs,
  uploadStartedAt,
  uploadCompletedAt,
  sourceStartedAt,
  sourceCompletedAt,
}: {
  readonly options: SourceCancellationRunnerOptions;
  readonly uploadProof: UploadCancellationProof;
  readonly sourceProofs: SourceCancellationProofs & {
    readonly crashRecovery: Record<string, unknown>;
  };
  readonly uploadStartedAt: string;
  readonly uploadCompletedAt: string;
  readonly sourceStartedAt: string;
  readonly sourceCompletedAt: string;
}): Readonly<Record<SourceCheck, EvidenceEnvelopeOptions>> {
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
      sourceStartedAt,
      sourceCompletedAt,
      sourceProofs.ocr,
      sourceObservations(
        sourceStartedAt,
        sourceCompletedAt,
        sourceProofs.ocr,
        'ocr.cancel-retry',
      ),
    ),
    cancelVsCompleteRace: envelope(
      options,
      sourceStartedAt,
      sourceCompletedAt,
      sourceProofs.cancelVsCompleteRace,
      sourceObservations(
        sourceStartedAt,
        sourceCompletedAt,
        sourceProofs.ocr,
        'ocr.cancel-race-stable',
      ),
    ),
    crashRecovery: envelope(
      options,
      sourceStartedAt,
      sourceCompletedAt,
      sourceProofs.crashRecovery,
      sourceObservations(
        sourceStartedAt,
        sourceCompletedAt,
        sourceProofs.ocr,
        'ocr.crash-recovery',
      ),
    ),
    partialDataRemoved: envelope(
      options,
      sourceStartedAt,
      sourceCompletedAt,
      sourceProofs.partialDataRemoved,
      sourceObservations(
        sourceStartedAt,
        sourceCompletedAt,
        sourceProofs.partialDataRemoved,
        'ocr.partial-data-removed',
      ),
    ),
  };
}

function envelope(
  options: SourceCancellationRunnerOptions,
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
  options: SourceCancellationRunnerOptions,
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

function sourceObservations(
  startedAt: string,
  completedAt: string,
  proof: Readonly<Record<string, unknown>>,
  event: string,
): EvidenceEnvelopeOptions['observations'] {
  const projectId = optionalString(proof.projectId);
  const sourceId = optionalString(proof.sourceId);
  const operationId =
    optionalString(proof.operationId) ??
    optionalString(proof.initialOperationId);
  return [
    {
      at: startedAt,
      event: `${event}.started`,
      ...(projectId ? { projectId } : {}),
      ...(sourceId ? { sourceId } : {}),
      ...(operationId ? { operationId } : {}),
    },
    {
      at: completedAt,
      event: `${event}.verified`,
      ...(projectId ? { projectId } : {}),
      ...(sourceId ? { sourceId } : {}),
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
  envelopes: Readonly<Record<SourceCheck, EvidenceEnvelopeOptions>>,
  dependencies: Pick<SourceRunnerDependencies, 'stagingId' | 'writeEvidence'>,
): Readonly<Record<SourceCheck, EvidenceArtifactReference>> {
  if (existsSync(outputRoot)) {
    throw new Error('Source cancellation evidence output already exists.');
  }
  const stagingRoot = join(
    join(outputRoot, '..'),
    `.${basename(outputRoot)}.preparing-${dependencies.stagingId()}`,
  );
  if (existsSync(stagingRoot)) {
    throw new Error(
      'Source cancellation evidence staging path already exists.',
    );
  }
  mkdirSync(stagingRoot);
  try {
    const evidence = Object.fromEntries(
      SOURCE_CHECKS.map((check) => [
        check,
        dependencies.writeEvidence(stagingRoot, check, envelopes[check]),
      ]),
    ) as Record<SourceCheck, EvidenceArtifactReference>;
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
  evidence: Readonly<Record<SourceCheck, EvidenceArtifactReference>>,
): void {
  const cancellationRoot = join(stagingRoot, 'cancellation');
  const actualNames = readdirSync(cancellationRoot).sort();
  const expectedNames = SOURCE_CHECKS.map((check) => `${check}.json`).sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(
      'Source cancellation staging contained undeclared evidence files.',
    );
  }
  for (const check of SOURCE_CHECKS) {
    const reference = evidence[check];
    const path = join(stagingRoot, ...reference.path.split('/'));
    const payload = readFileSync(path);
    if (
      statSync(path).size !== reference.bytes ||
      createHash('sha256').update(payload).digest('hex') !== reference.sha256
    ) {
      throw new Error(
        `Source cancellation evidence digest drifted: ${check}.`,
      );
    }
  }
}
