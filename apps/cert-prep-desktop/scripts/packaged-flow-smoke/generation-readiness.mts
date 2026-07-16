import { statSync } from 'node:fs';
import { win32 } from 'node:path';

import type { APIResponse, Page, Response } from 'playwright';

import { activePage } from './runner-context.mts';
import { isRecord } from './text-utils.mts';
import type {
  GenerationReadinessSnapshot,
  LlmProviderSelectionSnapshot,
  ProjectApiRef,
  RuntimeRequirementSnapshot,
  SmokeRunState,
} from './types.mts';

const PROJECT_RESPONSE_TIMEOUT_MS = 30_000;
const READINESS_REQUEST_TIMEOUT_MS = 30_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BEARER_PATTERN = /^Bearer [A-Za-z0-9._~+/=-]+$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const PROVIDER_PREFERENCES = new Set(['auto', 'ollama', 'fake']);
const PROVIDERS = new Set(['ollama', 'fake']);
const RUNTIME_KINDS = new Set([
  'ollama',
  'ollama_model',
  'paddle_ocr',
  'windowsml_ocr',
]);

type ReadinessPage = Pick<Page, 'on' | 'off' | 'request'>;
type RestartProjectApiPage = Pick<Page, 'reload' | 'waitForResponse'>;

export interface CaptureGenerationReadinessOptions {
  readonly page?: ReadinessPage;
  readonly now?: () => Date;
  readonly projectResponseTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly installedPathVerifier?: (path: string) => boolean;
}

interface ProjectResponseListener {
  readonly promise: Promise<Response>;
  dispose(): void;
}

type EndpointName = 'provider_selection' | 'runtime_requirements';

interface EndpointResult {
  readonly payload: unknown | null;
  readonly blocker: string | null;
}

interface SanitizedRuntimeRequirements {
  readonly requirements: RuntimeRequirementSnapshot[];
}

export function unavailableGenerationReadinessSnapshot(
  blocker: string,
  now: () => Date = () => new Date(),
): GenerationReadinessSnapshot {
  return {
    captured_at: now().toISOString(),
    ready: false,
    provider_selection: null,
    runtime_requirements: [],
    blockers: [blocker],
  };
}

export async function captureGenerationReadinessAtProjectCreate(
  run: SmokeRunState,
  createProjectAction: () => Promise<void>,
  options: CaptureGenerationReadinessOptions = {},
): Promise<void> {
  const page = options.page ?? activePage(run);
  const now = options.now ?? (() => new Date());
  run.metrics.generation_readiness_at_start = {
    ...unavailableGenerationReadinessSnapshot(
      'generation_readiness_capture_pending',
      now,
    ),
  };
  run.projectApi = null;

  const listener = listenForProjectResponse(
    page,
    options.projectResponseTimeoutMs ?? PROJECT_RESPONSE_TIMEOUT_MS,
  );
  const responsePromise = listener.promise.catch(() => null);

  try {
    try {
      await createProjectAction();
    } catch (error) {
      listener.dispose();
      await responsePromise;
      run.metrics.generation_readiness_at_start = failedSnapshot(
        now().toISOString(),
        'project_create_action_failed',
      );
      throw error;
    }

    const response = await responsePromise;
    if (!response) {
      run.metrics.generation_readiness_at_start = failedSnapshot(
        now().toISOString(),
        'project_response_timeout',
      );
      return;
    }
    run.metrics.generation_readiness_at_start =
      await generationReadinessFromProjectResponse(
        run,
        page,
        response,
        now,
        options.requestTimeoutMs ?? READINESS_REQUEST_TIMEOUT_MS,
        options.installedPathVerifier ?? isExistingRegularFile,
      );
  } catch (error) {
    if (run.metrics.generation_readiness_at_start?.blockers[0] ===
      'project_create_action_failed') {
      throw error;
    }
    run.metrics.generation_readiness_at_start = failedSnapshot(
      now().toISOString(),
      'generation_readiness_capture_failed',
    );
  } finally {
    listener.dispose();
  }
}

export async function captureGenerationReadinessFromProjectApi(
  run: SmokeRunState,
  options: CaptureGenerationReadinessOptions = {},
): Promise<GenerationReadinessSnapshot> {
  const page = options.page ?? activePage(run);
  const now = options.now ?? (() => new Date());
  const projectApi = run.projectApi;
  if (!projectApi) {
    const snapshot = failedSnapshot(
      now().toISOString(),
      'project_api_reference_missing',
    );
    run.metrics.generation_readiness_at_start = snapshot;
    return snapshot;
  }
  const snapshot = await generationReadinessFromProjectApi(
    run,
    page,
    projectApi,
    now().toISOString(),
    options.requestTimeoutMs ?? READINESS_REQUEST_TIMEOUT_MS,
    options.installedPathVerifier ?? isExistingRegularFile,
  );
  run.metrics.generation_readiness_at_start = snapshot;
  return snapshot;
}

export async function captureProjectApiAfterRestart(
  page: RestartProjectApiPage,
  expectedProjectId: string,
  timeoutMs = PROJECT_RESPONSE_TIMEOUT_MS,
): Promise<ProjectApiRef> {
  if (!UUID_PATTERN.test(expectedProjectId)) {
    throw new Error('Restart project API capture requires an exact project UUID.');
  }
  const responsePromise = page.waitForResponse(
    (response) => isAuthenticatedProjectListResponse(response),
    { timeout: timeoutMs },
  );
  await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
  const response = await responsePromise;
  if (response.status() !== 200) {
    throw new Error(`Restart project list returned HTTP ${response.status()}.`);
  }
  const payload = await response.json().catch(() => null);
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new Error('Restart project list response was not valid JSON.');
  }
  const matchedProject = payload.items.find(
    (item) => isRecord(item) && item.id === expectedProjectId,
  );
  if (!matchedProject) {
    throw new Error('Restart project list did not contain the exact project.');
  }
  const projectApi = projectApiRefFromResponse(response, matchedProject);
  if (!projectApi || projectApi.projectId !== expectedProjectId) {
    throw new Error('Restart project API context was not safely captured.');
  }
  return projectApi;
}

export function projectApiRefMatchesResponse(
  projectApi: ProjectApiRef | null,
  response: Response,
): boolean {
  if (!projectApi) {
    return false;
  }
  const apiBaseUrl = canonicalLoopbackOrigin(response.url());
  const authorization = authorizationHeader(response);
  return (
    apiBaseUrl === projectApi.apiBaseUrl &&
    authorization === projectApi.authorization
  );
}

export function isProjectDocumentsCollectionResponse(
  projectApi: ProjectApiRef | null,
  response: Response,
): boolean {
  if (
    response.request().method().toUpperCase() !== 'POST' ||
    !projectApiRefMatchesResponse(projectApi, response) ||
    !projectApi
  ) {
    return false;
  }
  try {
    return (
      new URL(response.url()).pathname ===
      `/projects/${encodeURIComponent(projectApi.projectId)}/documents`
    );
  } catch {
    return false;
  }
}

function listenForProjectResponse(
  page: ReadinessPage,
  timeoutMs: number,
): ProjectResponseListener {
  let disposed = false;
  let timer: NodeJS.Timeout | null = null;
  let rejectPromise: (error: Error) => void = () => undefined;
  const onResponse = (response: Response): void => {
    if (!isProjectCollectionResponse(response)) {
      return;
    }
    cleanup();
    resolvePromise(response);
  };
  let resolvePromise: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const cleanup = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    page.off('response', onResponse);
  };

  page.on('response', onResponse);
  timer = setTimeout(() => {
    cleanup();
    rejectPromise(new Error('project response timeout'));
  }, Math.max(1, timeoutMs));

  return {
    promise,
    dispose() {
      if (disposed) {
        return;
      }
      cleanup();
      rejectPromise(new Error('project response listener disposed'));
    },
  };
}

async function generationReadinessFromProjectResponse(
  run: SmokeRunState,
  page: ReadinessPage,
  response: Response,
  now: () => Date,
  requestTimeoutMs: number,
  installedPathExists: (path: string) => boolean,
): Promise<GenerationReadinessSnapshot> {
  if (response.status() !== 201) {
    return failedSnapshot(now().toISOString(), 'project_response_http_error');
  }
  const projectJson = await readJsonWithTimeout(
    () => response.json(),
    'project_response',
    requestTimeoutMs,
  );
  if (projectJson.blocker) {
    return failedSnapshot(now().toISOString(), projectJson.blocker);
  }
  const projectApi = projectApiRefFromResponse(response, projectJson.payload);
  if (!projectApi) {
    return failedSnapshot(now().toISOString(), 'project_response_schema_invalid');
  }
  run.projectApi = projectApi;
  return generationReadinessFromProjectApi(
    run,
    page,
    projectApi,
    now().toISOString(),
    requestTimeoutMs,
    installedPathExists,
  );
}

async function generationReadinessFromProjectApi(
  run: SmokeRunState,
  page: ReadinessPage,
  projectApi: ProjectApiRef,
  capturedAt: string,
  requestTimeoutMs: number,
  installedPathExists: (path: string) => boolean,
): Promise<GenerationReadinessSnapshot> {
  const [selectionResult, requirementsResult] = await Promise.all([
    getReadinessJson(
      page,
      projectApi,
      '/llm/provider-selection',
      'provider_selection',
      requestTimeoutMs,
    ),
    getReadinessJson(
      page,
      projectApi,
      '/runtime/requirements',
      'runtime_requirements',
      requestTimeoutMs,
    ),
  ]);
  const blockers = [selectionResult.blocker, requirementsResult.blocker].filter(
    (value): value is string => value !== null,
  );
  const providerSelection = selectionResult.blocker
    ? null
    : sanitizeProviderSelection(
        selectionResult.payload,
        projectApi.authorization,
      );
  const sanitizedRequirements = requirementsResult.blocker
    ? null
    : sanitizeRuntimeRequirements(
        requirementsResult.payload,
        projectApi.authorization,
        installedPathExists,
      );
  if (!selectionResult.blocker && !providerSelection) {
    blockers.push('provider_selection_schema_invalid');
  }
  if (!requirementsResult.blocker && !sanitizedRequirements) {
    blockers.push('runtime_requirements_schema_invalid');
  }
  const requirements = sanitizedRequirements?.requirements ?? [];
  if (providerSelection && sanitizedRequirements) {
    addReadinessBlockers(
      blockers,
      providerSelection,
      requirements,
      run.options.llmProvider,
      run.options.ollamaModel,
    );
  }
  return {
    captured_at: capturedAt,
    ready: blockers.length === 0,
    provider_selection: providerSelection,
    runtime_requirements: requirements,
    blockers,
  };
}

async function getReadinessJson(
  page: ReadinessPage,
  projectApi: ProjectApiRef,
  path: string,
  endpoint: EndpointName,
  timeoutMs: number,
): Promise<EndpointResult> {
  let response: APIResponse;
  try {
    response = await page.request.get(`${projectApi.apiBaseUrl}${path}`, {
      headers: { Authorization: projectApi.authorization },
      maxRedirects: 0,
      timeout: timeoutMs,
    });
  } catch (error) {
    return {
      payload: null,
      blocker: isTimeoutError(error)
        ? `${endpoint}_timeout`
        : `${endpoint}_request_failed`,
    };
  }
  if (response.status() !== 200) {
    return { payload: null, blocker: `${endpoint}_http_error` };
  }
  return readJsonWithTimeout(() => response.json(), endpoint, timeoutMs);
}

async function readJsonWithTimeout(
  read: () => Promise<unknown>,
  endpoint: 'project_response' | EndpointName,
  timeoutMs: number,
): Promise<EndpointResult> {
  const timeout = Symbol('timeout');
  let timer: NodeJS.Timeout | null = null;
  try {
    const payload = await Promise.race([
      Promise.resolve().then(read),
      new Promise<typeof timeout>((resolve) => {
        timer = setTimeout(() => resolve(timeout), Math.max(1, timeoutMs));
      }),
    ]);
    if (payload === timeout) {
      return { payload: null, blocker: `${endpoint}_timeout` };
    }
    return { payload, blocker: null };
  } catch {
    return { payload: null, blocker: `${endpoint}_json_invalid` };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function projectApiRefFromResponse(
  response: Response,
  payload: unknown,
): ProjectApiRef | null {
  if (!isRecord(payload)) {
    return null;
  }
  const projectId = payload.id;
  const apiBaseUrl = canonicalApiBaseUrl(response.url(), '/projects');
  const authorization = authorizationHeader(response);
  if (
    typeof projectId !== 'string' ||
    !UUID_PATTERN.test(projectId) ||
    !apiBaseUrl ||
    !authorization
  ) {
    return null;
  }
  return { apiBaseUrl, authorization, projectId };
}

function isAuthenticatedProjectListResponse(response: Response): boolean {
  return (
    response.request().method().toUpperCase() === 'GET' &&
    response.status() === 200 &&
    canonicalApiBaseUrl(response.url(), '/projects') !== null &&
    authorizationHeader(response) !== null
  );
}

function canonicalApiBaseUrl(value: string, collectionPath: string): string | null {
  const origin = canonicalLoopbackOrigin(value);
  if (!origin) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (parsed.pathname !== collectionPath) {
      return null;
    }
    return origin;
  } catch {
    return null;
  }
}

function canonicalLoopbackOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    const port = Number(parsed.port);
    if (
      parsed.protocol !== 'http:' ||
      parsed.hostname !== '127.0.0.1' ||
      !parsed.port ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535 ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function authorizationHeader(response: Response): string | null {
  const headers = response.request().headers();
  const authorization = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === 'authorization',
  )?.[1];
  return typeof authorization === 'string' && BEARER_PATTERN.test(authorization)
    ? authorization
    : null;
}

function isProjectCollectionResponse(response: Response): boolean {
  return (
    response.request().method().toUpperCase() === 'POST' &&
    canonicalApiBaseUrl(response.url(), '/projects') !== null
  );
}

function sanitizeProviderSelection(
  payload: unknown,
  authorization: string,
): LlmProviderSelectionSnapshot | null {
  if (!isRecord(payload)) {
    return null;
  }
  const forbiddenValues = authorizationSensitiveValues(authorization);
  const preference = exactEnumString(payload.preference, PROVIDER_PREFERENCES);
  const selectedProvider = exactEnumString(payload.selected_provider, PROVIDERS);
  const effectiveProvider = exactEnumString(payload.effective_provider, PROVIDERS);
  const configuredModel = exactModel(payload.configured_model, forbiddenValues);
  const effectiveModel = exactModel(payload.effective_model, forbiddenValues);
  const selectionReason = boundedNonSensitiveString(
    payload.selection_reason,
    forbiddenValues,
  );
  const fallbackReason = nullableBoundedNonSensitiveString(
    payload.fallback_reason,
    forbiddenValues,
  );
  const runtimeRequirementKind = nullableRuntimeKind(
    payload.runtime_requirement_kind,
  );
  const modelRequirementKind = nullableRuntimeKind(
    payload.model_requirement_kind,
  );
  if (
    !preference ||
    !selectedProvider ||
    !effectiveProvider ||
    !configuredModel ||
    !effectiveModel ||
    !selectionReason ||
    fallbackReason === undefined ||
    runtimeRequirementKind === undefined ||
    modelRequirementKind === undefined
  ) {
    return null;
  }
  return {
    preference,
    selected_provider: selectedProvider,
    effective_provider: effectiveProvider,
    configured_model: configuredModel,
    effective_model: effectiveModel,
    selection_reason: 'provider_selection_reported',
    fallback_reason:
      fallbackReason === null ? null : 'provider_fallback_reported',
    runtime_requirement_kind: runtimeRequirementKind,
    model_requirement_kind: modelRequirementKind,
  };
}

function sanitizeRuntimeRequirements(
  payload: unknown,
  authorization: string,
  installedPathVerifier: (path: string) => boolean,
): SanitizedRuntimeRequirements | null {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    return null;
  }
  const forbiddenValues = authorizationSensitiveValues(authorization);
  const kinds = new Set<string>();
  const requirements: RuntimeRequirementSnapshot[] = [];
  for (const item of payload.items) {
    if (!isRecord(item)) {
      return null;
    }
    const kind = exactEnumString(item.kind, RUNTIME_KINDS);
    const label = boundedString(item.label);
    const detail = boundedString(item.detail);
    const unavailableReason = requiredNullableBoundedString(
      item.unavailable_reason,
    );
    const version = nullableModel(item.version, forbiddenValues);
    const bytes = nullableNonNegativeInteger(item.bytes);
    const installedPath = nullableInstalledPath(item.installed_path);
    if (
      !kind ||
      kinds.has(kind) ||
      !label ||
      !detail ||
      typeof item.available !== 'boolean' ||
      unavailableReason === undefined ||
      version === undefined ||
      bytes === undefined ||
      installedPath === undefined
    ) {
      return null;
    }
    kinds.add(kind);
    const installedPathVerified = verifyLocalInstalledPath(
      installedPath,
      installedPathVerifier,
    );
    requirements.push({
      kind,
      available: item.available,
      version,
      installed_path_verified: installedPathVerified,
    });
  }
  return { requirements };
}

function addReadinessBlockers(
  blockers: string[],
  selection: LlmProviderSelectionSnapshot,
  requirements: readonly RuntimeRequirementSnapshot[],
  expectedPreference: string,
  expectedModel: string,
): void {
  if (selection.preference !== expectedPreference) {
    blockers.push('provider_preference_mismatch');
  }
  if (selection.selected_provider !== selection.effective_provider) {
    blockers.push('provider_selection_mismatch');
  }
  if (selection.configured_model !== expectedModel) {
    blockers.push('provider_model_mismatch');
  }
  if (selection.effective_provider === 'ollama') {
    if (
      selection.runtime_requirement_kind !== 'ollama' ||
      selection.model_requirement_kind !== 'ollama_model'
    ) {
      blockers.push('provider_requirement_kind_mismatch');
    }
  } else if (
    selection.runtime_requirement_kind !== null ||
    selection.model_requirement_kind !== null
  ) {
    blockers.push('provider_requirement_kind_mismatch');
  }
  if (selection.effective_provider === 'ollama') {
    addRequirementBlockers(
      blockers,
      requirements,
      selection.runtime_requirement_kind,
      'selected_runtime',
      true,
      null,
    );
    addRequirementBlockers(
      blockers,
      requirements,
      selection.model_requirement_kind,
      'selected_model',
      false,
      selection.effective_model,
    );
  }
}

function addRequirementBlockers(
  blockers: string[],
  requirements: readonly RuntimeRequirementSnapshot[],
  kind: string | null,
  prefix: 'selected_runtime' | 'selected_model',
  requireInstalledPath: boolean,
  expectedVersion: string | null,
): void {
  const requirement = kind
    ? requirements.find((candidate) => candidate.kind === kind)
    : undefined;
  if (!requirement) {
    blockers.push(`${prefix}_requirement_missing`);
    return;
  }
  if (requirement.available !== true) {
    blockers.push(`${prefix}_requirement_unavailable`);
  }
  if (expectedVersion !== null && requirement.version !== expectedVersion) {
    blockers.push(`${prefix}_version_mismatch`);
  }
  if (requireInstalledPath && !requirement.installed_path_verified) {
    blockers.push('selected_runtime_path_unverified');
  }
}

function failedSnapshot(
  capturedAt: string,
  blocker: string,
): GenerationReadinessSnapshot {
  return {
    captured_at: capturedAt,
    ready: false,
    provider_selection: null,
    runtime_requirements: [],
    blockers: [blocker],
  };
}

function exactEnumString(value: unknown, allowed: ReadonlySet<string>): string | null {
  return typeof value === 'string' && allowed.has(value) ? value : null;
}

function exactModel(
  value: unknown,
  forbiddenValues: readonly string[] = [],
): string | null {
  return typeof value === 'string' &&
    MODEL_PATTERN.test(value) &&
    isNonSensitiveText(value, forbiddenValues)
    ? value
    : null;
}

function boundedString(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) {
    return null;
  }
  if (hasControlCharacters(value) || value !== value.trim()) {
    return null;
  }
  return value;
}

function boundedNonSensitiveString(
  value: unknown,
  forbiddenValues: readonly string[] = [],
): string | null {
  const bounded = boundedString(value);
  return bounded && isNonSensitiveText(bounded, forbiddenValues) ? bounded : null;
}

function nullableBoundedNonSensitiveString(
  value: unknown,
  forbiddenValues: readonly string[] = [],
): string | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  return boundedNonSensitiveString(value, forbiddenValues) ?? undefined;
}

function nullableModel(
  value: unknown,
  forbiddenValues: readonly string[] = [],
): string | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  return exactModel(value, forbiddenValues) ?? undefined;
}

function requiredNullableBoundedString(
  value: unknown,
): string | null | undefined {
  if (value === null) {
    return null;
  }
  return boundedString(value) ?? undefined;
}

function nullableNonNegativeInteger(
  value: unknown,
): number | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function nullableRuntimeKind(value: unknown): string | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  return exactEnumString(value, RUNTIME_KINDS) ?? undefined;
}

function nullableInstalledPath(value: unknown): string | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 1_024 ||
    hasControlCharacters(value)
  ) {
    return undefined;
  }
  return value;
}

function verifyLocalInstalledPath(
  path: string | null,
  installedPathVerifier: (path: string) => boolean,
): boolean {
  if (
    path === null ||
    !/^[A-Za-z]:[\\/](?![\\/])/.test(path) ||
    !win32.isAbsolute(path) ||
    /^\\\\[?.]\\/.test(path)
  ) {
    return false;
  }
  try {
    return installedPathVerifier(path) === true;
  } catch {
    return false;
  }
}

function isExistingRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && /timeout|timed out/i.test(error.message);
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function authorizationSensitiveValues(authorization: string): string[] {
  return [authorization, authorization.slice('Bearer '.length)];
}

function isNonSensitiveText(
  value: string,
  forbiddenValues: readonly string[] = [],
): boolean {
  return !(
    /\bBearer\s+/i.test(value) ||
    /https?:\/\//i.test(value) ||
    /(?:^|\s)[A-Za-z]:[\\/]/.test(value) ||
    /\\\\[^\\]/.test(value) ||
    forbiddenValues.some(
      (sensitive) => sensitive.length > 0 && value.includes(sensitive),
    )
  );
}
