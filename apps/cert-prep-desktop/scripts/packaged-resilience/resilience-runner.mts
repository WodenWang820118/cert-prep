import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  cleanupAfterRunWithTimeout,
  forceCrashAndReconnect,
  launchAppAndConnect,
  prepareRunDirectories,
} from '../packaged-flow-smoke/app-lifecycle.mts';
import {
  createProject,
  uploadAndParsePdf,
} from '../packaged-flow-smoke/flow-steps.mts';
import {
  captureProjectApiAfterRestart,
  unavailableGenerationReadinessSnapshot,
} from '../packaged-flow-smoke/generation-readiness.mts';
import { installPythonRuntimeIfNeeded } from '../packaged-flow-smoke/runtime-install-flow.mts';
import type {
  ProjectApiRef,
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
  requireJsonObject,
  type JsonTransport,
} from './api-client.mts';
import type {
  EvidenceArtifactReference,
  EvidenceEnvelopeOptions,
} from './evidence-writer.mts';
import {
  writeResilienceEvidence,
  writeSessionRestartEvidence,
} from './evidence-writer.mts';
import type { ResilienceCheck } from './evidence-contract.mts';
import {
  runCancelableOperationScenario,
  type CancelableOperationScenario,
} from './operation-cancellation.mts';
import {
  startIsolatedOllama,
  type IsolatedOllamaController,
} from './ollama-isolation.mts';
import {
  OwnedProcessEvidenceTracker,
  type OwnedProcessesReleasedProof,
} from './owned-process-evidence.mts';
import type { RemainingResilienceOptions } from './remaining-options.mts';
import { encoded, pollJson, stringField } from './scenario-utils.mts';
import { runSessionRestartScenario } from './session-restart.mts';

const REMAINING_CHECKS = [
  'draft',
  'runtime',
  'model',
  'ownedProcessesReleased',
] as const satisfies readonly ResilienceCheck[];
const WINDOWSML_RUNTIME_KIND = 'windowsml_ocr';
const WINDOWSML_RUNTIME_PROVIDER = 'windowsml';
const WINDOWSML_RUNTIME_MODEL = 'pp-ocrv6-medium-windowsml';
const WINDOWSML_RUNTIME_MISSING_REASON = 'windowsml_runtime_missing';
const OLLAMA_MODEL = 'qwen3.5:4b';
const AUTO_DRAFT_TERMINAL_STATUSES = new Set([
  'succeeded',
  'skipped_provider_unavailable',
  'skipped_missing_model',
  'failed',
  'canceled',
]);

type RemainingCheck = (typeof REMAINING_CHECKS)[number];
type OperationCheck = Exclude<RemainingCheck, 'ownedProcessesReleased'>;

export interface TimedProof {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly proof: Readonly<Record<string, unknown>>;
}

export interface RemainingScenarioProofs {
  readonly draft: TimedProof;
  readonly runtime: TimedProof;
  readonly model: TimedProof;
  readonly sessionRestart: TimedProof;
}

export interface RemainingResilienceRunResult {
  readonly outputRoot: string;
  readonly evidence: Readonly<Record<RemainingCheck, EvidenceArtifactReference>>;
  readonly sessionRestart: EvidenceArtifactReference;
}

export interface UploadTriggeredDraftProof extends Record<string, unknown> {
  readonly jobCount: number;
  readonly statuses: readonly string[];
  readonly usableDraftCount: 0;
}

interface OwnedProcessTrackerPort {
  captureAppTree(appPid: number, expectedExecutablePath: string): readonly number[];
  proveReleased(
    finalAppPid: number,
    closedAt: string,
  ): Promise<OwnedProcessesReleasedProof>;
}

export interface RemainingResilienceRunnerDependencies {
  readonly now: () => Date;
  readonly prepareRunDirectories: typeof prepareRunDirectories;
  readonly processSnapshot: () => ProcessSnapshot;
  readonly launchAppAndConnect: typeof launchAppAndConnect;
  readonly startIsolatedOllama: typeof startIsolatedOllama;
  readonly executeScenarios: typeof executeRemainingResilienceScenarios;
  readonly cleanupAfterRun: typeof cleanupAfterRunWithTimeout;
  readonly installShutdownCleanup: typeof installProcessShutdownCleanup;
  readonly createProcessTracker: (
    baseline: ProcessSnapshot,
  ) => OwnedProcessTrackerPort;
  readonly writeEvidence: typeof writeResilienceEvidence;
  readonly writeSessionEvidence: typeof writeSessionRestartEvidence;
  readonly stagingId: () => string;
}

const DEFAULT_DEPENDENCIES: RemainingResilienceRunnerDependencies = {
  now: () => new Date(),
  prepareRunDirectories,
  processSnapshot,
  launchAppAndConnect,
  startIsolatedOllama,
  executeScenarios: executeRemainingResilienceScenarios,
  cleanupAfterRun: cleanupAfterRunWithTimeout,
  installShutdownCleanup: installProcessShutdownCleanup,
  createProcessTracker: (baseline) =>
    new OwnedProcessEvidenceTracker({ baselineProcesses: baseline.all }),
  writeEvidence: writeResilienceEvidence,
  writeSessionEvidence: writeSessionRestartEvidence,
  stagingId: randomUUID,
};

export async function runRemainingResilienceAcceptance(
  options: RemainingResilienceOptions,
  dependencyOverrides: Partial<RemainingResilienceRunnerDependencies> = {},
): Promise<RemainingResilienceRunResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const run = createRunState(options);
  dependencies.prepareRunDirectories(run);
  run.processBaseline = dependencies.processSnapshot();
  const processTracker = dependencies.createProcessTracker(run.processBaseline);
  let isolatedOllama: IsolatedOllamaController | null = null;
  const removeShutdownCleanup = dependencies.installShutdownCleanup({
    cleanup: async () => {
      run.metrics.status = 'failed';
      await cleanupAppAndOllama(
        run,
        dependencies.cleanupAfterRun,
        isolatedOllama,
      );
    },
  });

  let scenarioProofs: RemainingScenarioProofs | null = null;
  let finalAppPid: number | null = null;
  let processStartedAt = '';
  let processCompletedAt = '';
  let processProof: OwnedProcessesReleasedProof | null = null;
  let primaryError: unknown = null;
  let cleanupError: unknown = null;

  try {
    processStartedAt = dependencies.now().toISOString();
    isolatedOllama = await dependencies.startIsolatedOllama({
      ollamaExe: options.ollamaExePath,
      modelsRoot: options.ollamaModelsRoot,
      host: options.ollamaHost,
      timeoutMs: options.timeoutMs,
    });
    processTracker.captureAppTree(
      isolatedOllama.pid,
      options.ollamaExePath,
    );
    await dependencies.launchAppAndConnect(run);
    scenarioProofs = await dependencies.executeScenarios(
      run,
      options,
      processTracker,
      { now: dependencies.now },
    );
    processTracker.captureAppTree(
      isolatedOllama.pid,
      options.ollamaExePath,
    );
    finalAppPid = requireLiveAppPid(run);
    processTracker.captureAppTree(finalAppPid, options.installedExePath);
    run.metrics.status = 'completed';
  } catch (error) {
    primaryError = error;
    run.metrics.status = 'failed';
  } finally {
    try {
      await cleanupAppAndOllama(
        run,
        dependencies.cleanupAfterRun,
        isolatedOllama,
      );
      if (primaryError === null && finalAppPid !== null && isolatedOllama !== null) {
        const closedAt = dependencies.now().toISOString();
        processProof = await processTracker.proveReleased(finalAppPid, closedAt);
        processCompletedAt = orderedTimestamp(
          processStartedAt,
          dependencies.now().toISOString(),
        );
      }
    } catch (error) {
      cleanupError = error;
    } finally {
      removeShutdownCleanup();
    }
  }

  throwCombinedRunErrors(primaryError, cleanupError);
  assertCleanupCompleted(run);
  if (!scenarioProofs || !processProof || finalAppPid === null) {
    throw new Error('Remaining packaged resilience proofs were incomplete.');
  }

  const operationEnvelopes = buildOperationEnvelopes(options, scenarioProofs);
  const processEnvelope = envelope(
    options,
    processStartedAt,
    processCompletedAt,
    withInstallation(options, processProof),
    proofObservations(
      processStartedAt,
      processCompletedAt,
      processProof,
      'owned-processes.final-close',
    ),
  );
  const sessionEnvelope = envelope(
    options,
    scenarioProofs.sessionRestart.startedAt,
    scenarioProofs.sessionRestart.completedAt,
    withInstallation(options, scenarioProofs.sessionRestart.proof),
    proofObservations(
      scenarioProofs.sessionRestart.startedAt,
      scenarioProofs.sessionRestart.completedAt,
      scenarioProofs.sessionRestart.proof,
      'practice-session.restart',
    ),
  );
  return publishEvidenceAtomically(
    options.outputRoot,
    {
      ...operationEnvelopes,
      ownedProcessesReleased: processEnvelope,
    },
    sessionEnvelope,
    dependencies,
  );
}

async function cleanupAppAndOllama(
  run: SmokeRunState,
  cleanupApp: typeof cleanupAfterRunWithTimeout,
  ollama: IsolatedOllamaController | null,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await cleanupApp(run);
  } catch (error) {
    errors.push(error);
  }
  try {
    await ollama?.stop();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'App and isolated Ollama cleanup both failed.');
  }
}

export async function executeRemainingResilienceScenarios(
  run: SmokeRunState,
  options: RemainingResilienceOptions,
  processTracker: OwnedProcessTrackerPort,
  {
    now = () => new Date(),
    wait = delay,
  }: {
    readonly now?: () => Date;
    readonly wait?: (milliseconds: number) => Promise<unknown>;
  } = {},
): Promise<RemainingScenarioProofs> {
  await installPythonRuntimeIfNeeded(run);
  await createProject(run);
  let transport = createTransport(run);
  const selection = await exactProviderSelection(transport);

  const runtime = await captureTimedProof(now, async () => {
    const requirementBefore = await exactWindowsMlRequirement(
      transport,
      false,
      run.options.appDataDir,
    );
    const proof = await runCancelableOperationScenario(transport, {
      kind: 'runtime',
      startPath: `/runtime/installations/${WINDOWSML_RUNTIME_KIND}`,
      operationPath: (operationId) => `/runtime/installations/${encoded(operationId)}`,
      operationKind: WINDOWSML_RUNTIME_KIND,
      provider: WINDOWSML_RUNTIME_PROVIDER,
      model: WINDOWSML_RUNTIME_MODEL,
      timeoutMs: options.timeoutMs,
      afterCanceled: async () =>
        captureStableCanceledState(
          options.latePublishObservationWindowMs,
          wait,
          () =>
            exactWindowsMlRequirement(
              transport,
              false,
              run.options.appDataDir,
            ),
        ),
    });
    await waitForOperationSuccess(
      transport,
      operationIdFromCommitProof(proof, 'runtime'),
      (operationId) => `/runtime/installations/${encoded(operationId)}`,
      {
        kind: WINDOWSML_RUNTIME_KIND,
        provider: WINDOWSML_RUNTIME_PROVIDER,
        model: WINDOWSML_RUNTIME_MODEL,
      },
      options.timeoutMs,
      'runtime',
    );
    const requirementAfter = await exactWindowsMlRequirement(
      transport,
      true,
      run.options.appDataDir,
    );
    return { ...proof, requirementBefore, requirementAfter };
  });

  await uploadAndParsePdf(run);
  const projectApi = requireProjectApi(run);
  const uploadedDocument = run.uploadedDocument;
  if (
    !uploadedDocument ||
    uploadedDocument.projectId !== projectApi.projectId
  ) {
    throw new Error('Remaining resilience upload was not bound to the exact project.');
  }
  const autoDrafts = await drainUploadTriggeredDrafts(
    transport,
    projectApi.projectId,
    uploadedDocument.documentId,
    options.timeoutMs,
  );

  const model = await captureTimedProof(now, async () => {
    const tagsBefore = await exactOllamaTags(
      run.options.ollamaHost,
      false,
      options.timeoutMs,
    );
    const healthBefore = await exactOllamaHealth(transport, false);
    const proof = await runCancelableOperationScenario(transport, {
      kind: 'model',
      startPath: '/llm/model-downloads',
      operationPath: (operationId) => `/llm/model-downloads/${encoded(operationId)}`,
      provider: selection.provider,
      model: selection.model,
      timeoutMs: options.timeoutMs,
      afterCanceled: async () =>
        captureStableCanceledState(
          options.latePublishObservationWindowMs,
          wait,
          async () => ({
            tags: await exactOllamaTags(
              run.options.ollamaHost,
              false,
              options.timeoutMs,
            ),
            health: await exactOllamaHealth(transport, false),
          }),
        ),
    });
    await waitForOperationSuccess(
      transport,
      operationIdFromCommitProof(proof, 'model'),
      (operationId) => `/llm/model-downloads/${encoded(operationId)}`,
      { provider: selection.provider, model: selection.model },
      options.timeoutMs,
      'model',
    );
    const tagsAfter = await exactOllamaTags(
      run.options.ollamaHost,
      true,
      options.timeoutMs,
    );
    const healthAfter = await exactOllamaHealth(transport, true);
    return { ...proof, tagsBefore, tagsAfter, healthBefore, healthAfter };
  });

  const draft = await captureTimedProof(now, async () => {
    const startPath = `/projects/${encoded(projectApi.projectId)}/documents/${encoded(
      uploadedDocument.documentId,
    )}/draft-operations`;
    const scenario: CancelableOperationScenario = {
      kind: 'draft',
      startPath,
      operationPath: (operationId) => `${startPath}/${encoded(operationId)}`,
      startData: { limit: 2, strategy: 'hybrid_reasoning' },
      projectId: projectApi.projectId,
      documentId: uploadedDocument.documentId,
      provider: selection.provider,
      model: selection.model,
      timeoutMs: options.timeoutMs,
      afterCanceled: async () =>
        captureStableCanceledState(
          options.latePublishObservationWindowMs,
          wait,
          async () => ({
            usableDraftCount: await currentExactDocumentDraftCount(
              transport,
              projectApi.projectId,
              uploadedDocument.documentId,
            ),
          }),
        ),
    };
    const proof = await runCancelableOperationScenario(transport, scenario);
    const manualDraftTerminalResponse = await waitForOperationSuccess(
      transport,
      operationIdFromCommitProof(proof, 'draft'),
      scenario.operationPath,
      {
        project_id: projectApi.projectId,
        document_id: uploadedDocument.documentId,
        provider: selection.provider,
        model: selection.model,
      },
      options.timeoutMs,
      'draft',
    );
    const usableDraftCount = await waitForExactDocumentDrafts(
      transport,
      projectApi.projectId,
      uploadedDocument.documentId,
      options.timeoutMs,
    );
    return {
      ...proof,
      manualDraftTerminalResponse,
      uploadTriggeredJobs: autoDrafts,
      usableDraftCountBeforeManual: autoDrafts.usableDraftCount,
      usableDraftCountAfterManual: usableDraftCount,
    };
  });

  const sessionRestart = await captureTimedProof(now, async () =>
    runSessionRestartScenario({
      transport,
      page: requirePage(run),
      projectId: projectApi.projectId,
      documentId: uploadedDocument.documentId,
      timeoutMs: options.timeoutMs,
      restart: async (label) => {
        const previousAuthorization = requireProjectApi(run).authorization;
        const appPid = requireLiveAppPid(run);
        processTracker.captureAppTree(appPid, options.installedExePath);
        await forceCrashAndReconnect(run, label);
        const page = requirePage(run);
        const restartedProjectApi = await captureProjectApiAfterRestart(
          page,
          projectApi.projectId,
          options.timeoutMs,
        );
        if (restartedProjectApi.authorization === previousAuthorization) {
          throw new Error(`${label} reused the stale backend authorization token.`);
        }
        run.projectApi = restartedProjectApi;
        transport = createTransport(run);
        return { transport, page };
      },
    }),
  );

  return { draft, runtime, model, sessionRestart };
}

interface ProviderSelection {
  readonly provider: 'ollama';
  readonly model: string;
  readonly runtimeKind: 'ollama';
  readonly modelKind: 'ollama_model';
}

export async function exactProviderSelection(
  transport: JsonTransport,
): Promise<ProviderSelection> {
  const body = requireJsonObject(
    await transport.request('GET', '/llm/provider-selection'),
    [200],
    'remaining resilience provider selection',
  );
  const provider = stringField(body.effective_provider, 'effective provider');
  const model = stringField(body.effective_model, 'effective model');
  const runtimeKind = stringField(
    body.runtime_requirement_kind,
    'runtime requirement kind',
  );
  const modelKind = stringField(
    body.model_requirement_kind,
    'model requirement kind',
  );
  if (
    provider !== 'ollama' ||
    model !== OLLAMA_MODEL ||
    runtimeKind !== 'ollama' ||
    modelKind !== 'ollama_model' ||
    body.preference !== 'ollama' ||
    body.selected_provider !== provider ||
    body.configured_model !== model
  ) {
    throw new Error('Remaining resilience provider selection was not exact.');
  }
  return {
    provider: 'ollama',
    model,
    runtimeKind: 'ollama',
    modelKind: 'ollama_model',
  };
}

export async function exactWindowsMlRequirement(
  transport: JsonTransport,
  expectedAvailable: boolean,
  appDataDir: string | undefined,
): Promise<Record<string, unknown>> {
  const body = requireJsonObject(
    await transport.request('GET', '/runtime/requirements'),
    [200],
    'WindowsML runtime requirement',
  );
  if (!Array.isArray(body.items)) {
    throw new Error('WindowsML runtime requirements response was invalid.');
  }
  const matches = body.items.filter(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      (item as Record<string, unknown>).kind === WINDOWSML_RUNTIME_KIND,
  );
  if (matches.length !== 1) {
    throw new Error('WindowsML runtime requirement was missing or duplicated.');
  }
  const requirement = matches[0] as Record<string, unknown>;
  if (requirement.available !== expectedAvailable) {
    throw new Error(
      `WindowsML runtime availability was ${String(requirement.available)}; expected ${String(expectedAvailable)}.`,
    );
  }
  if (!appDataDir) {
    throw new Error('WindowsML runtime containment requires isolated app data.');
  }
  const canonicalAppData = realpathSync.native(resolve(appDataDir));
  const installedPath = requirement.installed_path;
  if (!expectedAvailable) {
    if (
      requirement.unavailable_reason !== WINDOWSML_RUNTIME_MISSING_REASON ||
      typeof installedPath !== 'string' ||
      !isAbsolute(installedPath)
    ) {
      throw new Error('WindowsML runtime was not a clean missing prerequisite.');
    }
    const resolvedInstallTarget = resolve(installedPath);
    if (lstatSync(resolvedInstallTarget, { throwIfNoEntry: false })) {
      throw new Error('WindowsML missing runtime target already existed.');
    }
    const canonicalInstallTarget = canonicalMissingTarget(resolvedInstallTarget);
    const installTargetRelative = containedRuntimeRelativePath(
      canonicalAppData,
      canonicalInstallTarget,
      'WindowsML missing runtime target was not contained by this acceptance app-data directory.',
    );
    return {
      kind: WINDOWSML_RUNTIME_KIND,
      available: false,
      unavailableReason: requirement.unavailable_reason,
      installTargetPathRelative: installTargetRelative,
    };
  }

  if (
    typeof installedPath !== 'string' ||
    !isAbsolute(installedPath) ||
    !existsSync(installedPath) ||
    !lstatSync(installedPath).isDirectory() ||
    lstatSync(installedPath).isSymbolicLink()
  ) {
    throw new Error('WindowsML installed path was missing or unsafe.');
  }
  const resolvedInstalledPath = resolve(installedPath);
  const canonicalInstalledPath = realpathSync.native(resolvedInstalledPath);
  if (!sameCanonicalPath(resolvedInstalledPath, canonicalInstalledPath)) {
    throw new Error('WindowsML installed path was not canonical.');
  }
  const installedRelative = containedRuntimeRelativePath(
    canonicalAppData,
    canonicalInstalledPath,
    'WindowsML installed path was not contained by this acceptance app-data directory.',
  );
  if (requirement.unavailable_reason !== null) {
    throw new Error('Available WindowsML runtime retained an unavailable reason.');
  }
  return {
    kind: WINDOWSML_RUNTIME_KIND,
    available: true,
    installedPathRelative: installedRelative.replaceAll('\\', '/'),
  };
}

export async function exactOllamaTags(
  host: string | undefined,
  expectedInstalled: boolean,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const origin = exactOllamaOrigin(host);
  const response = await fetchImpl(`${origin}/api/tags`, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (
    response.status !== 200 ||
    !response.headers.get('content-type')?.toLowerCase().includes('application/json')
  ) {
    throw new Error(`Isolated Ollama tags returned HTTP ${response.status} or non-JSON.`);
  }
  const body = await response.json().catch(() => null);
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray((body as Record<string, unknown>).models)
  ) {
    throw new Error('Isolated Ollama tags response was invalid.');
  }
  const modelNames = ((body as Record<string, unknown>).models as unknown[]).map(
    (raw) => {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error('Isolated Ollama tags contained an invalid model.');
      }
      const model = raw as Record<string, unknown>;
      const name = model.name ?? model.model;
      return stringField(name, 'isolated Ollama model name');
    },
  );
  const exactCount = modelNames.filter((name) => name === OLLAMA_MODEL).length;
  if (
    (!expectedInstalled && modelNames.length !== 0) ||
    (expectedInstalled && (modelNames.length !== 1 || exactCount !== 1))
  ) {
    throw new Error(
      `Isolated Ollama model store did not match expected ${expectedInstalled ? 'installed' : 'empty'} state.`,
    );
  }
  return { modelNames };
}

function exactOllamaOrigin(host: string | undefined): string {
  if (!host) {
    throw new Error('Remaining resilience requires an isolated Ollama host.');
  }
  let parsed: URL;
  try {
    parsed = new URL(host);
  } catch {
    throw new Error('Remaining resilience isolated Ollama host was invalid.');
  }
  const port = Number(parsed.port);
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    !parsed.port ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error('Remaining resilience isolated Ollama host was not loopback HTTP.');
  }
  return parsed.origin;
}

export async function exactOllamaHealth(
  transport: JsonTransport,
  expectedAvailable: boolean,
): Promise<Record<string, unknown>> {
  const health = requireJsonObject(
    await transport.request('GET', '/llm/health'),
    [200],
    'isolated Ollama health',
  );
  if (
    health.provider !== 'ollama' ||
    health.model !== OLLAMA_MODEL ||
    health.configured_model !== OLLAMA_MODEL ||
    health.available !== expectedAvailable ||
    typeof health.detail !== 'string' ||
    health.detail.trim().length === 0
  ) {
    throw new Error('Isolated Ollama health provider/model state was not exact.');
  }
  if (
    (!expectedAvailable &&
      (health.unavailable_reason !== 'model_missing' ||
        health.effective_model !== null)) ||
    (expectedAvailable &&
      (health.unavailable_reason !== null ||
        health.effective_model !== OLLAMA_MODEL))
  ) {
    throw new Error('Isolated Ollama health availability transition was not exact.');
  }
  return {
    provider: 'ollama',
    model: OLLAMA_MODEL,
    available: expectedAvailable,
    unavailableReason: health.unavailable_reason,
    effectiveModel: health.effective_model,
  };
}

export async function drainUploadTriggeredDrafts(
  transport: JsonTransport,
  projectId: string,
  documentId: string,
  timeoutMs: number,
): Promise<UploadTriggeredDraftProof> {
  const jobsPath = `/projects/${encoded(projectId)}/documents/${encoded(
    documentId,
  )}/draft-jobs`;
  const terminal = await pollJson(
    transport,
    jobsPath,
    (body) => {
      const items = exactDraftJobItems(body, projectId, documentId);
      return (
        items.length > 0 &&
        items.every((item) => AUTO_DRAFT_TERMINAL_STATUSES.has(String(item.status)))
      );
    },
    { timeoutMs, label: 'upload-triggered automatic draft jobs' },
  );
  const jobs = exactDraftJobItems(terminal, projectId, documentId);
  if (jobs.some((job) => job.status !== 'skipped_missing_model')) {
    throw new Error(
      'Upload-triggered draft jobs did not all terminate on the isolated missing model.',
    );
  }
  const drafts = requireJsonObject(
    await transport.request('GET', `/projects/${encoded(projectId)}/question-drafts`),
    [200],
    'drafts before manual generation',
  );
  const usable = exactUsableDrafts(drafts, projectId, documentId);
  if (usable.length !== 0) {
    throw new Error('Automatic draft jobs published usable questions before manual proof.');
  }
  return {
    jobCount: jobs.length,
    statuses: jobs.map((job) => String(job.status)),
    usableDraftCount: 0,
  };
}

function exactDraftJobItems(
  body: Record<string, unknown>,
  projectId: string,
  documentId: string,
): Record<string, unknown>[] {
  if (!Array.isArray(body.items)) {
    throw new Error('Automatic draft job list was invalid.');
  }
  return body.items.map((raw) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('Automatic draft job item was invalid.');
    }
    const item = raw as Record<string, unknown>;
    const status = String(item.status);
    if (
      item.project_id !== projectId ||
      item.document_id !== documentId ||
      typeof item.id !== 'string' ||
      item.id.trim().length === 0 ||
      (!AUTO_DRAFT_TERMINAL_STATUSES.has(status) &&
        !['pending', 'running', 'cancel_requested'].includes(status))
    ) {
      throw new Error('Automatic draft job response scope was not exact.');
    }
    return item;
  });
}

export async function waitForExactDocumentDrafts(
  transport: JsonTransport,
  projectId: string,
  documentId: string,
  timeoutMs: number,
): Promise<number> {
  const body = await pollJson(
    transport,
    `/projects/${encoded(projectId)}/question-drafts`,
    (candidate) => exactUsableDrafts(candidate, projectId, documentId).length >= 2,
    { timeoutMs, label: 'manual draft publication' },
  );
  const usable = exactUsableDrafts(body, projectId, documentId);
  if (usable.length < 2) {
    throw new Error('Manual draft commit did not publish two usable questions.');
  }
  return usable.length;
}

async function currentExactDocumentDraftCount(
  transport: JsonTransport,
  projectId: string,
  documentId: string,
): Promise<number> {
  const body = requireJsonObject(
    await transport.request(
      'GET',
      `/projects/${encoded(projectId)}/question-drafts`,
    ),
    [200],
    'current exact-document question drafts',
  );
  return exactUsableDrafts(body, projectId, documentId).length;
}

function exactUsableDrafts(
  body: Record<string, unknown>,
  projectId: string,
  documentId: string,
): Record<string, unknown>[] {
  if (!Array.isArray(body.items)) {
    throw new Error('Question draft list was invalid.');
  }
  return body.items.filter((raw) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('Question draft item was invalid.');
    }
    const item = raw as Record<string, unknown>;
    if (item.project_id !== projectId) {
      throw new Error('Question draft response escaped the exact project.');
    }
    const answer = item.answer;
    const usable = typeof answer === 'string' && answer.trim().length > 0;
    if (usable && item.document_id !== documentId) {
      throw new Error('Usable question draft escaped the exact document.');
    }
    return usable && item.document_id === documentId;
  }) as Record<string, unknown>[];
}

async function waitForOperationSuccess(
  transport: JsonTransport,
  operationId: string,
  operationPath: (operationId: string) => string,
  expectedScope: Readonly<Record<string, string>>,
  timeoutMs: number,
  label: string,
): Promise<Record<string, unknown>> {
  const terminal = await pollJson(
    transport,
    operationPath(operationId),
    (body) => ['succeeded', 'failed', 'canceled'].includes(String(body.status)),
    { timeoutMs, label: `${label} committed terminal` },
  );
  exactOperationScope(terminal, expectedScope, label, operationId);
  if (
    terminal.status !== 'succeeded' ||
    terminal.phase !== 'completed' ||
    terminal.cancellable !== false ||
    typeof terminal.commit_started_at !== 'string'
  ) {
    throw new Error(`${label} committed operation did not succeed durably.`);
  }
  return terminal;
}

function exactOperationScope(
  body: Record<string, unknown>,
  expectedScope: Readonly<Record<string, string>>,
  label: string,
  expectedOperationId?: string,
): string {
  const operationId = stringField(body.id, `${label} operation id`);
  if (expectedOperationId !== undefined && operationId !== expectedOperationId) {
    throw new Error(`${label} operation ID drifted.`);
  }
  for (const [key, expected] of Object.entries(expectedScope)) {
    if (body[key] !== expected) {
      throw new Error(`${label} ${key} scope drifted.`);
    }
  }
  return operationId;
}

function operationIdFromCommitProof(
  proof: Readonly<Record<string, unknown>>,
  label: string,
): string {
  const raw = proof.nonCancellableResponse;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${label} non-cancellable proof was missing.`);
  }
  return stringField(
    (raw as Record<string, unknown>).operationId,
    `${label} commit operation ID`,
  );
}

async function captureTimedProof(
  now: () => Date,
  action: () => Promise<Readonly<Record<string, unknown>>>,
): Promise<TimedProof> {
  const startedAt = now().toISOString();
  const proof = await action();
  const completedAt = orderedTimestamp(startedAt, now().toISOString());
  return { startedAt, completedAt, proof };
}

async function captureStableCanceledState(
  observationWindowMs: number,
  wait: (milliseconds: number) => Promise<unknown>,
  capture: () => Promise<Readonly<Record<string, unknown>>>,
): Promise<Readonly<Record<string, unknown>>> {
  if (!Number.isInteger(observationWindowMs) || observationWindowMs < 1_000) {
    throw new Error('Canceled-state observation window must be at least 1000 ms.');
  }
  const immediate = await capture();
  await wait(observationWindowMs);
  const afterWindow = await capture();
  return { observationWindowMs, immediate, afterWindow };
}

function orderedTimestamp(startedAt: string, candidateCompletedAt: string): string {
  const started = Date.parse(startedAt);
  const completed = Date.parse(candidateCompletedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed)) {
    throw new Error('Remaining resilience evidence timestamps were invalid.');
  }
  return new Date(Math.max(completed, started + 1)).toISOString();
}

function createRunState(options: RemainingResilienceOptions): SmokeRunState {
  const smokeOptions: SmokeOptions = {
    workspaceRoot: options.workspaceRoot,
    exePath: options.installedExePath,
    pdfPath: options.pdfPath,
    outDir: options.diagnosticsRoot,
    appDataDir: join(options.diagnosticsRoot, 'app-data'),
    cdpPort: options.cdpPort,
    ocrProvider: 'windowsml',
    ocrPageWorkers: 1,
    llmProvider: 'ollama',
    ollamaModel: OLLAMA_MODEL,
    ollamaFallbackModels: [],
    ollamaHost: `http://${options.ollamaHost}`,
    ollamaModelsDir: options.ollamaModelsRoot,
    ollamaProfileEnabled: false,
    acceptanceLane: 'ollama-fallback',
    candidateDistributionProfile: options.candidateDistributionProfile,
    waitForStreamingComplete: false,
    streamingCompleteTimeoutMs: options.timeoutMs,
    streamingDraftPageLimit: 1,
    streamingDraftWorkers: 1,
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
    app_data_dir: relative(options.workspaceRoot, smokeOptions.appDataDir ?? ''),
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
    nvidia: null,
    resourceSampling: null,
    videoRecording: null,
    browser: null,
    page: null,
    port: options.cdpPort,
    processBaseline: { all: [], nodePids: new Set() },
    ownedFastFlowProcesses: null,
    trustedFastFlowExecutablePath: null,
    projectApi: null,
    uploadedDocument: null,
    streamingDraftParseStartedAt: null,
    streamingDraftCaptureOpen: false,
    streamingApiPollErrorCaptured: false,
  };
}

function createTransport(run: SmokeRunState): JsonTransport {
  return playwrightJsonTransport(requirePage(run).request, requireProjectApi(run));
}

function requirePage(run: SmokeRunState): NonNullable<SmokeRunState['page']> {
  if (!run.page) {
    throw new Error('Remaining resilience packaged page was not connected.');
  }
  return run.page;
}

function requireProjectApi(run: SmokeRunState): ProjectApiRef {
  if (!run.projectApi) {
    throw new Error('Remaining resilience project API context was not captured.');
  }
  return run.projectApi;
}

function requireLiveAppPid(run: SmokeRunState): number {
  const pid = run.app?.pid;
  if (!pid || run.app?.exitCode !== null || run.app.killed) {
    throw new Error('Remaining resilience requires a live packaged app PID.');
  }
  return pid;
}

function assertCleanupCompleted(run: SmokeRunState): void {
  if (run.metrics.errors.length > 0) {
    throw new Error(
      `Remaining resilience cleanup recorded errors: ${run.metrics.errors.join(' | ')}`,
    );
  }
  const finalClose = run.metrics.final_close;
  const processCleanup = run.metrics.process_cleanup;
  if (
    run.app !== null ||
    run.browser !== null ||
    !finalClose ||
    !finalClose.gracefulExited ||
    finalClose.fallbackUsed ||
    finalClose.residue.length !== 0 ||
    finalClose.residualProcesses.length !== 0 ||
    !processCleanup ||
    processCleanup.residue_after_close.length !== 0
  ) {
    throw new Error('Remaining resilience cleanup did not finish through a clean close.');
  }
}

function throwCombinedRunErrors(primaryError: unknown, cleanupError: unknown): void {
  if (primaryError !== null && cleanupError !== null) {
    throw new AggregateError(
      [primaryError, cleanupError],
      'Remaining resilience scenarios and cleanup both failed.',
    );
  }
  if (primaryError !== null) {
    throw primaryError;
  }
  if (cleanupError !== null) {
    throw cleanupError;
  }
}

function buildOperationEnvelopes(
  options: RemainingResilienceOptions,
  scenarios: RemainingScenarioProofs,
): Readonly<Record<OperationCheck, EvidenceEnvelopeOptions>> {
  return Object.fromEntries(
    (['draft', 'runtime', 'model'] as const).map((check) => {
      const timed = scenarios[check];
      return [
        check,
        envelope(
          options,
          timed.startedAt,
          timed.completedAt,
          withInstallation(options, timed.proof),
          proofObservations(
            timed.startedAt,
            timed.completedAt,
            timed.proof,
            `${check}.cancel-and-commit`,
          ),
        ),
      ];
    }),
  ) as unknown as Readonly<Record<OperationCheck, EvidenceEnvelopeOptions>>;
}

function envelope(
  options: RemainingResilienceOptions,
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
    proof,
  };
}

function withInstallation(
  options: RemainingResilienceOptions,
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

function proofObservations(
  startedAt: string,
  completedAt: string,
  proof: Readonly<Record<string, unknown>>,
  event: string,
): EvidenceEnvelopeOptions['observations'] {
  const projectId = optionalString(proof.projectId);
  const documentId = optionalString(proof.documentId);
  const operationId = optionalString(proof.operationId);
  const sessionId = optionalString(proof.sessionId);
  return [
    {
      at: startedAt,
      event: `${event}.started`,
      ...(projectId ? { projectId } : {}),
      ...(documentId ? { documentId } : {}),
      ...(operationId ? { operationId } : {}),
      ...(sessionId ? { sessionId } : {}),
    },
    {
      at: completedAt,
      event: `${event}.verified`,
      ...(projectId ? { projectId } : {}),
      ...(documentId ? { documentId } : {}),
      ...(operationId ? { operationId } : {}),
      ...(sessionId ? { sessionId } : {}),
    },
  ];
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function canonicalMissingTarget(resolvedTarget: string): string {
  let ancestor = dirname(resolvedTarget);
  let ancestorEntry = lstatSync(ancestor, { throwIfNoEntry: false });
  while (!ancestorEntry) {
    const parent = dirname(ancestor);
    if (sameCanonicalPath(parent, ancestor)) {
      throw new Error('WindowsML missing runtime target had no existing ancestor.');
    }
    ancestor = parent;
    ancestorEntry = lstatSync(ancestor, { throwIfNoEntry: false });
  }
  if (!ancestorEntry.isDirectory() || ancestorEntry.isSymbolicLink()) {
    throw new Error('WindowsML missing runtime target ancestor was unsafe.');
  }
  const canonicalAncestor = realpathSync.native(ancestor);
  if (!sameCanonicalPath(ancestor, canonicalAncestor)) {
    throw new Error('WindowsML missing runtime target ancestor was not canonical.');
  }
  return resolve(canonicalAncestor, relative(ancestor, resolvedTarget));
}

function containedRuntimeRelativePath(
  canonicalAppData: string,
  canonicalRuntimePath: string,
  errorMessage: string,
): string {
  const runtimeRelative = relative(canonicalAppData, canonicalRuntimePath);
  if (
    !runtimeRelative ||
    runtimeRelative === '..' ||
    runtimeRelative.startsWith(`..${sep}`) ||
    isAbsolute(runtimeRelative)
  ) {
    throw new Error(errorMessage);
  }
  return runtimeRelative.replaceAll('\\', '/');
}

function publishEvidenceAtomically(
  outputRoot: string,
  envelopes: Readonly<Record<RemainingCheck, EvidenceEnvelopeOptions>>,
  sessionEnvelope: EvidenceEnvelopeOptions,
  dependencies: Pick<
    RemainingResilienceRunnerDependencies,
    'stagingId' | 'writeEvidence' | 'writeSessionEvidence'
  >,
): RemainingResilienceRunResult {
  if (existsSync(outputRoot)) {
    throw new Error('Remaining resilience evidence output already exists.');
  }
  const stagingRoot = join(
    join(outputRoot, '..'),
    `.${basename(outputRoot)}.preparing-${dependencies.stagingId()}`,
  );
  if (existsSync(stagingRoot)) {
    throw new Error('Remaining resilience evidence staging path already exists.');
  }
  mkdirSync(stagingRoot);
  try {
    const evidence = Object.fromEntries(
      REMAINING_CHECKS.map((check) => [
        check,
        dependencies.writeEvidence(stagingRoot, check, envelopes[check]),
      ]),
    ) as Record<RemainingCheck, EvidenceArtifactReference>;
    const sessionRestart = dependencies.writeSessionEvidence(
      stagingRoot,
      sessionEnvelope,
    );
    assertExactEvidenceTree(stagingRoot, evidence, sessionRestart);
    renameSync(stagingRoot, outputRoot);
    return { outputRoot, evidence, sessionRestart };
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

function assertExactEvidenceTree(
  stagingRoot: string,
  evidence: Readonly<Record<RemainingCheck, EvidenceArtifactReference>>,
  sessionRestart: EvidenceArtifactReference,
): void {
  const rootNames = readdirSync(stagingRoot).sort();
  if (
    rootNames.length !== 2 ||
    rootNames[0] !== 'cancellation' ||
    rootNames[1] !== 'session-restart.json'
  ) {
    throw new Error('Remaining resilience staging contained undeclared files.');
  }
  const cancellationRoot = join(stagingRoot, 'cancellation');
  const actualNames = readdirSync(cancellationRoot).sort();
  const expectedNames = REMAINING_CHECKS.map((check) => `${check}.json`).sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error('Remaining resilience staging had incomplete cancellation evidence.');
  }
  for (const reference of [...Object.values(evidence), sessionRestart]) {
    const path = join(stagingRoot, ...reference.path.split('/'));
    const payload = readFileSync(path);
    if (
      statSync(path).size !== reference.bytes ||
      createHash('sha256').update(payload).digest('hex') !== reference.sha256
    ) {
      throw new Error(`Remaining resilience evidence digest drifted: ${reference.path}.`);
    }
  }
}
