import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  loadDocumentCancellationOptions,
  loadInstalledCandidateBinding,
  type DocumentCancellationRunnerOptions,
  type InstalledCandidateRunnerBinding,
} from '../packaged-resilience/args.mts';
import { parsePackagedFlowSmokeArgs } from './args.mts';
import { runPackagedFlowSmoke } from './runner.mts';
import type { SmokeMetrics, SmokeOptions } from './types.mts';

const EVIDENCE_FILE_NAME = 'local-ollama-fallback-evidence.json';
const REQUIRED_OLLAMA_ACCEPTANCE_CHECKS = [
  'acceptance_lane_preference_exact',
  'acceptance_lane_provider_exact',
  'acceptance_lane_model_exact',
  'acceptance_lane_provider_fallback_reason_present',
  'acceptance_lane_model_fallback_reason_separate',
  'acceptance_lane_route_persisted',
  'acceptance_lane_no_overrides_or_fake',
  'acceptance_lane_runtime_real',
  'acceptance_lane_model_onboarding_verified',
  'acceptance_lane_job_evidence_bound',
  'acceptance_lane_usable_and_full_exam',
  'acceptance_lane_ollama_model_released',
  'acceptance_lane_fresh_run_isolation',
  'acceptance_lane_process_isolation',
] as const;
const ACCEPTED_OLLAMA_MODEL = /qwen3\.5(?::|-)(?:4b|2b)(?:\b|-)/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = resolve(scriptDir, '../../../..');

export interface LocalCandidateOllamaFallbackPlan {
  readonly installedCandidate: DocumentCancellationRunnerOptions;
  readonly smokeOptions: SmokeOptions;
}

export interface LocalCandidateOllamaFallbackDependencies {
  readonly loadDocumentOptions: (
    environment: Readonly<NodeJS.ProcessEnv>,
    workspaceRoot: string,
  ) => Promise<DocumentCancellationRunnerOptions>;
  readonly reloadInstalledCandidate: (
    environment: Readonly<NodeJS.ProcessEnv>,
    workspaceRoot: string,
  ) => Promise<InstalledCandidateRunnerBinding>;
  readonly runSmoke: (options: SmokeOptions) => Promise<SmokeMetrics>;
}

const defaultDependencies: LocalCandidateOllamaFallbackDependencies = {
  loadDocumentOptions: loadDocumentCancellationOptions,
  reloadInstalledCandidate: loadInstalledCandidateBinding,
  runSmoke: runPackagedFlowSmoke,
};

export async function loadLocalCandidateOllamaFallbackPlan(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  workspaceRoot = defaultWorkspaceRoot,
  loadDocumentOptions: LocalCandidateOllamaFallbackDependencies['loadDocumentOptions'] =
    loadDocumentCancellationOptions,
): Promise<LocalCandidateOllamaFallbackPlan> {
  const installedCandidate = await loadDocumentOptions(
    environment,
    workspaceRoot,
  );
  if (
    installedCandidate.candidateDistributionProfile !== 'local_nonpublishable'
  ) {
    throw new Error(
      'Local forced-Ollama acceptance requires an exact local_nonpublishable candidate.',
    );
  }
  if (installedCandidate.installation.packageKind !== 'nsis') {
    throw new Error(
      'Local forced-Ollama acceptance requires the schema-v1 NSIS install receipt.',
    );
  }

  const smokeOptions = parsePackagedFlowSmokeArgs(
    [
      '--exe',
      installedCandidate.installedExePath,
      '--pdf',
      installedCandidate.pdfPath,
      '--out-dir',
      installedCandidate.outputRoot,
      '--app-data-dir',
      join(installedCandidate.outputRoot, 'app-data'),
      '--cdp-port',
      String(installedCandidate.cdpPort),
      '--production-summary',
      '--allow-ocr-chunk-variance',
      '--ocr-provider',
      'windowsml',
      '--ocr-page-workers',
      '1',
      '--llm-provider',
      'auto',
      '--llm-model',
      'qwen3.5:4b',
      '--llm-fallback-models',
      'qwen3.5:2b',
      '--acceptance-lane',
      'ollama-fallback',
      '--ollama-fallback-trigger',
      'declined-terms',
      '--streaming-draft-page-limit',
      '1',
      '--streaming-draft-workers',
      '1',
      '--streaming-complete-timeout-ms',
      String(installedCandidate.timeoutMs),
      '--wait-for-streaming-complete',
      '--verify-streaming-practice-ready',
    ],
    installedCandidate.workspaceRoot,
  );

  return {
    installedCandidate,
    smokeOptions: {
      ...smokeOptions,
      candidateDistributionProfile: 'local_nonpublishable',
    },
  };
}

export async function runLocalCandidateOllamaFallbackAcceptance(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  workspaceRoot = defaultWorkspaceRoot,
  dependencies: LocalCandidateOllamaFallbackDependencies = defaultDependencies,
): Promise<Readonly<Record<string, unknown>>> {
  const plan = await loadLocalCandidateOllamaFallbackPlan(
    environment,
    workspaceRoot,
    dependencies.loadDocumentOptions,
  );
  const metrics = await dependencies.runSmoke(plan.smokeOptions);
  const revalidated = await dependencies.reloadInstalledCandidate(
    environment,
    workspaceRoot,
  );
  assertBindingUnchanged(plan.installedCandidate, revalidated);
  return writeLocalCandidateOllamaFallbackEvidence(plan, metrics);
}

export async function runLocalCandidateOllamaFallbackCli(): Promise<void> {
  const evidence = await runLocalCandidateOllamaFallbackAcceptance();
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

export function writeLocalCandidateOllamaFallbackEvidence(
  plan: LocalCandidateOllamaFallbackPlan,
  metrics: SmokeMetrics,
): Readonly<Record<string, unknown>> {
  if (
    metrics.status !== 'completed' ||
    metrics.errors.length !== 0 ||
    !metrics.finished_at
  ) {
    throw new Error(
      'Local forced-Ollama acceptance did not complete without script errors.',
    );
  }
  const startedAt = timestamp(metrics.started_at, 'metrics.started_at');
  const completedAt = timestamp(metrics.finished_at, 'metrics.finished_at');
  if (
    completedAt <= startedAt ||
    Date.parse(plan.installedCandidate.installation.installedAt) > startedAt
  ) {
    throw new Error(
      'Local forced-Ollama evidence timestamps do not follow the verified installation.',
    );
  }

  const outputRoot = plan.installedCandidate.outputRoot;
  const metricsPath = safeOutputFile(outputRoot, 'metrics.json');
  const summaryPath = safeOutputFile(outputRoot, 'production-summary.json');
  const summary = readJsonObject(summaryPath, 'production summary');
  const observedAttribution = assertPassedOllamaFallbackSummary(summary);

  const evidencePath = resolve(outputRoot, EVIDENCE_FILE_NAME);
  if (existsSync(evidencePath)) {
    throw new Error('Local forced-Ollama evidence already exists.');
  }
  const installation = plan.installedCandidate.installation;
  const evidence = {
    schemaVersion: 1,
    check: 'forcedOllamaFallback',
    passed: true,
    startedAt: metrics.started_at,
    completedAt: metrics.finished_at,
    acceptanceRunId: plan.installedCandidate.acceptanceRunId,
    candidate: {
      ...plan.installedCandidate.candidate,
      distributionProfile: 'local_nonpublishable',
      publishable: false,
      root: plan.installedCandidate.candidateRoot,
    },
    installation: {
      receipt: {
        path: installation.receiptPath,
        sha256: installation.receiptSha256,
      },
      packageKind: installation.packageKind,
      installer: {
        relativePath: installation.installerRelativePath,
        sha256: installation.installerSha256,
      },
      installedExecutable: {
        path: plan.installedCandidate.installedExePath,
        name: installation.installedExeName,
        bytes: installation.installedExeBytes,
        sha256: installation.installedExeSha256,
      },
      installedAt: installation.installedAt,
    },
    execution: {
      acceptanceLane: 'ollama-fallback',
      fallbackTrigger: 'declined-terms',
      configuredModel: 'qwen3.5:4b',
      lowResourceFallbackModel: 'qwen3.5:2b',
      ocrProvider: 'windowsml',
      localOcrRuntimeUrlAllowed: true,
      observedAttribution,
    },
    artifacts: {
      metrics: artifactReference(
        plan.installedCandidate.workspaceRoot,
        metricsPath,
      ),
      productionSummary: artifactReference(
        plan.installedCandidate.workspaceRoot,
        summaryPath,
      ),
    },
  } as const;
  writeJsonAtomically(evidencePath, evidence);
  return evidence;
}

function assertBindingUnchanged(
  before: InstalledCandidateRunnerBinding,
  after: InstalledCandidateRunnerBinding,
): void {
  const beforeIdentity = {
    workspaceRoot: before.workspaceRoot,
    candidateRoot: before.candidateRoot,
    installedExePath: before.installedExePath,
    acceptanceRunId: before.acceptanceRunId,
    candidate: before.candidate,
    candidateDistributionProfile: before.candidateDistributionProfile,
    installation: before.installation,
  };
  const afterIdentity = {
    workspaceRoot: after.workspaceRoot,
    candidateRoot: after.candidateRoot,
    installedExePath: after.installedExePath,
    acceptanceRunId: after.acceptanceRunId,
    candidate: after.candidate,
    candidateDistributionProfile: after.candidateDistributionProfile,
    installation: after.installation,
  };
  if (JSON.stringify(beforeIdentity) !== JSON.stringify(afterIdentity)) {
    throw new Error(
      'Installed candidate binding changed during forced-Ollama acceptance.',
    );
  }
}

function assertPassedOllamaFallbackSummary(
  summary: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  const checks = record(summary.checks, 'production summary checks');
  const checkValues = Object.values(checks);
  const fallback = record(
    summary.ollama_fallback_acceptance,
    'production Ollama fallback acceptance',
  );
  const release = record(
    fallback.resource_release,
    'production Ollama resource release',
  );
  const configuredModel = acceptedOllamaModel(
    summary.configured_model,
    'production configured model',
  );
  const effectiveModel = acceptedOllamaModel(
    summary.effective_model,
    'production effective model',
  );
  const providerFallbackReason = nonEmptyString(
    summary.provider_fallback_reason,
    'production provider fallback reason',
  );
  const modelFallbackReason = optionalReason(
    summary.model_fallback_reason,
    'production model fallback reason',
  );
  const fallbackProviderReason = nonEmptyString(
    fallback.provider_fallback_reason,
    'Ollama fallback provider reason',
  );
  const fallbackModelReason = optionalReason(
    fallback.model_fallback_reason,
    'Ollama fallback model reason',
  );
  const processRelease = processReleaseEvidence(summary);
  const modelRelease = modelReleaseEvidence(release, effectiveModel);
  const modelOnboarding = modelOnboardingEvidence(fallback);
  if (
    summary.schema_version !== 4 ||
    summary.status !== 'passed' ||
    summary.acceptance_lane !== 'ollama-fallback' ||
    checkValues.length === 0 ||
    !checkValues.every((value) => value === true) ||
    !REQUIRED_OLLAMA_ACCEPTANCE_CHECKS.every(
      (check) => checks[check] === true,
    ) ||
    summary.provider_preference !== 'auto' ||
    summary.configured_provider !== 'ollama' ||
    summary.llm_provider !== 'ollama' ||
    providerFallbackReason !== fallbackProviderReason ||
    modelFallbackReason !== fallbackModelReason ||
    modelFallbackReason === providerFallbackReason ||
    fallback.schema_version !== 2 ||
    fallback.trigger !== 'declined-terms' ||
    fallback.overrides_used !== false ||
    fallback.fake_provider_observed !== false ||
    release.released !== true
  ) {
    throw new Error(
      'Production summary does not prove the real declined-terms Ollama fallback lane.',
    );
  }

  return {
    providerPreference: 'auto',
    configuredProvider: 'ollama',
    effectiveProvider: 'ollama',
    configuredModel,
    effectiveModel,
    providerFallbackReason,
    modelFallbackReason,
    acceptanceChecks: Object.fromEntries(
      REQUIRED_OLLAMA_ACCEPTANCE_CHECKS.map((check) => [check, true]),
    ),
    resourceRelease: {
      process: processRelease,
      model: modelRelease,
    },
    modelOnboarding,
  } as const;
}

function modelOnboardingEvidence(
  fallback: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  const onboarding = record(
    fallback.model_onboarding,
    'production Ollama model onboarding',
  );
  const runtime = record(fallback.runtime, 'production Ollama runtime');
  const profile = record(runtime.profile, 'production Ollama runtime profile');
  const restartedSelection = record(
    fallback.selection_after_restart,
    'production restarted Ollama selection',
  );
  const startedAt = validTimestampString(
    onboarding.started_at,
    'production Ollama onboarding started_at',
  );
  const completedAt = validTimestampString(
    onboarding.completed_at,
    'production Ollama onboarding completed_at',
  );
  const restartedAt = validTimestampString(
    restartedSelection.captured_at,
    'production restarted Ollama selection captured_at',
  );
  const profileId = nonEmptyString(
    onboarding.profile_id,
    'production Ollama onboarding profile id',
  );
  const effectiveModel = acceptedOllamaModel(
    onboarding.effective_model,
    'production Ollama onboarding effective model',
  );
  const baseModel = acceptedOllamaModel(
    onboarding.base_model,
    'production Ollama onboarding base model',
  );
  const modelfileSha256 = nonEmptyString(
    onboarding.modelfile_sha256,
    'production Ollama onboarding Modelfile hash',
  );
  const fallbackModels = stringArray(
    onboarding.fallback_models,
    'production Ollama onboarding fallback models',
  );
  const requiredModels = stringArray(
    onboarding.required_models,
    'production Ollama onboarding required models',
  );
  const installedBefore = stringArray(
    onboarding.installed_models_before,
    'production Ollama onboarding installed models before',
  );
  const missingBefore = stringArray(
    onboarding.missing_models_before,
    'production Ollama onboarding missing models before',
  );
  const installedAfter = stringArray(
    onboarding.installed_models_after,
    'production Ollama onboarding installed models after',
  );
  const runtimeInstalled = stringArray(
    runtime.installed_models,
    'production Ollama runtime installed models',
  );
  const runtimeFallbackModels = stringArray(
    profile.fallback_models,
    'production Ollama runtime fallback models',
  );
  const expectedMissing = requiredModels.filter(
    (required) => !containsOllamaModel(installedBefore, required),
  );
  const mode = onboarding.mode;
  const job = onboarding.job;
  if (
    onboarding.schema_version !== 1 ||
    onboarding.endpoint !== '/llm/model-downloads' ||
    (mode !== 'reused' && mode !== 'installed') ||
    onboarding.profile_selection_stable !== true ||
    Date.parse(completedAt) < Date.parse(startedAt) ||
    Date.parse(restartedAt) < Date.parse(completedAt) ||
    !SHA256_PATTERN.test(modelfileSha256) ||
    requiredModels.length === 0 ||
    new Set(requiredModels).size !== requiredModels.length ||
    requiredModels[0] !== effectiveModel ||
    !sameStringArray(requiredModels.slice(1), fallbackModels) ||
    !sameStringArray(expectedMissing, missingBefore) ||
    !requiredModels.every((required) =>
      containsOllamaModel(installedAfter, required),
    ) ||
    !requiredModels.every((required) =>
      containsOllamaModel(runtimeInstalled, required),
    ) ||
    profile.profile_id !== profileId ||
    profile.effective_model !== effectiveModel ||
    profile.base_model !== baseModel ||
    profile.modelfile_sha256 !== modelfileSha256 ||
    !sameStringArray(runtimeFallbackModels, fallbackModels)
  ) {
    throw new Error(
      'Production summary does not prove exact Ollama profile model onboarding.',
    );
  }

  if (mode === 'reused') {
    if (job !== null || missingBefore.length !== 0) {
      throw new Error(
        'Production summary Ollama reuse evidence is inconsistent.',
      );
    }
    return {
      mode,
      profileId,
      effectiveModel,
      fallbackModels,
      requiredModels,
      installedAfter,
      job: null,
    } as const;
  }

  if (missingBefore.length === 0) {
    throw new Error(
      'Production summary Ollama install evidence has no missing profile alias.',
    );
  }
  const jobRecord = record(job, 'production Ollama onboarding job');
  const jobId = nonEmptyString(jobRecord.id, 'production Ollama onboarding job id');
  const jobModel = acceptedOllamaModel(
    jobRecord.model,
    'production Ollama onboarding job model',
  );
  const observedStatuses = stringArray(
    jobRecord.observed_statuses,
    'production Ollama onboarding observed statuses',
  );
  const observedPhases = stringArray(
    jobRecord.observed_phases,
    'production Ollama onboarding observed phases',
  );
  const jobCreatedAt = validTimestampString(
    jobRecord.created_at,
    'production Ollama onboarding job created_at',
  );
  const jobUpdatedAt = validTimestampString(
    jobRecord.updated_at,
    'production Ollama onboarding job updated_at',
  );
  if (
    !UUID_PATTERN.test(jobId) ||
    jobRecord.provider !== 'ollama' ||
    !sameOllamaModel(jobModel, effectiveModel) ||
    !['queued', 'running', 'succeeded'].includes(
      String(jobRecord.initial_status),
    ) ||
    jobRecord.final_status !== 'succeeded' ||
    observedStatuses.length < 2 ||
    observedStatuses[0] !== jobRecord.initial_status ||
    observedStatuses.at(-1) !== 'succeeded' ||
    observedStatuses.some(
      (status) => !['queued', 'running', 'succeeded'].includes(status),
    ) ||
    !monotonicOnboardingStatuses(observedStatuses) ||
    observedPhases.length !== observedStatuses.length ||
    observedPhases.some((phase) => phase.trim().length === 0) ||
    observedPhases.at(-1) !== 'completed' ||
    Date.parse(jobCreatedAt) < Date.parse(startedAt) ||
    Date.parse(jobUpdatedAt) < Date.parse(jobCreatedAt) ||
    Date.parse(jobUpdatedAt) > Date.parse(completedAt)
  ) {
    throw new Error(
      'Production summary Ollama onboarding job evidence is invalid.',
    );
  }
  if (jobRecord.commit_started_at !== null) {
    const commitStartedAt = validTimestampString(
      jobRecord.commit_started_at,
      'production Ollama onboarding job commit_started_at',
    );
    if (
      Date.parse(commitStartedAt) < Date.parse(jobCreatedAt) ||
      Date.parse(commitStartedAt) > Date.parse(jobUpdatedAt)
    ) {
      throw new Error(
        'Production summary Ollama onboarding commit timestamp is invalid.',
      );
    }
  }
  return {
    mode,
    profileId,
    effectiveModel,
    fallbackModels,
    requiredModels,
    installedAfter,
    jobId,
  } as const;
}

function monotonicOnboardingStatuses(statuses: readonly string[]): boolean {
  const ranks: Readonly<Record<string, number>> = {
    queued: 0,
    running: 1,
    succeeded: 2,
  };
  return statuses.every(
    (status, index) =>
      Object.hasOwn(ranks, status) &&
      (index === 0 || ranks[status] >= ranks[statuses[index - 1] ?? '']),
  );
}

function containsOllamaModel(models: readonly string[], expected: string): boolean {
  return models.some((model) => sameOllamaModel(model, expected));
}

function sameOllamaModel(left: string, right: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/:latest$/, '');
  return normalize(left) === normalize(right);
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length && left.every((value, index) => value === right[index])
  );
}

function processReleaseEvidence(
  summary: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  const release = record(
    summary.resources_released_at_end,
    'production process resource release',
  );
  const capturedAt = validTimestampString(
    release.captured_at,
    'production process release captured_at',
  );
  const preCloseCapturedAt = validTimestampString(
    release.pre_close_captured_at,
    'production process release pre_close_captured_at',
  );
  const preCloseStableEmptySnapshots = integerAtLeast(
    release.pre_close_stable_empty_snapshots,
    2,
    'production pre-close stable empty snapshots',
  );
  const stableEmptySnapshots = integerAtLeast(
    release.stable_empty_snapshots,
    2,
    'production stable empty snapshots',
  );
  const observedOwnedProcesses = processEvidenceArray(
    release.observed_owned_processes,
    'production observed owned processes',
  );
  const aliveOwnedProcesses = processEvidenceArray(
    release.alive_owned_processes,
    'production alive owned processes',
  );
  if (
    release.released !== true ||
    release.pre_close_release_proven !== true ||
    aliveOwnedProcesses.length !== 0 ||
    observedOwnedProcesses.some(
      (process) => process.name.toLowerCase() === 'flm.exe',
    )
  ) {
    throw new Error(
      'Production summary does not prove released Ollama process resources.',
    );
  }
  return {
    capturedAt,
    released: true,
    preCloseCapturedAt,
    preCloseReleaseProven: true,
    preCloseStableEmptySnapshots,
    stableEmptySnapshots,
    observedOwnedProcesses,
    aliveOwnedProcesses,
  } as const;
}

function modelReleaseEvidence(
  release: Record<string, unknown>,
  effectiveModel: string,
): Readonly<Record<string, unknown>> {
  const capturedAt = validTimestampString(
    release.captured_at,
    'production Ollama model release captured_at',
  );
  const releasedModel = nonEmptyString(
    release.effective_model,
    'production released Ollama model',
  );
  const loadedModels = stringArray(
    release.loaded_models,
    'production loaded Ollama models',
  );
  if (
    release.released !== true ||
    releasedModel !== effectiveModel ||
    loadedModels.includes(effectiveModel)
  ) {
    throw new Error(
      'Production summary does not prove release of the effective Ollama model.',
    );
  }
  return {
    capturedAt,
    released: true,
    effectiveModel,
    loadedModels,
  } as const;
}

function acceptedOllamaModel(value: unknown, label: string): string {
  const model = nonEmptyString(value, label);
  if (!ACCEPTED_OLLAMA_MODEL.test(model) || /fake|deterministic/i.test(model)) {
    throw new Error(`${label} is not an accepted real Ollama model.`);
  }
  return model;
}

function optionalReason(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }
  return nonEmptyString(value, label);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function validTimestampString(value: unknown, label: string): string {
  const text = nonEmptyString(value, label);
  timestamp(text, label);
  return text;
}

function integerAtLeast(value: unknown, minimum: number, label: string): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} must be at least ${minimum}.`);
  }
  return value as number;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string' && item.length > 0)
  ) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  return value;
}

function processEvidenceArray(
  value: unknown,
  label: string,
): readonly { readonly pid: number; readonly name: string }[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value.map((item) => {
    const process = record(item, label);
    if (!Number.isInteger(process.pid) || (process.pid as number) <= 0) {
      throw new Error(`${label} contains an invalid PID.`);
    }
    return {
      pid: process.pid as number,
      name: nonEmptyString(process.name, `${label} process name`),
    };
  });
}

function safeOutputFile(outputRoot: string, name: string): string {
  const path = resolve(outputRoot, name);
  requireStrictDescendant(path, outputRoot, name);
  if (
    !existsSync(path) ||
    !statSync(path).isFile() ||
    lstatSync(path).isSymbolicLink()
  ) {
    throw new Error(`Local forced-Ollama ${name} is missing or unsafe.`);
  }
  return path;
}

function artifactReference(workspaceRoot: string, path: string) {
  const payload = readFileSync(path);
  return {
    path: relative(workspaceRoot, path).replaceAll('\\', '/'),
    bytes: payload.length,
    sha256: createHash('sha256').update(payload).digest('hex'),
  } as const;
}

function readJsonObject(path: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`Local forced-Ollama ${label} is missing or invalid JSON.`);
  }
  return record(value, `local forced-Ollama ${label}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function timestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Local forced-Ollama ${label} is invalid.`);
  }
  return parsed;
}

function writeJsonAtomically(path: string, value: unknown): void {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
    });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function requireStrictDescendant(
  candidatePath: string,
  parentPath: string,
  label: string,
): void {
  const childRelative = relative(resolve(parentPath), resolve(candidatePath));
  if (
    !childRelative ||
    childRelative === '..' ||
    childRelative.startsWith(`..${sep}`) ||
    isAbsolute(childRelative)
  ) {
    throw new Error(`${label} must stay inside the acceptance output.`);
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runLocalCandidateOllamaFallbackCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
