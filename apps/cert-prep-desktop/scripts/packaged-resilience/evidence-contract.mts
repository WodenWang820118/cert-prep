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
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+-alpha\.\d+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

export function validateResilienceEvidence(
  value: unknown,
  expectedCheck: ResilienceCheck,
  context: EvidenceValidationContext = {},
): ResilienceEvidence {
  const detail = validateEnvelope(value, expectedCheck, context);
  validateCheckProof(expectedCheck, detail.proof);
  return detail as unknown as ResilienceEvidence;
}

export function validateSessionRestartEvidence(
  value: unknown,
  context: EvidenceValidationContext = {},
): SessionRestartEvidence {
  const detail = validateEnvelope(value, 'sessionRestart', context);
  validateSessionRestartProof(detail.proof);
  return detail as unknown as SessionRestartEvidence;
}

function validateEnvelope(
  value: unknown,
  expectedCheck: ResilienceCheck | 'sessionRestart',
  context: EvidenceValidationContext,
): Record<string, unknown> {
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
  record(detail.proof, `${expectedCheck} proof`);
  return detail;
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
  if (
    !SHA256_PATTERN.test(candidateId) ||
    !VERSION_PATTERN.test(version) ||
    tag !== `cert-prep-v${version}` ||
    !COMMIT_SHA_PATTERN.test(commitSha) ||
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
      validateScopedCancellationProof(proof, check, true);
      return;
    case 'runtime':
    case 'model':
      validateScopedCancellationProof(proof, check, false);
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
    statuses: ['queued', 'running', 'completed'],
  });
  operationSnapshot(proof.retryTerminalResponse, 'ocr', {
    projectId,
    documentId,
    operationId: retryOperationId,
    statuses: ['completed'],
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
  documentScoped: boolean,
): void {
  const projectId = documentScoped
    ? scopedId(proof.projectId, check, 'projectId')
    : undefined;
  const documentId = documentScoped
    ? scopedId(proof.documentId, check, 'documentId')
    : undefined;
  const operationId = operationIdField(proof.operationId, check, 'operationId');
  const cancel = operationSnapshot(proof.cancelResponse, check, {
    projectId,
    documentId,
    operationId,
    statuses: ['cancel_requested', 'canceled'],
  });
  const terminal = operationSnapshot(proof.terminalResponse, check, {
    projectId,
    documentId,
    operationId,
    statuses: ['canceled'],
  });
  const rejection = record(proof.nonCancellableResponse, `${check} non-cancellable response`);
  const rejectionOperationId = operationIdField(
    rejection.operationId,
    check,
    'nonCancellableResponse.operationId',
  );
  if (
    cancel.cancellable !== false ||
    terminal.cancellable !== false ||
    rejectionOperationId.length === 0 ||
    rejection.phase !== 'committing' ||
    rejection.cancellable !== false ||
    rejection.httpStatus !== 409 ||
    rejection.errorCode !== 'operation_not_cancellable'
  ) {
    fail(check, 'cancel or non-cancellable commit evidence is incomplete');
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
  };
  if (
    snapshot.id !== expected.operationId ||
    !expected.statuses.includes(snapshot.status) ||
    (expected.projectId !== undefined && snapshot.projectId !== expected.projectId) ||
    (expected.documentId !== undefined && snapshot.documentId !== expected.documentId)
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
  const normalized = nonEmptyString(value, check, field);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    fail(check, `${field} must be an ISO timestamp`);
  }
  return parsed;
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
