import { setTimeout as delay } from 'node:timers/promises';

import type { APIResponse, Page, Response } from 'playwright';

import {
  closeAppAndCheckResidue,
  launchAppAndConnect,
} from './app-lifecycle.mts';
import { captureGenerationReadinessFromProjectApi } from './generation-readiness.mts';
import {
  activePage,
  bodyText,
  screenshot,
  waitText,
} from './runner-context.mts';
import { isRecord } from './text-utils.mts';
import type {
  GenerationReadinessSnapshot,
  OllamaFallbackAcceptanceEvidence,
  OllamaFallbackSelectionEvidence,
  OllamaFallbackTrigger,
  OllamaModelOnboardingEvidence,
  OllamaModelOnboardingJobEvidence,
  OllamaPhysicalInventoryEvidence,
  OllamaProfileEvidence,
  OllamaRuntimeEvidence,
  ProjectApiRef,
  SmokeRunState,
  StreamingDraftJobAttribution,
} from './types.mts';

const TERMS_VERSION = '0.9.43';
const TERMS_DECISION_PATH = '/llm/provider-selection/fastflowlm-terms-decision';
const OLLAMA_API_BASE_URL = 'http://127.0.0.1:11434';
const DECLINED_TERMS_REASON = 'FastFlowLM terms were declined.';
const UNSUPPORTED_XDNA2_REASON = 'No compatible AMD XDNA2 NPU was detected.';
const OLD_DRIVER_REASON =
  /^The AMD accelerator driver must be at least \d+(?:\.\d+)+\.$/;
const BEARER_PATTERN = /^Bearer [A-Za-z0-9._~+/=-]+$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REQUEST_TIMEOUT_MS = 30_000;
const RESTART_READINESS_REQUEST_TIMEOUT_MS = 180_000;
const RELEASE_ATTEMPTS = 15;
const RELEASE_INTERVAL_MS = 1_000;
const MODEL_DOWNLOAD_PATH = '/llm/model-downloads';
const MODEL_ONBOARDING_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MODEL_ONBOARDING_TIMEOUT_MS = 20 * 60 * 1_000;

type AcceptancePage = Pick<
  Page,
  'request' | 'reload' | 'waitForResponse' | 'on' | 'off'
>;

export interface OllamaFallbackAcceptanceDependencies {
  readonly page?: AcceptancePage;
  readonly now?: () => Date;
  readonly waitBeforeRestart?: (milliseconds: number) => Promise<unknown>;
  readonly waitForModelPoll?: (milliseconds: number) => Promise<unknown>;
  readonly monotonicNow?: () => number;
  readonly ensureModelOnboarding?: typeof ensureOllamaProfileModels;
  readonly closeAndCheck?: typeof closeAppAndCheckResidue;
  readonly launchAndConnect?: typeof launchAppAndConnect;
  readonly captureReadiness?: typeof captureGenerationReadinessFromProjectApi;
}

export async function prepareOllamaFallbackAcceptance(
  run: SmokeRunState,
  dependencies: OllamaFallbackAcceptanceDependencies = {},
): Promise<void> {
  if ((run.options.acceptanceLane ?? 'none') !== 'ollama-fallback') {
    return;
  }
  const trigger = requiredTrigger(run.options.ollamaFallbackTrigger);
  const projectApi = requiredProjectApi(run.projectApi);
  const page = dependencies.page ?? activePage(run);
  const now = dependencies.now ?? (() => new Date());
  await startPreRouteProcessObservation(run);
  const selectionBefore = await getProviderSelection(page, projectApi, now);

  const selectionAfterRoute =
    trigger === 'declined-terms'
      ? await persistTermsDecline(page, projectApi, selectionBefore, now)
      : await getProviderSelection(page, projectApi, now);
  assertOllamaFallbackRoute(trigger, selectionBefore, selectionAfterRoute);

  const modelOnboarding = await (
    dependencies.ensureModelOnboarding ?? ensureOllamaProfileModels
  )(page, projectApi, {
    timeoutMs: run.options.streamingCompleteTimeoutMs,
    now,
    monotonicNow: dependencies.monotonicNow,
    wait: dependencies.waitForModelPoll,
  });

  const previousProjectId = projectApi.projectId;
  run.metrics.restart = { attempted: true };
  run.metrics.restart.close = await (
    dependencies.closeAndCheck ?? closeAppAndCheckResidue
  )(run, 'ollama fallback persistence restart');
  await (dependencies.waitBeforeRestart ?? delay)(3_000);
  run.port += 1;
  await (dependencies.launchAndConnect ?? launchAppAndConnect)(run);
  run.projectApi = await recaptureProjectApiFromUi(
    run,
    pageForRun(run, dependencies.page),
    previousProjectId,
  );
  const restartedPage = pageForRun(run, dependencies.page);
  const selectionAfterRestart = await getProviderSelection(
    restartedPage,
    requiredProjectApi(run.projectApi),
    now,
  );
  assertPersistedOllamaSelection(
    trigger,
    selectionAfterRoute,
    selectionAfterRestart,
  );
  const readiness = await captureOllamaFallbackReadinessAfterRestart(
    run,
    restartedPage,
    dependencies.captureReadiness,
  );

  const runtime = await captureOllamaRuntimeEvidence(
    restartedPage,
    requiredProjectApi(run.projectApi),
    readiness,
  );
  assertOnboardingSurvivedRestart(modelOnboarding, runtime);
  validatePhysicalTrigger(
    trigger,
    selectionAfterRestart,
    runtime.profile.inventory,
  );
  await selectExistingProjectAfterRestart(run);
  run.metrics.restart.verified = true;

  const initialModelFallbackReason =
    runtime.profile.base_model === 'qwen3.5:2b'
      ? runtime.profile.selection_reason
      : null;
  run.metrics.provider_fallback_reason =
    selectionAfterRestart.provider_fallback_reason;
  run.metrics.model_fallback_reason = initialModelFallbackReason;
  run.metrics.ollama_fallback_acceptance = {
    schema_version: 2,
    trigger,
    trigger_mode:
      trigger === 'declined-terms'
        ? 'persisted_terms_decision'
        : 'physical_inventory_observation',
    overrides_used: false,
    fake_provider_observed: false,
    decision_endpoint:
      trigger === 'declined-terms' ? TERMS_DECISION_PATH : null,
    selection_before: selectionBefore,
    selection_after_route: selectionAfterRoute,
    selection_after_restart: selectionAfterRestart,
    provider_fallback_reason:
      selectionAfterRestart.provider_fallback_reason ?? '',
    model_fallback_reason: initialModelFallbackReason,
    model_onboarding: modelOnboarding,
    runtime,
    job_attribution: [],
    usable_question_count: 0,
    full_exam_question_count: 0,
    resource_release: null,
  };
}

export async function captureOllamaFallbackReadinessAfterRestart(
  run: SmokeRunState,
  page: AcceptancePage,
  captureReadiness: typeof captureGenerationReadinessFromProjectApi = captureGenerationReadinessFromProjectApi,
): Promise<GenerationReadinessSnapshot> {
  const readiness = await captureReadiness(run, {
    page,
    requestTimeoutMs: RESTART_READINESS_REQUEST_TIMEOUT_MS,
  });
  if (!readiness.ready || readiness.blockers.length > 0) {
    throw new Error(
      `ollama_fallback_generation_readiness_failed:${readiness.blockers.join(',')}`,
    );
  }
  return readiness;
}

interface OllamaOnboardingProfilePlan {
  readonly profileId: string;
  readonly effectiveModel: string;
  readonly baseModel: string;
  readonly modelfileSha256: string;
  readonly fallbackModels: readonly string[];
  readonly requiredModels: readonly string[];
}

type ModelDownloadStatus = 'queued' | 'running' | 'succeeded' | 'failed';

interface ModelDownloadJobSnapshot {
  readonly id: string;
  readonly provider: 'ollama';
  readonly model: string;
  readonly status: ModelDownloadStatus;
  readonly phase: string;
  readonly cancellable: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly commitStartedAt: string | null;
  readonly error: string | null;
}

type NonFailedModelDownloadJobSnapshot = ModelDownloadJobSnapshot & {
  readonly status: Exclude<ModelDownloadStatus, 'failed'>;
  readonly error: null;
};

interface EnsureOllamaProfileModelsOptions {
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  readonly monotonicNow?: () => number;
  readonly wait?: (milliseconds: number) => Promise<unknown>;
}

class ModelOnboardingTimeoutError extends Error {}

export async function ensureOllamaProfileModels(
  page: Pick<Page, 'request'>,
  projectApi: ProjectApiRef,
  options: EnsureOllamaProfileModelsOptions = {},
): Promise<OllamaModelOnboardingEvidence> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MODEL_ONBOARDING_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('ollama_model_onboarding_timeout_invalid');
  }
  const now = options.now ?? (() => new Date());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const wait = options.wait ?? delay;
  const startedAt = validDate(now(), 'ollama_model_onboarding_started_at');
  const before = await captureOllamaOnboardingState(page, projectApi, true);
  let installedModelsBefore = before.installedModels ?? [];
  let missingModels = before.profile.requiredModels.filter(
    (required) =>
      !installedModelsBefore.some((model) => sameOllamaModel(model, required)),
  );
  let runtimeStartedWithAvailableModels = false;

  let jobEvidence: OllamaModelOnboardingJobEvidence | null = null;
  if (missingModels.length > 0) {
    const initial = await startOllamaModelDownload(page, projectApi, before.profile);
    throwIfModelDownloadFailed(initial);
    const observed: NonFailedModelDownloadJobSnapshot[] = [initial];
    let current: ModelDownloadJobSnapshot = initial;
    const deadline = monotonicNow() + timeoutMs;
    try {
      if (before.installedModels === null && initial.status === 'succeeded') {
        runtimeStartedWithAvailableModels = true;
      }
      while (!runtimeStartedWithAvailableModels) {
        const remainingBeforePollMs = deadline - monotonicNow();
        if (remainingBeforePollMs <= 0) {
          throw new ModelOnboardingTimeoutError(
            'ollama_model_onboarding_timed_out',
          );
        }
        current = await getOllamaModelDownload(
          page,
          projectApi,
          before.profile,
          current,
          Math.min(REQUEST_TIMEOUT_MS, Math.max(1, remainingBeforePollMs)),
        );
        throwIfModelDownloadFailed(current);
        observed.push(current);
        if (current.status === 'succeeded') {
          break;
        }
        const remainingMs = deadline - monotonicNow();
        if (remainingMs <= 0) {
          throw new ModelOnboardingTimeoutError(
            'ollama_model_onboarding_timed_out',
          );
        }
        await wait(Math.min(MODEL_ONBOARDING_POLL_INTERVAL_MS, remainingMs));
      }
    } catch (error) {
      if (current.status !== 'succeeded' && current.cancellable) {
        await cancelModelDownloadBestEffort(page, projectApi, current.id);
      }
      throw error;
    }
    if (!runtimeStartedWithAvailableModels) {
      if (current.status !== 'succeeded') {
        throw new Error('ollama_model_onboarding_job_did_not_succeed');
      }
      jobEvidence = {
        id: current.id,
        provider: 'ollama',
        model: current.model,
        initial_status: initial.status,
        final_status: 'succeeded',
        observed_statuses: observed.map((snapshot) => snapshot.status),
        observed_phases: observed.map((snapshot) => snapshot.phase),
        created_at: current.createdAt,
        updated_at: current.updatedAt,
        commit_started_at: current.commitStartedAt,
      };
    }
  }

  const after = await captureOllamaOnboardingState(page, projectApi);
  if (after.installedModels === null) {
    throw new Error('ollama_model_onboarding_models_after_unavailable');
  }
  assertSameOnboardingProfile(before.profile, after.profile);
  assertRequiredModelsInstalled(
    after.installedModels,
    before.profile.requiredModels,
    'ollama_model_onboarding_models_after',
  );
  const completedAt = validDate(now(), 'ollama_model_onboarding_completed_at');
  if (completedAt.getTime() < startedAt.getTime()) {
    throw new Error('ollama_model_onboarding_timestamp_order_invalid');
  }
  if (runtimeStartedWithAvailableModels) {
    installedModelsBefore = after.installedModels;
    missingModels = [];
  }

  return {
    schema_version: 1,
    endpoint: MODEL_DOWNLOAD_PATH,
    mode: jobEvidence === null ? 'reused' : 'installed',
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    profile_id: before.profile.profileId,
    effective_model: before.profile.effectiveModel,
    base_model: before.profile.baseModel,
    modelfile_sha256: before.profile.modelfileSha256,
    fallback_models: [...before.profile.fallbackModels],
    required_models: [...before.profile.requiredModels],
    installed_models_before: installedModelsBefore,
    missing_models_before: missingModels,
    installed_models_after: after.installedModels,
    profile_selection_stable: true,
    job: jobEvidence,
  };
}

async function captureOllamaOnboardingState(
  page: Pick<Page, 'request'>,
  projectApi: ProjectApiRef,
  allowUnavailableTags = false,
): Promise<{
  readonly profile: OllamaOnboardingProfilePlan;
  readonly installedModels: string[] | null;
}> {
  const [profilePayload, tagsPayload] = await Promise.all([
    getJson(page, `${projectApi.apiBaseUrl}/llm/profile-selection`, {
      Authorization: projectApi.authorization,
    }),
    getOllamaTags(page, allowUnavailableTags),
  ]);
  return {
    profile: sanitizeOllamaOnboardingProfile(profilePayload),
    installedModels:
      tagsPayload === null ? null : ollamaModelNames(tagsPayload),
  };
}

async function getOllamaTags(
  page: Pick<Page, 'request'>,
  allowTransportFailure: boolean,
): Promise<unknown | null> {
  let response: APIResponse;
  try {
    response = await page.request.get(`${OLLAMA_API_BASE_URL}/api/tags`, {
      maxRedirects: 0,
      timeout: REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    if (allowTransportFailure) {
      return null;
    }
    throw error;
  }
  if (response.status() !== 200) {
    throw new Error(`ollama_fallback_evidence_http_${response.status()}`);
  }
  return response.json();
}

function sanitizeOllamaOnboardingProfile(
  payload: unknown,
): OllamaOnboardingProfilePlan {
  if (!isRecord(payload) || payload.profile_enabled !== true) {
    throw new Error('ollama_model_onboarding_profile_disabled_or_invalid');
  }
  const profileId = safeString(payload.profile_id);
  const effectiveModel = modelString(payload.effective_model);
  const baseModel = modelString(payload.base_model);
  const modelfileSha256 =
    typeof payload.modelfile_sha256 === 'string' &&
    SHA256_PATTERN.test(payload.modelfile_sha256)
      ? payload.modelfile_sha256
      : null;
  const supportStatus = exactString(payload.support_status, [
    'supported',
    'warning',
  ] as const);
  const selected = sanitizeProfileIdentity(payload.selected_profile);
  if (!Array.isArray(payload.fallback_profiles)) {
    throw new Error('ollama_model_onboarding_fallback_profiles_invalid');
  }
  const fallbacks = payload.fallback_profiles.map(sanitizeProfileIdentity);
  const fallbackModels = strictModelList(
    payload.fallback_models,
    'ollama_model_onboarding_fallback_models_invalid',
  );
  const fallbackProfileIds = fallbacks.map((profile) => profile.profileId);
  const fallbackAliases = fallbacks.map((profile) => profile.localModel);
  if (
    !profileId ||
    !effectiveModel ||
    !baseModel ||
    !modelfileSha256 ||
    !supportStatus ||
    selected.profileId !== profileId ||
    selected.localModel !== effectiveModel ||
    selected.baseModel !== baseModel ||
    selected.explicitOptInRequired ||
    !sameStringList(selected.fallbackProfileIds, fallbackProfileIds) ||
    !sameStringList(fallbackModels, fallbackAliases)
  ) {
    throw new Error('ollama_model_onboarding_profile_contract_invalid');
  }
  const requiredModels = [effectiveModel, ...fallbackModels];
  if (
    new Set(requiredModels).size !== requiredModels.length ||
    new Set([profileId, ...fallbackProfileIds]).size !==
      fallbackProfileIds.length + 1 ||
    ![selected, ...fallbacks].every(
      (profile) =>
        !profile.explicitOptInRequired &&
        qwenModelFamily(profile.baseModel) !== null &&
        qwenModelFamily(profile.localModel) !== null,
    )
  ) {
    throw new Error('ollama_model_onboarding_profile_aliases_invalid');
  }
  return {
    profileId,
    effectiveModel,
    baseModel,
    modelfileSha256,
    fallbackModels,
    requiredModels,
  };
}

function sanitizeProfileIdentity(value: unknown): {
  readonly profileId: string;
  readonly baseModel: string;
  readonly localModel: string;
  readonly explicitOptInRequired: boolean;
  readonly fallbackProfileIds: readonly string[];
} {
  if (!isRecord(value)) {
    throw new Error('ollama_model_onboarding_profile_identity_invalid');
  }
  const profileId = safeString(value.profile_id);
  const baseModel = modelString(value.base_model);
  const localModel = modelString(value.local_model);
  const fallbackProfileIds = strictSafeStringList(
    value.fallback_profile_ids,
    'ollama_model_onboarding_profile_fallback_ids_invalid',
  );
  if (
    !profileId ||
    !baseModel ||
    !localModel ||
    typeof value.explicit_opt_in_required !== 'boolean'
  ) {
    throw new Error('ollama_model_onboarding_profile_identity_invalid');
  }
  return {
    profileId,
    baseModel,
    localModel,
    explicitOptInRequired: value.explicit_opt_in_required,
    fallbackProfileIds,
  };
}

async function startOllamaModelDownload(
  page: Pick<Page, 'request'>,
  projectApi: ProjectApiRef,
  profile: OllamaOnboardingProfilePlan,
): Promise<ModelDownloadJobSnapshot> {
  const response = await page.request.post(
    `${projectApi.apiBaseUrl}${MODEL_DOWNLOAD_PATH}`,
    {
      headers: { Authorization: projectApi.authorization },
      maxRedirects: 0,
      timeout: REQUEST_TIMEOUT_MS,
    },
  );
  if (response.status() !== 202) {
    throw new Error(`ollama_model_onboarding_start_http_${response.status()}`);
  }
  return modelDownloadSnapshot(await response.json(), profile, null);
}

async function getOllamaModelDownload(
  page: Pick<Page, 'request'>,
  projectApi: ProjectApiRef,
  profile: OllamaOnboardingProfilePlan,
  previous: ModelDownloadJobSnapshot,
  requestTimeoutMs: number,
): Promise<ModelDownloadJobSnapshot> {
  const response = await page.request.get(
    `${projectApi.apiBaseUrl}${MODEL_DOWNLOAD_PATH}/${encodeURIComponent(previous.id)}`,
    {
      headers: { Authorization: projectApi.authorization },
      maxRedirects: 0,
      timeout: requestTimeoutMs,
    },
  );
  if (response.status() !== 200) {
    throw new Error(`ollama_model_onboarding_poll_http_${response.status()}`);
  }
  return modelDownloadSnapshot(await response.json(), profile, previous);
}

function modelDownloadSnapshot(
  payload: unknown,
  profile: OllamaOnboardingProfilePlan,
  previous: ModelDownloadJobSnapshot | null,
): ModelDownloadJobSnapshot {
  if (!isRecord(payload)) {
    throw new Error('ollama_model_onboarding_job_schema_invalid');
  }
  const id = safeString(payload.id);
  const model = modelString(payload.model);
  const status = exactString(payload.status, [
    'queued',
    'running',
    'succeeded',
    'failed',
  ] as const);
  const phase = safeString(payload.phase);
  const detail = safeString(payload.detail);
  const createdAt = timestampString(
    payload.created_at,
    'ollama_model_onboarding_job_created_at_invalid',
  );
  const updatedAt = timestampString(
    payload.updated_at,
    'ollama_model_onboarding_job_updated_at_invalid',
  );
  const commitStartedAt = nullableTimestampString(
    payload.commit_started_at,
    'ollama_model_onboarding_job_commit_started_at_invalid',
  );
  const completed = nullableNonNegativeInteger(payload.completed);
  const total = nullableNonNegativeInteger(payload.total);
  const error = payload.error === null ? null : safeString(payload.error);
  if (
    !id ||
    !UUID_PATTERN.test(id) ||
    payload.provider !== 'ollama' ||
    !model ||
    !sameOllamaModel(model, profile.effectiveModel) ||
    !status ||
    !phase ||
    !detail ||
    typeof payload.cancellable !== 'boolean' ||
    !Object.hasOwn(payload, 'completed') ||
    !Object.hasOwn(payload, 'total') ||
    !Object.hasOwn(payload, 'error') ||
    completed === undefined ||
    total === undefined ||
    (payload.error !== null && error === null) ||
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    (commitStartedAt !== null &&
      (Date.parse(commitStartedAt) < Date.parse(createdAt) ||
        Date.parse(commitStartedAt) > Date.parse(updatedAt))) ||
    (status === 'succeeded' &&
      (phase !== 'completed' || payload.cancellable !== false || error !== null)) ||
    (status === 'failed' &&
      (phase !== 'failed' || payload.cancellable !== false || !error)) ||
    (status !== 'succeeded' && status !== 'failed' && error !== null)
  ) {
    throw new Error('ollama_model_onboarding_job_contract_invalid');
  }
  const snapshot: ModelDownloadJobSnapshot = {
    id,
    provider: 'ollama',
    model,
    status,
    phase,
    cancellable: payload.cancellable,
    createdAt,
    updatedAt,
    commitStartedAt,
    error,
  };
  if (previous) {
    assertModelDownloadProgress(previous, snapshot);
  }
  return snapshot;
}

function assertModelDownloadProgress(
  previous: ModelDownloadJobSnapshot,
  current: ModelDownloadJobSnapshot,
): void {
  const allowedNextStatuses: Record<
    ModelDownloadStatus,
    readonly ModelDownloadStatus[]
  > = {
    queued: ['queued', 'running', 'succeeded', 'failed'],
    running: ['running', 'succeeded', 'failed'],
    succeeded: ['succeeded'],
    failed: ['failed'],
  };
  if (
    current.id !== previous.id ||
    current.provider !== previous.provider ||
    !sameOllamaModel(current.model, previous.model) ||
    current.createdAt !== previous.createdAt ||
    Date.parse(current.updatedAt) < Date.parse(previous.updatedAt) ||
    !allowedNextStatuses[previous.status].includes(current.status) ||
    (previous.commitStartedAt !== null &&
      current.commitStartedAt !== previous.commitStartedAt)
  ) {
    throw new Error('ollama_model_onboarding_job_progress_invalid');
  }
}

function throwIfModelDownloadFailed(
  current: ModelDownloadJobSnapshot,
): asserts current is NonFailedModelDownloadJobSnapshot {
  if (current.status === 'failed') {
    throw new Error(`ollama_model_onboarding_job_failed:${current.error}`);
  }
}

async function cancelModelDownloadBestEffort(
  page: Pick<Page, 'request'>,
  projectApi: ProjectApiRef,
  jobId: string,
): Promise<void> {
  try {
    await page.request.delete(
      `${projectApi.apiBaseUrl}${MODEL_DOWNLOAD_PATH}/${encodeURIComponent(jobId)}`,
      {
        headers: { Authorization: projectApi.authorization },
        maxRedirects: 0,
        timeout: REQUEST_TIMEOUT_MS,
      },
    );
  } catch {
    // Preserve the original timeout as the acceptance failure.
  }
}

function assertSameOnboardingProfile(
  before: OllamaOnboardingProfilePlan,
  after: OllamaOnboardingProfilePlan,
): void {
  if (
    before.profileId !== after.profileId ||
    before.effectiveModel !== after.effectiveModel ||
    before.baseModel !== after.baseModel ||
    before.modelfileSha256 !== after.modelfileSha256 ||
    !sameStringList(before.fallbackModels, after.fallbackModels) ||
    !sameStringList(before.requiredModels, after.requiredModels)
  ) {
    throw new Error('ollama_model_onboarding_profile_selection_drifted');
  }
}

function assertRequiredModelsInstalled(
  installed: readonly string[],
  required: readonly string[],
  error: string,
): void {
  if (
    required.length === 0 ||
    !required.every((expected) =>
      installed.some((model) => sameOllamaModel(model, expected)),
    )
  ) {
    throw new Error(error);
  }
}

function assertOnboardingSurvivedRestart(
  onboarding: OllamaModelOnboardingEvidence,
  runtime: OllamaRuntimeEvidence,
): void {
  if (
    runtime.profile.profile_id !== onboarding.profile_id ||
    runtime.profile.effective_model !== onboarding.effective_model ||
    runtime.profile.base_model !== onboarding.base_model ||
    runtime.profile.modelfile_sha256 !== onboarding.modelfile_sha256 ||
    !sameStringList(runtime.profile.fallback_models, onboarding.fallback_models)
  ) {
    throw new Error('ollama_model_onboarding_profile_drifted_after_restart');
  }
  assertRequiredModelsInstalled(
    runtime.installed_models,
    onboarding.required_models,
    'ollama_model_onboarding_aliases_missing_after_restart',
  );
}

function strictModelList(value: unknown, error: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(error);
  }
  const models = value.map(modelString);
  if (models.some((model) => model === null)) {
    throw new Error(error);
  }
  return models as string[];
}

function strictSafeStringList(value: unknown, error: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(error);
  }
  const strings = value.map(safeString);
  if (strings.some((item) => item === null)) {
    throw new Error(error);
  }
  return strings as string[];
}

function sameStringList(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length && left.every((value, index) => value === right[index])
  );
}

function validDate(value: Date, error: string): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new Error(error);
  }
  return value;
}

function timestampString(value: unknown, error: string): string {
  const text = safeString(value);
  if (!text || !Number.isFinite(Date.parse(text))) {
    throw new Error(error);
  }
  return text;
}

function nullableTimestampString(
  value: unknown,
  error: string,
): string | null {
  if (value === null) {
    return null;
  }
  return timestampString(value, error);
}

async function startPreRouteProcessObservation(
  run: SmokeRunState,
): Promise<void> {
  const tracker = run.ownedFastFlowProcesses;
  const appPid = run.app?.pid;
  if (
    !tracker ||
    !appPid ||
    !(await tracker.startObservingAppTree(appPid, run.options.exePath, null))
  ) {
    throw new Error('ollama_fallback_pre_route_process_observation_failed');
  }
}

export async function finalizeOllamaFallbackAcceptance(
  run: SmokeRunState,
  {
    page = activePage(run),
    now = () => new Date(),
    waitForRelease = delay,
  }: {
    readonly page?: Pick<Page, 'request'>;
    readonly now?: () => Date;
    readonly waitForRelease?: (milliseconds: number) => Promise<unknown>;
  } = {},
): Promise<void> {
  if ((run.options.acceptanceLane ?? 'none') !== 'ollama-fallback') {
    return;
  }
  const evidence = requiredAcceptanceEvidence(
    run.metrics.ollama_fallback_acceptance,
  );
  const finalJobSnapshot = run.metrics.streaming_questions.job_snapshots.at(-1);
  const jobs = finalJobSnapshot?.jobs ?? [];
  const producingJobs = jobs.filter(
    (job) => job.status === 'succeeded' && job.generated_count > 0,
  );
  assertRealOllamaJobs(producingJobs);

  const effectiveModel = uniqueValue(
    producingJobs.map((job) => job.effective_model),
  );
  if (!effectiveModel) {
    throw new Error('ollama_fallback_effective_model_missing');
  }
  const modelFamily = qwenModelFamily(effectiveModel);
  if (!modelFamily) {
    throw new Error('ollama_fallback_effective_model_not_allowlisted');
  }
  const jobFallbackReason = uniqueNullableValue(
    producingJobs.map((job) => job.fallback_reason),
  );
  const modelFallbackReason =
    jobFallbackReason ?? evidence.model_fallback_reason;
  if (modelFamily === 'qwen3.5:2b' && !modelFallbackReason) {
    throw new Error('ollama_fallback_low_resource_reason_missing');
  }

  const usableQuestionCount =
    run.metrics.streaming_questions.question_snapshots.at(-1)
      ?.usable_question_count ?? 0;
  const fullExamQuestionCount = run.metrics.full_exam_question_count ?? 0;
  if (usableQuestionCount < 1 || fullExamQuestionCount < 1) {
    throw new Error('ollama_fallback_usable_or_full_exam_questions_missing');
  }

  const resourceRelease = await proveOllamaModelReleased(
    page,
    effectiveModel,
    now,
    waitForRelease,
  );
  evidence.job_attribution = jobs;
  evidence.model_fallback_reason = modelFallbackReason;
  evidence.usable_question_count = usableQuestionCount;
  evidence.full_exam_question_count = fullExamQuestionCount;
  evidence.resource_release = resourceRelease;
  run.metrics.provider_fallback_reason = evidence.provider_fallback_reason;
  run.metrics.model_fallback_reason = modelFallbackReason;
}

export function assertOllamaFallbackRoute(
  trigger: OllamaFallbackTrigger,
  before: OllamaFallbackSelectionEvidence,
  after: OllamaFallbackSelectionEvidence,
): void {
  if (before.preference !== 'auto' || after.preference !== 'auto') {
    throw new Error('ollama_fallback_provider_preference_not_auto');
  }
  if (trigger === 'declined-terms') {
    if (
      before.selected_provider !== 'fastflowlm' ||
      before.effective_provider !== 'fastflowlm' ||
      before.hardware_compatible !== true ||
      before.requires_terms_acceptance !== true ||
      before.terms_accepted !== false ||
      before.terms_version !== TERMS_VERSION ||
      before.provider_fallback_reason !== null
    ) {
      throw new Error('ollama_fallback_decline_precondition_failed');
    }
  } else if (
    before.selected_provider !== 'ollama' ||
    before.effective_provider !== 'ollama' ||
    before.hardware_compatible !== false
  ) {
    throw new Error('ollama_fallback_physical_precondition_failed');
  }
  assertExpectedOllamaSelection(trigger, after);
}

export function sanitizeOllamaFallbackSelection(
  payload: unknown,
  capturedAt: string,
): OllamaFallbackSelectionEvidence | null {
  if (!isRecord(payload)) {
    return null;
  }
  const preference = exactString(payload.preference, ['auto']);
  const selectedProvider = exactString(payload.selected_provider, [
    'fastflowlm',
    'ollama',
  ]);
  const effectiveProvider = exactString(payload.effective_provider, [
    'fastflowlm',
    'ollama',
  ]);
  const configuredModel = modelString(payload.configured_model);
  const effectiveModel = modelString(payload.effective_model);
  const fallbackReason = nullableSafeString(payload.fallback_reason);
  const termsVersion = nullableModelString(payload.terms_version);
  const runtimeKind = exactString(payload.runtime_requirement_kind, [
    'fastflowlm',
    'ollama',
  ]);
  const modelKind = exactString(payload.model_requirement_kind, [
    'fastflowlm_model',
    'ollama_model',
  ]);
  if (
    !preference ||
    !selectedProvider ||
    !effectiveProvider ||
    !configuredModel ||
    !effectiveModel ||
    fallbackReason === undefined ||
    termsVersion === undefined ||
    !runtimeKind ||
    !modelKind ||
    typeof payload.hardware_compatible !== 'boolean' ||
    typeof payload.requires_terms_acceptance !== 'boolean' ||
    typeof payload.terms_accepted !== 'boolean'
  ) {
    return null;
  }
  if (
    (selectedProvider === 'ollama' &&
      (runtimeKind !== 'ollama' || modelKind !== 'ollama_model')) ||
    (selectedProvider === 'fastflowlm' &&
      (runtimeKind !== 'fastflowlm' || modelKind !== 'fastflowlm_model'))
  ) {
    return null;
  }
  return {
    captured_at: capturedAt,
    preference,
    selected_provider: selectedProvider,
    effective_provider: effectiveProvider,
    configured_model: configuredModel,
    effective_model: effectiveModel,
    provider_fallback_reason: fallbackReason,
    hardware_compatible: payload.hardware_compatible,
    requires_terms_acceptance: payload.requires_terms_acceptance,
    terms_accepted: payload.terms_accepted,
    terms_version: termsVersion,
    runtime_requirement_kind: runtimeKind,
    model_requirement_kind: modelKind,
  };
}

function assertPersistedOllamaSelection(
  trigger: OllamaFallbackTrigger,
  afterRoute: OllamaFallbackSelectionEvidence,
  afterRestart: OllamaFallbackSelectionEvidence,
): void {
  assertExpectedOllamaSelection(trigger, afterRestart);
  if (
    afterRestart.provider_fallback_reason !==
      afterRoute.provider_fallback_reason ||
    afterRestart.configured_model !== afterRoute.configured_model
  ) {
    throw new Error('ollama_fallback_selection_not_persisted');
  }
}

function assertExpectedOllamaSelection(
  trigger: OllamaFallbackTrigger,
  selection: OllamaFallbackSelectionEvidence,
): void {
  if (
    selection.selected_provider !== 'ollama' ||
    selection.effective_provider !== 'ollama' ||
    selection.configured_model !== 'qwen3.5:4b' ||
    selection.requires_terms_acceptance ||
    selection.terms_accepted ||
    selection.terms_version !== null ||
    selection.runtime_requirement_kind !== 'ollama' ||
    selection.model_requirement_kind !== 'ollama_model' ||
    !providerReasonMatchesTrigger(trigger, selection.provider_fallback_reason)
  ) {
    throw new Error('ollama_fallback_selection_contract_failed');
  }
}

function providerReasonMatchesTrigger(
  trigger: OllamaFallbackTrigger,
  reason: string | null,
): boolean {
  if (trigger === 'declined-terms') {
    return reason === DECLINED_TERMS_REASON;
  }
  if (trigger === 'unsupported-xdna2') {
    return reason === UNSUPPORTED_XDNA2_REASON;
  }
  return reason !== null && OLD_DRIVER_REASON.test(reason);
}

async function persistTermsDecline(
  page: AcceptancePage,
  projectApi: ProjectApiRef,
  before: OllamaFallbackSelectionEvidence,
  now: () => Date,
): Promise<OllamaFallbackSelectionEvidence> {
  if (before.terms_version !== TERMS_VERSION) {
    throw new Error('ollama_fallback_terms_version_not_pinned');
  }
  const response = await page.request.post(
    `${projectApi.apiBaseUrl}${TERMS_DECISION_PATH}`,
    {
      data: { decision: 'declined', terms_version: TERMS_VERSION },
      headers: { Authorization: projectApi.authorization },
      maxRedirects: 0,
      timeout: REQUEST_TIMEOUT_MS,
    },
  );
  return selectionFromResponse(response, now());
}

async function getProviderSelection(
  page: Pick<Page, 'request'>,
  projectApi: ProjectApiRef,
  now: () => Date,
): Promise<OllamaFallbackSelectionEvidence> {
  const response = await page.request.get(
    `${projectApi.apiBaseUrl}/llm/provider-selection`,
    {
      headers: { Authorization: projectApi.authorization },
      maxRedirects: 0,
      timeout: REQUEST_TIMEOUT_MS,
    },
  );
  return selectionFromResponse(response, now());
}

async function selectionFromResponse(
  response: APIResponse,
  capturedAt: Date,
): Promise<OllamaFallbackSelectionEvidence> {
  if (response.status() !== 200) {
    throw new Error(
      `ollama_fallback_provider_selection_http_${response.status()}`,
    );
  }
  const selection = sanitizeOllamaFallbackSelection(
    await response.json(),
    capturedAt.toISOString(),
  );
  if (!selection) {
    throw new Error('ollama_fallback_provider_selection_schema_invalid');
  }
  return selection;
}

async function captureOllamaRuntimeEvidence(
  page: Pick<Page, 'request'>,
  projectApi: ProjectApiRef,
  readiness: NonNullable<
    SmokeRunState['metrics']['generation_readiness_at_start']
  >,
): Promise<OllamaRuntimeEvidence> {
  const runtimeRequirement = readiness.runtime_requirements.find(
    (requirement) => requirement.kind === 'ollama',
  );
  if (
    runtimeRequirement?.available !== true ||
    runtimeRequirement.installed_path_verified !== true
  ) {
    throw new Error('ollama_fallback_runtime_requirement_unverified');
  }
  const [profilePayload, versionPayload, tagsPayload] = await Promise.all([
    getJson(page, `${projectApi.apiBaseUrl}/llm/profile-selection`, {
      Authorization: projectApi.authorization,
    }),
    getJson(page, `${OLLAMA_API_BASE_URL}/api/version`),
    getJson(page, `${OLLAMA_API_BASE_URL}/api/tags`),
  ]);
  const profile = sanitizeOllamaProfile(profilePayload);
  const apiVersion = isRecord(versionPayload)
    ? safeString(versionPayload.version)
    : null;
  const installedModels = ollamaModelNames(tagsPayload);
  if (
    !profile ||
    !profile.profile_enabled ||
    !profile.profile_id ||
    !profile.inventory ||
    !apiVersion ||
    !installedModels.some((model) =>
      sameOllamaModel(model, profile.effective_model),
    )
  ) {
    throw new Error('ollama_fallback_runtime_profile_or_model_unverified');
  }
  if (!qwenModelFamily(profile.base_model ?? profile.effective_model)) {
    throw new Error('ollama_fallback_profile_model_not_allowlisted');
  }
  return {
    requirement_version: runtimeRequirement.version,
    installed_path_verified: true,
    api_version: apiVersion,
    installed_models: installedModels,
    profile,
  };
}

function sanitizeOllamaProfile(payload: unknown): OllamaProfileEvidence | null {
  if (!isRecord(payload)) {
    return null;
  }
  const profileId = nullableSafeString(payload.profile_id);
  const supportStatus = safeString(payload.support_status);
  const selectionReason = safeString(payload.reason);
  const effectiveModel = modelString(payload.effective_model);
  const baseModel = nullableModelString(payload.base_model);
  const sha256 = nullableSha256(payload.modelfile_sha256);
  const fallbackModels = modelList(payload.fallback_models);
  const inventory = sanitizePhysicalInventory(payload.inventory);
  if (
    typeof payload.profile_enabled !== 'boolean' ||
    profileId === undefined ||
    !supportStatus ||
    !selectionReason ||
    !effectiveModel ||
    baseModel === undefined ||
    sha256 === undefined ||
    fallbackModels === null ||
    inventory === undefined
  ) {
    return null;
  }
  return {
    profile_enabled: payload.profile_enabled,
    profile_id: profileId,
    support_status: supportStatus,
    selection_reason: selectionReason,
    effective_model: effectiveModel,
    base_model: baseModel,
    modelfile_sha256: sha256,
    fallback_models: fallbackModels,
    inventory,
  };
}

function sanitizePhysicalInventory(
  value: unknown,
): OllamaPhysicalInventoryEvidence | null | undefined {
  if (value === null) {
    return null;
  }
  if (
    !isRecord(value) ||
    !isRecord(value.cpu) ||
    !isRecord(value.ram) ||
    !Array.isArray(value.accelerators) ||
    !Array.isArray(value.warnings) ||
    !Number.isSafeInteger(value.schema_version)
  ) {
    return undefined;
  }
  const platform = safeString(value.platform);
  const platformVersion = safeString(value.platform_version);
  const architecture = safeString(value.architecture);
  const cpuName = nullableSafeString(value.cpu.name);
  const totalRam = nullableNonNegativeInteger(value.ram.total_bytes);
  const availableRam = nullableNonNegativeInteger(value.ram.available_bytes);
  const warnings = safeStringList(value.warnings);
  if (
    !platform ||
    !platformVersion ||
    !architecture ||
    cpuName === undefined ||
    totalRam === undefined ||
    availableRam === undefined ||
    warnings === null
  ) {
    return undefined;
  }
  const accelerators: OllamaPhysicalInventoryEvidence['accelerators'] = [];
  for (const item of value.accelerators) {
    if (!isRecord(item)) {
      return undefined;
    }
    const kind = safeString(item.kind);
    const name = safeString(item.name);
    const vendor = nullableSafeString(item.vendor);
    const driverVersion = nullableSafeString(item.driver_version);
    const deviceId = nullableSafeString(item.device_id);
    if (
      !kind ||
      !name ||
      vendor === undefined ||
      driverVersion === undefined ||
      deviceId === undefined
    ) {
      return undefined;
    }
    accelerators.push({
      kind,
      name,
      vendor,
      driver_version: driverVersion,
      device_id: deviceId,
    });
  }
  return {
    schema_version: value.schema_version as number,
    platform,
    platform_version: platformVersion,
    architecture,
    cpu_name: cpuName,
    total_ram_bytes: totalRam,
    available_ram_bytes: availableRam,
    accelerators,
    warnings,
  };
}

export function validatePhysicalTrigger(
  trigger: OllamaFallbackTrigger,
  selection: OllamaFallbackSelectionEvidence,
  inventory: OllamaPhysicalInventoryEvidence | null,
): void {
  if (trigger === 'declined-terms') {
    return;
  }
  if (!inventory || inventory.platform.toLowerCase() !== 'windows') {
    throw new Error('ollama_fallback_physical_inventory_missing');
  }
  if (
    trigger === 'old-driver' &&
    !inventory.accelerators.some(
      (accelerator) => accelerator.driver_version !== null,
    )
  ) {
    throw new Error('ollama_fallback_physical_driver_evidence_missing');
  }
  if (
    !providerReasonMatchesTrigger(trigger, selection.provider_fallback_reason)
  ) {
    throw new Error('ollama_fallback_physical_trigger_mismatch');
  }
}

async function recaptureProjectApiFromUi(
  run: SmokeRunState,
  page: AcceptancePage,
  projectId: string,
): Promise<ProjectApiRef> {
  const responsePromise = page.waitForResponse(
    (response) => isProjectListResponse(response),
    { timeout: REQUEST_TIMEOUT_MS },
  );
  await Promise.all([
    responsePromise,
    page.reload({ waitUntil: 'domcontentloaded', timeout: REQUEST_TIMEOUT_MS }),
  ]);
  const response = await responsePromise;
  if (response.status() !== 200) {
    throw new Error('ollama_fallback_project_list_http_error');
  }
  const payload = await response.json();
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.items) ||
    !payload.items.some((item) => isRecord(item) && item.id === projectId)
  ) {
    throw new Error('ollama_fallback_project_not_persisted');
  }
  const apiBaseUrl = loopbackOrigin(response.url());
  const authorization = authorizationHeader(response);
  if (!apiBaseUrl || !authorization || !UUID_PATTERN.test(projectId)) {
    throw new Error('ollama_fallback_project_api_reference_invalid');
  }
  run.metrics.observations.push(
    'Recaptured the persisted project API reference after the Ollama fallback restart.',
  );
  return { apiBaseUrl, authorization, projectId };
}

async function selectExistingProjectAfterRestart(
  run: SmokeRunState,
): Promise<void> {
  await waitText(
    run,
    /Projects|Select or create a project|Parallel Parsing QA/i,
    90_000,
    'ollama fallback restart workspace loaded',
  );
  if (!/Source PDF|Mock Exam Items/.test(await bodyText(run))) {
    const page = activePage(run);
    const projectName = run.metrics.project_name;
    const candidates = page.locator('button.project-select-button');
    const projectButton = projectName
      ? candidates.filter({ hasText: projectName }).first()
      : candidates.first();
    if (!(await projectButton.count())) {
      throw new Error('ollama_fallback_project_button_missing_after_restart');
    }
    await projectButton.click();
    await waitText(
      run,
      /Source PDF|Mock Exam Items/i,
      30_000,
      'ollama fallback project selected after restart',
    );
  }
  await screenshot(run, 'ollama-fallback-selection-persisted-after-restart');
}

function isProjectListResponse(response: Response): boolean {
  if (response.request().method().toUpperCase() !== 'GET') {
    return false;
  }
  try {
    const url = new URL(response.url());
    return (
      url.pathname === '/projects' && loopbackOrigin(response.url()) !== null
    );
  } catch {
    return false;
  }
}

function authorizationHeader(response: Response): string | null {
  const authorization = Object.entries(response.request().headers()).find(
    ([name]) => name.toLowerCase() === 'authorization',
  )?.[1];
  return typeof authorization === 'string' && BEARER_PATTERN.test(authorization)
    ? authorization
    : null;
}

function loopbackOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65_535 &&
      !url.username &&
      !url.password
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

async function proveOllamaModelReleased(
  page: Pick<Page, 'request'>,
  effectiveModel: string,
  now: () => Date,
  waitForRelease: (milliseconds: number) => Promise<unknown>,
) {
  let loadedModels: string[] = [];
  for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt += 1) {
    loadedModels = ollamaModelNames(
      await getJson(page, `${OLLAMA_API_BASE_URL}/api/ps`),
    );
    if (!loadedModels.some((model) => sameOllamaModel(model, effectiveModel))) {
      return {
        captured_at: now().toISOString(),
        effective_model: effectiveModel,
        loaded_models: loadedModels,
        released: true,
      };
    }
    if (attempt + 1 < RELEASE_ATTEMPTS) {
      await waitForRelease(RELEASE_INTERVAL_MS);
    }
  }
  throw new Error('ollama_fallback_model_release_not_proven');
}

function assertRealOllamaJobs(
  jobs: readonly StreamingDraftJobAttribution[],
): void {
  if (
    jobs.length === 0 ||
    jobs.some(
      (job) =>
        !job.attribution_complete ||
        job.configured_provider !== 'ollama' ||
        job.effective_provider !== 'ollama' ||
        !job.configured_model ||
        !job.effective_model ||
        /fake|deterministic/i.test(
          `${job.configured_provider} ${job.effective_provider} ${job.configured_model} ${job.effective_model}`,
        ),
    )
  ) {
    throw new Error('ollama_fallback_real_job_attribution_failed');
  }
}

async function getJson(
  page: Pick<Page, 'request'>,
  url: string,
  headers?: Record<string, string>,
): Promise<unknown> {
  const response = await page.request.get(url, {
    headers,
    maxRedirects: 0,
    timeout: REQUEST_TIMEOUT_MS,
  });
  if (response.status() !== 200) {
    throw new Error(`ollama_fallback_evidence_http_${response.status()}`);
  }
  return response.json();
}

function ollamaModelNames(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    throw new Error('ollama_fallback_ollama_models_schema_invalid');
  }
  const names = payload.models.map((item) => {
    if (!isRecord(item)) {
      return null;
    }
    return modelString(item.name) ?? modelString(item.model);
  });
  if (names.some((name) => name === null)) {
    throw new Error('ollama_fallback_ollama_model_name_invalid');
  }
  return [...new Set(names as string[])].sort();
}

function sameOllamaModel(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value.toLowerCase().replace(/:latest$/, '');
  return normalize(left) === normalize(right);
}

function qwenModelFamily(model: string): 'qwen3.5:4b' | 'qwen3.5:2b' | null {
  const normalized = model.toLowerCase();
  if (/qwen3\.5(?::|-)4b(?:\b|-)/.test(normalized)) {
    return 'qwen3.5:4b';
  }
  if (/qwen3\.5(?::|-)2b(?:\b|-)/.test(normalized)) {
    return 'qwen3.5:2b';
  }
  return null;
}

function modelList(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const models = value.map(modelString);
  return models.some((model) => model === null)
    ? null
    : [...new Set(models as string[])];
}

function safeStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const strings = value.map(safeString);
  return strings.some((item) => item === null) ? null : (strings as string[]);
}

function safeString(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1_024 &&
    value === value.trim() &&
    Array.from(value).every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint >= 0x20 && codePoint !== 0x7f;
    })
    ? value
    : null;
}

function nullableSafeString(value: unknown): string | null | undefined {
  return value === null || value === undefined
    ? null
    : (safeString(value) ?? undefined);
}

function modelString(value: unknown): string | null {
  return typeof value === 'string' && MODEL_PATTERN.test(value) ? value : null;
}

function nullableModelString(value: unknown): string | null | undefined {
  return value === null || value === undefined
    ? null
    : (modelString(value) ?? undefined);
}

function nullableSha256(value: unknown): string | null | undefined {
  return value === null || value === undefined
    ? null
    : typeof value === 'string' && SHA256_PATTERN.test(value)
      ? value
      : undefined;
}

function nullableNonNegativeInteger(value: unknown): number | null | undefined {
  return value === null || value === undefined
    ? null
    : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? value
      : undefined;
}

function exactString<const T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  return typeof value === 'string' && allowed.includes(value as T)
    ? (value as T)
    : null;
}

function uniqueValue(values: readonly (string | null)[]): string | null {
  if (values.length === 0 || values.some((value) => value === null)) {
    return null;
  }
  const unique = new Set(values as string[]);
  return unique.size === 1 ? ([...unique][0] ?? null) : null;
}

function uniqueNullableValue(
  values: readonly (string | null)[],
): string | null {
  const nonNull = values.filter((value): value is string => value !== null);
  if (nonNull.length === 0) {
    return null;
  }
  const unique = new Set(nonNull);
  if (unique.size !== 1 || nonNull.length !== values.length) {
    throw new Error('ollama_fallback_model_reason_inconsistent');
  }
  return nonNull[0] ?? null;
}

function requiredProjectApi(value: ProjectApiRef | null): ProjectApiRef {
  if (!value) {
    throw new Error('ollama_fallback_project_api_reference_missing');
  }
  return value;
}

function requiredTrigger(
  value: OllamaFallbackTrigger | undefined,
): OllamaFallbackTrigger {
  if (!value) {
    throw new Error('ollama_fallback_trigger_missing');
  }
  return value;
}

function requiredAcceptanceEvidence(
  value: OllamaFallbackAcceptanceEvidence | undefined,
): OllamaFallbackAcceptanceEvidence {
  if (!value) {
    throw new Error('ollama_fallback_acceptance_evidence_missing');
  }
  return value;
}

function pageForRun(
  run: SmokeRunState,
  injected: AcceptancePage | undefined,
): AcceptancePage {
  return injected ?? activePage(run);
}
