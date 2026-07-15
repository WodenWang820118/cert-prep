export const RESILIENCE_EVIDENCE_SCHEMA_VERSION = 2 as const;

export const RESILIENCE_CHECKS = [
  'upload',
  'ocr',
  'draft',
  'runtime',
  'model',
  'cancelVsCompleteRace',
  'crashRecovery',
  'partialDataRemoved',
  'ownedProcessesReleased',
] as const;

export type ResilienceCheck = (typeof RESILIENCE_CHECKS)[number];

export interface CandidateBinding {
  readonly candidateId: string;
  readonly version: string;
  readonly tag: string;
  readonly commitSha: string;
  readonly harnessSha256: string;
}

export interface InstallationBinding {
  readonly receiptSha256: string;
  readonly packageKind: 'msi' | 'nsis';
  readonly installerRelativePath: string;
  readonly installerSha256: string;
  readonly installedExeName: string;
  readonly installedExeBytes: number;
  readonly installedExeSha256: string;
  readonly installedAt: string;
}

export interface EvidenceObservation {
  readonly at: string;
  readonly event: string;
  readonly projectId?: string;
  readonly documentId?: string | null;
  readonly operationId?: string;
  readonly sessionId?: string;
  readonly status?: string;
  readonly phase?: string;
  readonly cancellable?: boolean;
  readonly httpStatus?: number;
}

export interface ResilienceEvidence {
  readonly schemaVersion: typeof RESILIENCE_EVIDENCE_SCHEMA_VERSION;
  readonly check: ResilienceCheck;
  readonly passed: true;
  readonly candidate: CandidateBinding;
  readonly acceptanceRunId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly observations: readonly EvidenceObservation[];
  readonly proof: Readonly<Record<string, unknown>>;
}

export interface SessionRestartEvidence {
  readonly schemaVersion: typeof RESILIENCE_EVIDENCE_SCHEMA_VERSION;
  readonly check: 'sessionRestart';
  readonly passed: true;
  readonly candidate: CandidateBinding;
  readonly acceptanceRunId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly observations: readonly EvidenceObservation[];
  readonly proof: Readonly<Record<string, unknown>>;
}

export interface EvidenceValidationContext {
  readonly candidate?: CandidateBinding;
  readonly acceptanceRunId?: string;
  readonly acceptanceStartedAt?: string;
  readonly acceptanceCompletedAt?: string;
}

interface OperationSnapshot {
  readonly id: string;
  readonly status: string;
  readonly phase: string;
  readonly cancellable: boolean;
  readonly projectId?: string;
  readonly documentId?: string | null;
  readonly kind?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly commitStartedAt?: string | null;
}

interface EvidenceWindow {
  readonly startedAt: number;
  readonly completedAt: number;
}

interface ValidatedEnvelope extends EvidenceWindow {
  readonly detail: Record<string, unknown>;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+-alpha\.\d+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const WINDOWSML_RUNTIME_KIND = 'windowsml_ocr';
const WINDOWSML_RUNTIME_PROVIDER = 'windowsml';
const WINDOWSML_RUNTIME_MODEL = 'pp-ocrv6-medium-windowsml';
const OLLAMA_PROVIDER = 'ollama';
const OLLAMA_MODEL = 'qwen3.5:4b';

export function validateResilienceEvidence(
  value: unknown,
  expectedCheck: ResilienceCheck,
  context: EvidenceValidationContext = {},
): ResilienceEvidence {
  const envelope = validateEnvelope(value, expectedCheck, context);
  validateCheckProof(expectedCheck, envelope.detail.proof, envelope);
  const { detail } = envelope;
  return detail as unknown as ResilienceEvidence;
}

export function validateSessionRestartEvidence(
  value: unknown,
  context: EvidenceValidationContext = {},
): SessionRestartEvidence {
  const { detail } = validateEnvelope(value, 'sessionRestart', context);
  validateSessionRestartProof(detail.proof);
  return detail as unknown as SessionRestartEvidence;
}

function validateEnvelope(
  value: unknown,
  expectedCheck: ResilienceCheck | 'sessionRestart',
  context: EvidenceValidationContext,
): ValidatedEnvelope {
  const detail = record(value, `${expectedCheck} evidence`);
  if (
    detail.schemaVersion !== RESILIENCE_EVIDENCE_SCHEMA_VERSION ||
    detail.check !== expectedCheck ||
    detail.passed !== true
  ) {
    fail(expectedCheck, 'envelope must be schema v2, exact-check, and passed=true');
  }
  const candidate = validateCandidate(detail.candidate, expectedCheck);
  validateCandidateContext(candidate, context.candidate, expectedCheck);
  const acceptanceRunId = nonEmptyString(
    detail.acceptanceRunId,
    expectedCheck,
    'acceptanceRunId',
  );
  if (!RUN_ID_PATTERN.test(acceptanceRunId)) {
    fail(expectedCheck, 'acceptanceRunId is invalid');
  }
  if (
    context.acceptanceRunId !== undefined &&
    acceptanceRunId !== context.acceptanceRunId
  ) {
    fail(expectedCheck, 'acceptanceRunId is not bound to the hardware run');
  }

  const startedAt = timestamp(detail.startedAt, expectedCheck, 'startedAt');
  const completedAt = timestamp(detail.completedAt, expectedCheck, 'completedAt');
  if (startedAt >= completedAt) {
    fail(expectedCheck, 'startedAt must be before completedAt');
  }
  validateWithinAcceptanceWindow(
    startedAt,
    completedAt,
    context,
    expectedCheck,
  );
  validateObservations(
    detail.observations,
    startedAt,
    completedAt,
    expectedCheck,
  );
  const proof = record(detail.proof, `${expectedCheck} proof`);
  const installation = validateInstallationBinding(
    proof.installationBinding,
    expectedCheck,
  );
  if (Date.parse(installation.installedAt) > startedAt) {
    fail(expectedCheck, 'installationBinding.installedAt must not be after evidence startedAt');
  }
  return { detail, startedAt, completedAt };
}

function validateInstallationBinding(
  raw: unknown,
  check: string,
): InstallationBinding {
  const binding = record(raw, `${check} installationBinding`);
  const receiptSha256 = sha256Field(
    binding.receiptSha256,
    check,
    'installationBinding.receiptSha256',
  );
  if (binding.packageKind !== 'msi' && binding.packageKind !== 'nsis') {
    fail(check, 'installationBinding.packageKind must be msi or nsis');
  }
  const installerRelativePath = safeRelativePath(
    binding.installerRelativePath,
    check,
    'installationBinding.installerRelativePath',
  );
  const installerSha256 = sha256Field(
    binding.installerSha256,
    check,
    'installationBinding.installerSha256',
  );
  const installedExeName = nonEmptyString(
    binding.installedExeName,
    check,
    'installationBinding.installedExeName',
  );
  if (
    !installedExeName.toLowerCase().endsWith('.exe') ||
    installedExeName.includes('/') ||
    installedExeName.includes('\\')
  ) {
    fail(check, 'installationBinding.installedExeName must be an executable file name');
  }
  const installedExeBytes = positiveInteger(binding.installedExeBytes);
  const installedExeSha256 = sha256Field(
    binding.installedExeSha256,
    check,
    'installationBinding.installedExeSha256',
  );
  const installedAt = timestampText(
    binding.installedAt,
    check,
    'installationBinding.installedAt',
  );
  return {
    receiptSha256,
    packageKind: binding.packageKind,
    installerRelativePath,
    installerSha256,
    installedExeName,
    installedExeBytes,
    installedExeSha256,
    installedAt,
  };
}

function validateCandidate(
  value: unknown,
  check: string,
): CandidateBinding {
  const candidate = record(value, `${check} candidate`);
  const candidateId = nonEmptyString(candidate.candidateId, check, 'candidateId');
  const version = nonEmptyString(candidate.version, check, 'version');
  const tag = nonEmptyString(candidate.tag, check, 'tag');
  const commitSha = nonEmptyString(candidate.commitSha, check, 'commitSha');
  const harnessSha256 = nonEmptyString(
    candidate.harnessSha256,
    check,
    'harnessSha256',
  );
  const publicTag = `cert-prep-v${version}`;
  const localTag = `cert-prep-local-v${version}-${commitSha.slice(0, 12)}`;
  if (
    !SHA256_PATTERN.test(candidateId) ||
    !VERSION_PATTERN.test(version) ||
    !COMMIT_SHA_PATTERN.test(commitSha) ||
    (tag !== publicTag && tag !== localTag) ||
    !SHA256_PATTERN.test(harnessSha256)
  ) {
    fail(check, 'candidate identity is malformed');
  }
  return { candidateId, version, tag, commitSha, harnessSha256 };
}

function validateCandidateContext(
  actual: CandidateBinding,
  expected: CandidateBinding | undefined,
  check: string,
): void {
  if (!expected) {
    return;
  }
  for (const key of [
    'candidateId',
    'version',
    'tag',
    'commitSha',
    'harnessSha256',
  ] as const) {
    if (actual[key].toLowerCase() !== expected[key].toLowerCase()) {
      fail(check, `candidate ${key} does not match the hardware result`);
    }
  }
}

function validateWithinAcceptanceWindow(
  startedAt: number,
  completedAt: number,
  context: EvidenceValidationContext,
  check: string,
): void {
  if (
    context.acceptanceStartedAt === undefined ||
    context.acceptanceCompletedAt === undefined
  ) {
    return;
  }
  const acceptanceStartedAt = timestamp(
    context.acceptanceStartedAt,
    check,
    'acceptanceStartedAt',
  );
  const acceptanceCompletedAt = timestamp(
    context.acceptanceCompletedAt,
    check,
    'acceptanceCompletedAt',
  );
  if (startedAt < acceptanceStartedAt || completedAt > acceptanceCompletedAt) {
    fail(check, 'evidence timestamps are outside the completed acceptance run');
  }
}

function validateObservations(
  value: unknown,
  startedAt: number,
  completedAt: number,
  check: string,
): void {
  if (!Array.isArray(value) || value.length === 0) {
    fail(check, 'observations must be a non-empty array');
  }
  let previous = startedAt;
  for (const [index, raw] of value.entries()) {
    const observation = record(raw, `${check} observation ${index}`);
    const at = timestamp(observation.at, check, `observations[${index}].at`);
    nonEmptyString(observation.event, check, `observations[${index}].event`);
    if (at < startedAt || at > completedAt || at < previous) {
      fail(check, 'observations must be ordered inside the evidence window');
    }
    previous = at;
  }
}

function validateCheckProof(
  check: ResilienceCheck,
  rawProof: unknown,
  window: EvidenceWindow,
): void {
  const proof = record(rawProof, `${check} proof`);
  switch (check) {
    case 'upload':
      validateUploadProof(proof);
      return;
    case 'ocr':
      validateOcrProof(proof);
      return;
    case 'draft':
      validateScopedCancellationProof(proof, check, window);
      return;
    case 'runtime':
    case 'model':
      validateScopedCancellationProof(proof, check, window);
      return;
    case 'cancelVsCompleteRace':
      validateRaceProof(proof);
      return;
    case 'crashRecovery':
      validateCrashRecoveryProof(proof);
      return;
    case 'partialDataRemoved':
      validatePartialDataProof(proof);
      return;
    case 'ownedProcessesReleased':
      validateOwnedProcessesProof(proof);
      return;
  }
}

function validateUploadProof(proof: Record<string, unknown>): void {
  const projectId = scopedId(proof.projectId, 'upload', 'projectId');
  const operationId = operationIdField(proof.operationId, 'upload', 'operationId');
  const cancel = operationSnapshot(proof.cancelResponse, 'upload', {
    projectId,
    operationId,
    documentId: null,
    statuses: ['cancel_requested', 'canceled'],
  });
  const terminal = operationSnapshot(proof.terminalResponse, 'upload', {
    projectId,
    operationId,
    documentId: null,
    statuses: ['canceled'],
  });
  if (
    cancel.cancellable !== false ||
    terminal.cancellable !== false ||
    proof.documentCreated !== false ||
    proof.uploadResponseObserved !== false
  ) {
    fail('upload', 'pre-document-ID cancellation was not proved');
  }
}

function validateOcrProof(proof: Record<string, unknown>): void {
  const projectId = scopedId(proof.projectId, 'ocr', 'projectId');
  const documentId = scopedId(proof.documentId, 'ocr', 'documentId');
  const initialOperationId = operationIdField(
    proof.initialOperationId,
    'ocr',
    'initialOperationId',
  );
  const retryOperationId = operationIdField(
    proof.retryOperationId,
    'ocr',
    'retryOperationId',
  );
  if (initialOperationId === retryOperationId) {
    fail('ocr', 'retry operation id must be distinct');
  }
  const cancel = operationSnapshot(proof.cancelResponse, 'ocr', {
    projectId,
    documentId,
    operationId: initialOperationId,
    statuses: ['cancel_requested', 'canceled'],
  });
  const terminal = operationSnapshot(proof.canceledResponse, 'ocr', {
    projectId,
    documentId,
    operationId: initialOperationId,
    statuses: ['canceled'],
  });
  operationSnapshot(proof.retryResponse, 'ocr', {
    projectId,
    documentId,
    operationId: retryOperationId,
    statuses: ['queued', 'running', 'succeeded'],
  });
  operationSnapshot(proof.retryTerminalResponse, 'ocr', {
    projectId,
    documentId,
    operationId: retryOperationId,
    statuses: ['succeeded'],
  });
  const readyDocument = record(proof.readyDocumentResponse, 'ocr ready document');
  if (
    cancel.cancellable !== false ||
    terminal.cancellable !== false ||
    readyDocument.project_id !== projectId ||
    readyDocument.id !== documentId ||
    readyDocument.status !== 'ready' ||
    proof.sameDocumentRetry !== true ||
    proof.latePublishSuppressed !== true ||
    positiveInteger(proof.latePublishObservationWindowMs) < 1_000
  ) {
    fail('ocr', 'cancel-to-retry terminal sequence is incomplete');
  }
}

function validateScopedCancellationProof(
  proof: Record<string, unknown>,
  check: 'draft' | 'runtime' | 'model',
  window: EvidenceWindow,
): void {
  const projectId = check === 'draft'
    ? scopedId(proof.projectId, check, 'projectId')
    : undefined;
  const documentId = check === 'draft'
    ? scopedId(proof.documentId, check, 'documentId')
    : undefined;
  const kind = check === 'runtime'
    ? exactString(proof.kind, WINDOWSML_RUNTIME_KIND, check, 'kind')
    : undefined;
  const provider = check === 'runtime'
    ? exactString(proof.provider, WINDOWSML_RUNTIME_PROVIDER, check, 'provider')
    : check === 'draft' || check === 'model'
      ? exactString(proof.provider, OLLAMA_PROVIDER, check, 'provider')
      : undefined;
  const model = check === 'runtime'
    ? exactString(proof.model, WINDOWSML_RUNTIME_MODEL, check, 'model')
    : check === 'draft' || check === 'model'
      ? exactString(proof.model, OLLAMA_MODEL, check, 'model')
      : undefined;
  const expectedScope = { projectId, documentId, kind, provider, model };
  const operationId = operationIdField(proof.operationId, check, 'operationId');
  const cancel = operationSnapshot(proof.cancelResponse, check, {
    ...expectedScope,
    operationId,
    statuses: ['cancel_requested', 'canceled'],
  });
  const terminal = operationSnapshot(proof.terminalResponse, check, {
    ...expectedScope,
    operationId,
    statuses: ['canceled'],
  });
  const nonCancellable = record(
    proof.nonCancellableResponse,
    `${check} non-cancellable response`,
  );
  const commitOperationId = operationIdField(
    nonCancellable.operationId,
    check,
    'nonCancellableResponse.operationId',
  );
  const commitStartedAtText = nonEmptyString(
    nonCancellable.commitStartedAt,
    check,
    'nonCancellableResponse.commitStartedAt',
  );
  const commitStartedAt = timestamp(
    commitStartedAtText,
    check,
    'nonCancellableResponse.commitStartedAt',
  );
  const observed = operationSnapshot(
    nonCancellable.observedResponse,
    check,
    {
      ...expectedScope,
      operationId: commitOperationId,
      statuses: ['running', 'succeeded'],
    },
  );
  const rejection = record(
    nonCancellable.rejectionResponse,
    `${check} rejection response`,
  );
  const rejectionBody = record(
    rejection.body,
    `${check} rejection response body`,
  );
  const rejectionDetail =
    typeof rejectionBody.detail === 'object' &&
    rejectionBody.detail !== null &&
    !Array.isArray(rejectionBody.detail)
      ? record(rejectionBody.detail, `${check} rejection detail`)
      : rejectionBody;
  if (
    cancel.cancellable !== false ||
    terminal.cancellable !== false ||
    commitOperationId === operationId ||
    commitStartedAt < window.startedAt ||
    commitStartedAt > window.completedAt ||
    observed.commitStartedAt !== commitStartedAtText ||
    !['committing', 'completed'].includes(observed.phase) ||
    observed.cancellable !== false ||
    rejection.status !== 409 ||
    (rejectionDetail.code ?? rejectionBody.code) !== 'operation_not_cancellable'
  ) {
    fail(check, 'cancel or non-cancellable commit evidence is incomplete');
  }
  validateScenarioTransition(proof, check);
}

function validateScenarioTransition(
  proof: Record<string, unknown>,
  check: 'draft' | 'runtime' | 'model',
): void {
  const canceledState = record(proof.canceledState, `${check} canceledState`);
  if (positiveInteger(canceledState.observationWindowMs) < 1_000) {
    fail(check, 'canceledState.observationWindowMs must be at least 1000');
  }
  const immediate = record(
    canceledState.immediate,
    `${check} canceledState.immediate`,
  );
  const afterWindow = record(
    canceledState.afterWindow,
    `${check} canceledState.afterWindow`,
  );
  switch (check) {
    case 'draft':
      validateDraftTransition(proof, immediate, afterWindow);
      return;
    case 'runtime':
      validateRuntimeTransition(proof, immediate, afterWindow);
      return;
    case 'model':
      validateModelTransition(proof, immediate, afterWindow);
      return;
  }
}

function validateDraftTransition(
  proof: Record<string, unknown>,
  immediate: Record<string, unknown>,
  afterWindow: Record<string, unknown>,
): void {
  const uploadTriggeredJobs = record(
    proof.uploadTriggeredJobs,
    'draft uploadTriggeredJobs',
  );
  const jobCount = positiveInteger(uploadTriggeredJobs.jobCount);
  const statuses = stringArray(uploadTriggeredJobs.statuses);
  if (
    statuses.length !== jobCount ||
    !statuses.every((status) => status === 'skipped_missing_model') ||
    nonNegativeInteger(uploadTriggeredJobs.usableDraftCount) !== 0 ||
    nonNegativeInteger(proof.usableDraftCountBeforeManual) !== 0 ||
    nonNegativeInteger(immediate.usableDraftCount) !== 0 ||
    nonNegativeInteger(afterWindow.usableDraftCount) !== 0 ||
    positiveInteger(proof.usableDraftCountAfterManual) < 2
  ) {
    fail('draft', 'draft cancellation and manual publish transition is incomplete');
  }
}

function validateRuntimeTransition(
  proof: Record<string, unknown>,
  immediate: Record<string, unknown>,
  afterWindow: Record<string, unknown>,
): void {
  validateUnavailableRuntimeRequirement(proof.requirementBefore, 'requirementBefore');
  validateUnavailableRuntimeRequirement(immediate, 'canceledState.immediate');
  validateUnavailableRuntimeRequirement(afterWindow, 'canceledState.afterWindow');
  const requirementAfter = record(
    proof.requirementAfter,
    'runtime requirementAfter',
  );
  if (
    requirementAfter.kind !== WINDOWSML_RUNTIME_KIND ||
    requirementAfter.available !== true
  ) {
    fail('runtime', 'runtime installation transition is incomplete');
  }
  safeRelativePath(
    requirementAfter.installedPathRelative,
    'runtime',
    'requirementAfter.installedPathRelative',
  );
}

function validateUnavailableRuntimeRequirement(
  raw: unknown,
  field: string,
): void {
  const requirement = record(raw, `runtime ${field}`);
  if (
    requirement.kind !== WINDOWSML_RUNTIME_KIND ||
    requirement.available !== false
  ) {
    fail('runtime', `${field} must be an unavailable WindowsML OCR requirement`);
  }
  nonEmptyString(
    requirement.unavailableReason,
    'runtime',
    `${field}.unavailableReason`,
  );
}

function validateModelTransition(
  proof: Record<string, unknown>,
  immediate: Record<string, unknown>,
  afterWindow: Record<string, unknown>,
): void {
  validateOllamaTags(proof.tagsBefore, false, 'tagsBefore');
  validateOllamaHealth(proof.healthBefore, false, 'healthBefore');
  validateOllamaCanceledSnapshot(immediate, 'canceledState.immediate');
  validateOllamaCanceledSnapshot(afterWindow, 'canceledState.afterWindow');
  validateOllamaTags(proof.tagsAfter, true, 'tagsAfter');
  validateOllamaHealth(proof.healthAfter, true, 'healthAfter');
}

function validateOllamaCanceledSnapshot(
  snapshot: Record<string, unknown>,
  field: string,
): void {
  validateOllamaTags(snapshot.tags, false, `${field}.tags`);
  validateOllamaHealth(snapshot.health, false, `${field}.health`);
}

function validateOllamaTags(
  raw: unknown,
  installed: boolean,
  field: string,
): void {
  const tags = record(raw, `model ${field}`);
  const modelNames = stringArray(tags.modelNames);
  if (
    (!installed && modelNames.length !== 0) ||
    (installed &&
      (modelNames.length !== 1 || modelNames[0] !== OLLAMA_MODEL))
  ) {
    fail('model', `${field} does not prove the exact isolated Ollama model set`);
  }
}

function validateOllamaHealth(
  raw: unknown,
  available: boolean,
  field: string,
): void {
  const health = record(raw, `model ${field}`);
  if (
    health.provider !== OLLAMA_PROVIDER ||
    health.model !== OLLAMA_MODEL ||
    health.available !== available ||
    (available
      ? health.unavailableReason !== null || health.effectiveModel !== OLLAMA_MODEL
      : health.unavailableReason !== 'model_missing' || health.effectiveModel !== null)
  ) {
    fail('model', `${field} does not prove the exact Ollama health state`);
  }
}

function validateRaceProof(proof: Record<string, unknown>): void {
  const operationId = operationIdField(
    proof.operationId,
    'cancelVsCompleteRace',
    'operationId',
  );
  const winner = proof.winner;
  if (winner !== 'canceled' && winner !== 'completed') {
    fail('cancelVsCompleteRace', 'winner must be canceled or completed');
  }
  const terminal = operationSnapshot(
    proof.terminalResponse,
    'cancelVsCompleteRace',
    {
      operationId,
      statuses: [winner],
    },
  );
  if (
    terminal.cancellable !== false ||
    (proof.cancelHttpStatus !== 202 && proof.cancelHttpStatus !== 409) ||
    proof.terminalStateStable !== true ||
    !Array.isArray(proof.lateTerminalStatuses) ||
    proof.lateTerminalStatuses.length < 2 ||
    !proof.lateTerminalStatuses.every((value) => value === winner)
  ) {
    fail('cancelVsCompleteRace', 'race winner was not stable');
  }
}

function validateCrashRecoveryProof(proof: Record<string, unknown>): void {
  const operationId = operationIdField(
    proof.operationId,
    'crashRecovery',
    'operationId',
  );
  const before = operationSnapshot(proof.beforeCrashResponse, 'crashRecovery', {
    operationId,
    statuses: ['running', 'cancel_requested'],
  });
  const after = operationSnapshot(proof.afterRestartResponse, 'crashRecovery', {
    operationId,
    statuses: ['cancel_requested', 'canceled'],
  });
  const terminal = operationSnapshot(proof.terminalResponse, 'crashRecovery', {
    operationId,
    statuses: ['canceled'],
  });
  if (
    before.status === 'running' && after.status === 'running' ||
    terminal.cancellable !== false ||
    proof.sameOperationId !== true ||
    positiveInteger(proof.restartCount) < 1
  ) {
    fail('crashRecovery', 'persisted recovery did not reach canceled');
  }
}

function validatePartialDataProof(proof: Record<string, unknown>): void {
  scopedId(proof.projectId, 'partialDataRemoved', 'projectId');
  scopedId(proof.documentId, 'partialDataRemoved', 'documentId');
  operationIdField(proof.operationId, 'partialDataRemoved', 'operationId');
  const before = record(proof.beforeCancel, 'partialDataRemoved beforeCancel');
  const after = record(proof.afterCanceled, 'partialDataRemoved afterCanceled');
  if (
    nonNegativeInteger(before.chunksCount) < 1 ||
    nonNegativeInteger(before.nonZeroDerivedMetricCount) < 1 ||
    nonNegativeInteger(after.chunksCount) !== 0 ||
    nonNegativeInteger(after.chunksEndpointItems) !== 0 ||
    after.hasText !== false ||
    !allZeroDocumentMetrics(after) ||
    proof.originalPdfRetryable !== true ||
    proof.latePublishSuppressed !== true ||
    positiveInteger(proof.latePublishObservationWindowMs) < 1_000
  ) {
    fail('partialDataRemoved', 'partial data cleanup or late-publish suppression failed');
  }
}

function validateOwnedProcessesProof(proof: Record<string, unknown>): void {
  positiveInteger(proof.appPid);
  if (
    !Array.isArray(proof.observedOwnedPids) ||
    proof.observedOwnedPids.length === 0 ||
    !proof.observedOwnedPids.every((value) => positiveInteger(value) > 0) ||
    !Array.isArray(proof.finalOwnedPids) ||
    proof.finalOwnedPids.length !== 0 ||
    positiveInteger(proof.stableEmptySnapshots) < 2 ||
    nonNegativeInteger(proof.residueCount) !== 0 ||
    !Number.isFinite(Date.parse(String(proof.closedAt ?? '')))
  ) {
    fail('ownedProcessesReleased', 'owned process closeout is incomplete');
  }
}

function validateSessionRestartProof(proof: unknown): void {
  const value = record(proof, 'sessionRestart proof');
  const projectId = scopedId(value.projectId, 'sessionRestart', 'projectId');
  const sessionId = scopedId(value.sessionId, 'sessionRestart', 'sessionId');
  if (positiveInteger(value.answeredBeforeFirstRestart) !== 1) {
    fail('sessionRestart', 'exactly one answer must precede the first restart');
  }
  const first = record(value.firstRestart, 'sessionRestart firstRestart');
  const activeSessionIds = stringArray(first.activeSessionIds);
  if (
    first.projectId !== projectId ||
    first.explicitAction !== 'resume' ||
    first.resumedSessionId !== sessionId ||
    !activeSessionIds.includes(sessionId) ||
    positiveInteger(first.restoredAttemptCount) !== 1
  ) {
    fail('sessionRestart', 'first restart and explicit Resume were not proved');
  }
  const completion = record(value.completion, 'sessionRestart completion');
  const questionCount = positiveInteger(completion.questionCount);
  if (
    completion.sessionId !== sessionId ||
    completion.status !== 'completed' ||
    positiveInteger(completion.attemptCount) < questionCount
  ) {
    fail('sessionRestart', 'session completion was not proved');
  }
  const second = record(value.secondRestart, 'sessionRestart secondRestart');
  if (
    second.sessionId !== sessionId ||
    second.completedSessionStatus !== 'completed' ||
    stringArray(second.activeSessionIds).length !== 0
  ) {
    fail('sessionRestart', 'second restart still exposed a resumable session');
  }
}

function operationSnapshot(
  raw: unknown,
  check: string,
  expected: {
    readonly operationId: string;
    readonly statuses: readonly string[];
    readonly projectId?: string;
    readonly documentId?: string | null;
    readonly kind?: string;
    readonly provider?: string;
    readonly model?: string;
  },
): OperationSnapshot {
  const value = record(raw, `${check} operation response`);
  const snapshot: OperationSnapshot = {
    id: operationIdField(value.id, check, 'response.id'),
    status: nonEmptyString(value.status, check, 'response.status'),
    phase: nonEmptyString(value.phase, check, 'response.phase'),
    cancellable: booleanField(value.cancellable, check, 'response.cancellable'),
    ...(value.project_id !== undefined
      ? { projectId: nonEmptyString(value.project_id, check, 'response.project_id') }
      : {}),
    ...(value.document_id === null
      ? { documentId: null }
      : value.document_id !== undefined
        ? {
            documentId: nonEmptyString(
              value.document_id,
              check,
              'response.document_id',
            ),
          }
        : {}),
    ...(value.kind !== undefined
      ? { kind: nonEmptyString(value.kind, check, 'response.kind') }
      : {}),
    ...(value.provider !== undefined
      ? { provider: nonEmptyString(value.provider, check, 'response.provider') }
      : {}),
    ...(value.model !== undefined
      ? { model: nonEmptyString(value.model, check, 'response.model') }
      : {}),
    ...(value.commit_started_at === null
      ? { commitStartedAt: null }
      : value.commit_started_at !== undefined
        ? {
            commitStartedAt: timestampText(
              value.commit_started_at,
              check,
              'response.commit_started_at',
            ),
          }
        : {}),
  };
  if (
    snapshot.id !== expected.operationId ||
    !expected.statuses.includes(snapshot.status) ||
    (expected.projectId !== undefined && snapshot.projectId !== expected.projectId) ||
    (expected.documentId !== undefined && snapshot.documentId !== expected.documentId) ||
    (expected.kind !== undefined && snapshot.kind !== expected.kind) ||
    (expected.provider !== undefined && snapshot.provider !== expected.provider) ||
    (expected.model !== undefined && snapshot.model !== expected.model)
  ) {
    fail(check, 'operation response scope or terminal state does not match');
  }
  return snapshot;
}

function allZeroDocumentMetrics(value: Record<string, unknown>): boolean {
  return [
    'processedPageCount',
    'ocrDurationMs',
    'parseWallDurationMs',
    'renderDurationMs',
    'ocrEngineDurationMs',
    'firstChunkMs',
    'examItemCount',
  ].every((key) => nonNegativeInteger(value[key]) === 0);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(
  value: unknown,
  check: string,
  field: string,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(check, `${field} must be a non-empty string`);
  }
  return String(value).trim();
}

function exactString(
  value: unknown,
  expected: string,
  check: string,
  field: string,
): string {
  const normalized = nonEmptyString(value, check, field);
  if (normalized !== expected) {
    fail(check, `${field} must equal ${expected}`);
  }
  return normalized;
}

function sha256Field(value: unknown, check: string, field: string): string {
  const normalized = nonEmptyString(value, check, field);
  if (!SHA256_PATTERN.test(normalized)) {
    fail(check, `${field} must be a SHA-256 digest`);
  }
  return normalized;
}

function safeRelativePath(
  value: unknown,
  check: string,
  field: string,
): string {
  const normalized = nonEmptyString(value, check, field).replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.includes('\0') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    fail(check, `${field} must be a safe relative path`);
  }
  return normalized;
}

function scopedId(value: unknown, check: string, field: string): string {
  const normalized = nonEmptyString(value, check, field);
  if (!IDENTIFIER_PATTERN.test(normalized)) {
    fail(check, `${field} is invalid`);
  }
  return normalized;
}

function operationIdField(value: unknown, check: string, field: string): string {
  return scopedId(value, check, field);
}

function booleanField(value: unknown, check: string, field: string): boolean {
  if (typeof value !== 'boolean') {
    fail(check, `${field} must be boolean`);
  }
  return value === true;
}

function timestamp(value: unknown, check: string, field: string): number {
  const normalized = timestampText(value, check, field);
  const parsed = Date.parse(normalized);
  return parsed;
}

function timestampText(value: unknown, check: string, field: string): string {
  const normalized = nonEmptyString(value, check, field);
  if (!Number.isFinite(Date.parse(normalized))) {
    fail(check, `${field} must be an ISO timestamp`);
  }
  return normalized;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error('Evidence integer must be positive.');
  }
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error('Evidence integer must be non-negative.');
  }
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error('Evidence field must be a string array.');
  }
  return value;
}

function fail(check: string, message: string): never {
  throw new Error(`Resilience evidence contract failed for ${check}: ${message}.`);
}
