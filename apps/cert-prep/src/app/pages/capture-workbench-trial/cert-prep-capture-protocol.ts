/**
 * Pure wire-to-UI mappers and validators for the Cert Prep Capture v2 seam.
 * Kept free of DI and HTTP so the client only owns transport and capture
 * bookkeeping.
 */
import { CAPTURE_RUNTIME_VERSION } from '@cert-prep/capture-runtime-version';
import type {
  CaptureDocument as ApiCaptureDocument,
  RuntimeInstallation as ApiRuntimeInstallation,
  RuntimeReady as ApiRuntimeReady,
  RuntimeRequirementV2 as ApiRuntimeRequirement,
} from '@cert-prep/api';
import type {
  CaptureBlock,
  CaptureDocument,
  CaptureEngine,
  CaptureFailure,
  CaptureOperation,
  CaptureSourceKind,
  CaptureStreamingResult,
  PartialCapture,
  RawCaptureSegment,
  RawCapture,
  RuntimeInstallation,
  RuntimeRequirement,
  StructuringMode,
} from '@gx-capture/capture-workbench-ui';
import type {
  CaptureRuntimeReady,
  OcrAdapterClass,
  OcrComputePreflight,
  OcrComputeReasonCode,
  UnknownRecord,
} from './contracts/capture-workbench-trial.contracts';

export function mapReady(response: ApiRuntimeReady): CaptureRuntimeReady {
  if (response.service !== 'capture-runtime') {
    throw new Error(
      'Cert Prep backend returned a non-Capture Runtime service.',
    );
  }
  const capabilities = record(response.capabilities, 'capabilities');
  const captureKinds = array(
    capabilities['captureKinds'],
    'capabilities.captureKinds',
  ).filter(
    (value): value is CaptureSourceKind =>
      typeof value === 'string' && isSourceKind(value),
  );
  const structuringModes = array(
    capabilities['structuringModes'],
    'capabilities.structuringModes',
  ).filter(
    (value): value is StructuringMode =>
      typeof value === 'string' && isStructuringMode(value),
  );
  if (
    capabilities['supportsCancellation'] !== true ||
    capabilities['supportsRawDiagnostics'] !== true
  ) {
    throw new Error(
      'Cert Prep backend returned runtime capabilities outside the Capture contract.',
    );
  }
  return {
    ready: response.ready,
    service: 'capture-runtime',
    apiVersion: response.apiVersion,
    runtimeVersion: response.runtimeVersion,
    captureDocumentSchemaVersion: response.captureDocumentSchemaVersion,
    capabilities: {
      captureKinds,
      structuringModes,
      supportsCancellation: true,
      supportsRawDiagnostics: true,
      maxUploadBytes:
        capabilities['maxUploadBytes'] === undefined
          ? undefined
          : integer(
              capabilities['maxUploadBytes'],
              'capabilities.maxUploadBytes',
            ),
    },
    captureDocumentSchemaSha256:
      response.captureDocumentSchemaSha256 ?? undefined,
    schemaSha256: response.schemaSha256 ?? undefined,
    contractSetVersion: response.contractSetVersion,
    ocrCompute: mapOcrCompute(response.ocrCompute, response.runtimeVersion),
    message: response.message,
  };
}

function mapOcrCompute(
  value: ApiRuntimeReady['ocrCompute'],
  runtimeVersion: string,
): OcrComputePreflight | null {
  if (value == null) return null;
  const preflight = record(value, 'ocrCompute');
  literal(preflight, 'apiVersion', '2.0');
  literal(preflight, 'schemaVersion', '1');
  literal(preflight, 'service', 'capture-runtime');
  const preflightRuntimeVersion = text(
    preflight['runtimeVersion'],
    'ocrCompute.runtimeVersion',
  );
  if (preflightRuntimeVersion !== runtimeVersion) {
    fail('ocrCompute.runtimeVersion does not match runtimeVersion');
  }
  literal(preflight, 'contractSetVersion', '2');
  const contractSha256 = pattern(
    preflight['contractSha256'],
    'ocrCompute.contractSha256',
    /^[0-9a-f]{64}$/u,
  );
  const workerSha256 =
    preflight['workerSha256'] === null
      ? null
      : pattern(
          preflight['workerSha256'],
          'ocrCompute.workerSha256',
          /^[0-9a-f]{64}$/u,
        );
  const mode = enumValue(preflight['mode'], 'ocrCompute.mode', [
    'gpu-dml',
    'cpu-fallback',
  ]) as OcrComputePreflight['mode'];
  const adapterClass = enumValue(
    preflight['adapterClass'],
    'ocrCompute.adapterClass',
    ['dedicated', 'integrated', 'unknown'],
  ) as OcrAdapterClass;
  const reasonCode = nullableEnumValue(
    preflight['reasonCode'],
    'ocrCompute.reasonCode',
    ['no_compatible_gpu', 'dml_provider_unavailable'],
  ) as OcrComputeReasonCode | null;
  const userNoticeRequired = booleanValue(
    preflight['userNoticeRequired'],
    'ocrCompute.userNoticeRequired',
  );
  const noticeCode = nullableEnumValue(
    preflight['noticeCode'],
    'ocrCompute.noticeCode',
    ['ocr_cpu_fallback'],
  ) as OcrComputePreflight['noticeCode'];
  if (mode === 'gpu-dml') {
    if (reasonCode !== null || userNoticeRequired || noticeCode !== null) {
      fail('ocrCompute gpu-dml cannot carry a fallback reason or notice');
    }
  } else if (
    reasonCode === null ||
    !userNoticeRequired ||
    noticeCode !== 'ocr_cpu_fallback'
  ) {
    fail('ocrCompute cpu-fallback requires a reason and user notice');
  }
  return {
    apiVersion: '2.0',
    schemaVersion: '1',
    service: 'capture-runtime',
    // The generated package contract narrows this field to the projected
    // release. Incompatible handshakes are still returned for the outer
    // compatibility gate below, so preserve the validated wire value here.
    runtimeVersion:
      preflightRuntimeVersion as OcrComputePreflight['runtimeVersion'],
    contractSetVersion: '2',
    contractSha256,
    workerSha256,
    mode,
    adapterClass,
    reasonCode,
    userNoticeRequired,
    noticeCode,
  };
}

export function mapRequirement(
  requirement: ApiRuntimeRequirement,
): RuntimeRequirement {
  return {
    requirementId:
      requirement.requirementId as RuntimeRequirement['requirementId'],
    kind: requirement.kind,
    displayName: requirement.displayName,
    status: requirement.status as RuntimeRequirement['status'],
    requiredFor: requirement.requiredFor,
    installStrategy: requirement.installStrategy,
    detail: requirement.detail,
  };
}

export function mapInstallation(
  installation: ApiRuntimeInstallation,
): RuntimeInstallation {
  return {
    installationId: installation.installationId,
    requirementId:
      installation.requirementId as RuntimeInstallation['requirementId'],
    status: installation.status as RuntimeInstallation['status'],
    progress: installation.progress,
    error: installation.error == null ? null : mapFailure(installation.error),
    createdAt: installation.createdAt,
    updatedAt: installation.updatedAt,
    completedAt: installation.completedAt,
  };
}

function mapFailure(
  failure: NonNullable<ApiRuntimeInstallation['error']>,
): CaptureFailure {
  return {
    code: failure.code,
    message: failure.message,
    stage: failure.stage,
    retryable: failure.retryable ?? false,
  };
}

class CaptureClientProtocolError extends Error {
  constructor(message: string) {
    super(`Capture API returned an invalid contract: ${message}`);
    this.name = 'CaptureClientProtocolError';
  }
}

export function mapCaptureDocument(value: unknown): CaptureDocument {
  const document = record(value, 'capture document');
  return {
    schemaVersion: literal(document, 'schemaVersion', '2'),
    source: mapSource(document['source']),
    rawSegments: nonEmptyArray(document['rawSegments'], 'rawSegments').map(
      mapRawSegment,
    ),
    blocks: nonEmptyArray(document['blocks'], 'blocks').map(mapBlock),
    sourceText: text(document['sourceText'], 'sourceText'),
    targetText: text(document['targetText'], 'targetText'),
    extractionEngine: mapEngine(
      document['extractionEngine'],
      'extractionEngine',
    ),
    structuringEngine: mapEngine(
      document['structuringEngine'],
      'structuringEngine',
    ),
    warnings: warnings(document['warnings']),
    createdAt: timestamp(document['createdAt'], 'createdAt'),
    completedAt: timestamp(document['completedAt'], 'completedAt'),
  };
}

export function mapCaptureOperation(
  value: unknown,
  expectedCaptureId?: string,
): CaptureOperation {
  const operation = record(value, 'capture operation');
  if (operation['protocolVersion'] !== '2') {
    fail('protocolVersion must be 2');
  }
  const captureId = opaqueCaptureId(operation['captureId']);
  const ingestionId = opaqueCaptureId(operation['ingestionId']);
  if (expectedCaptureId !== undefined && captureId !== expectedCaptureId) {
    fail('captureId does not match the requested operation');
  }
  const kind = operation['kind'];
  if (typeof kind !== 'string' || !isSourceKind(kind)) {
    fail('capture kind is unsupported');
  }
  const status = operation['status'];
  if (
    typeof status !== 'string' ||
    ![
      'created',
      'waiting_input',
      'extracting',
      'awaiting_structuring',
      'structuring',
      'completed',
      'failed',
      'cancelled',
    ].includes(status)
  ) {
    fail('capture status is unsupported');
  }
  const progress = operation['progress'];
  if (
    progress !== undefined &&
    progress !== null &&
    (typeof progress !== 'number' ||
      !Number.isFinite(progress) ||
      progress < 0 ||
      progress > 1)
  ) {
    fail('capture progress is invalid');
  }
  const partialRevision = nonNegativeInteger(
    operation['partialRevision'],
    'partialRevision',
  );
  const lastEventSequence = nonNegativeInteger(
    operation['lastEventSequence'],
    'lastEventSequence',
  );
  const source =
    operation['source'] === undefined || operation['source'] === null
      ? null
      : mapSource(operation['source']);
  const error =
    operation['error'] === undefined || operation['error'] === null
      ? null
      : mapCaptureFailure(operation['error']);
  if ((status === 'failed') !== (error !== null)) {
    fail('capture error does not match status');
  }
  const createdAt = timestamp(operation['createdAt'], 'createdAt');
  const updatedAt = timestamp(operation['updatedAt'], 'updatedAt');
  const completedAt =
    operation['completedAt'] === undefined || operation['completedAt'] === null
      ? null
      : timestamp(operation['completedAt'], 'completedAt');
  const terminal = ['completed', 'failed', 'cancelled'].includes(status);
  if (terminal !== (completedAt !== null)) {
    fail('completedAt does not match capture status');
  }
  return {
    protocolVersion: '2',
    captureId,
    ingestionId,
    kind,
    status: status as CaptureOperation['status'],
    progress: progress as number | null | undefined,
    partialRevision,
    lastEventSequence,
    source,
    error,
    createdAt,
    updatedAt,
    completedAt,
  };
}

export function mapPartialCapture(
  value: unknown,
  expectedCaptureId: string,
): PartialCapture {
  const partial = record(value, 'partial capture');
  if (partial['protocolVersion'] !== '2') {
    fail('partial protocolVersion must be 2');
  }
  const captureId = opaqueCaptureId(partial['captureId']);
  if (captureId !== expectedCaptureId) {
    fail('partial captureId does not match the request');
  }
  const segments =
    partial['segments'] === undefined || partial['segments'] === null
      ? []
      : array(partial['segments'], 'segments').map(mapRawSegment);
  if (segments.length > 10_000) fail('partial segments exceed the limit');
  segments.forEach((segment, index) => {
    if (segment.order !== index)
      fail('partial segment order is not contiguous');
  });
  if (
    new Set(segments.map((segment) => segment.segmentId)).size !==
    segments.length
  ) {
    fail('partial segment identifiers must be unique');
  }
  const projectedText = segments.map((segment) => segment.text).join('\n');
  const sourceText =
    partial['sourceText'] === undefined || partial['sourceText'] === null
      ? projectedText
      : stringValue(partial['sourceText'], 'sourceText');
  if (sourceText !== projectedText) {
    fail('partial sourceText does not match its segments');
  }
  return {
    protocolVersion: '2',
    captureId,
    source: mapSource(partial['source']),
    revision: nonNegativeInteger(partial['revision'], 'revision'),
    coveredUntilMs: nonNegativeInteger(
      partial['coveredUntilMs'],
      'coveredUntilMs',
    ),
    segments,
    sourceText,
    extractionEngine:
      partial['extractionEngine'] === undefined ||
      partial['extractionEngine'] === null
        ? null
        : mapEngine(partial['extractionEngine'], 'extractionEngine'),
    updatedAt: timestamp(partial['updatedAt'], 'updatedAt'),
  };
}

export function mapCaptureStreamingResult(
  value: unknown,
  expectedCaptureId: string,
): CaptureStreamingResult {
  const composite = record(value, 'capture result');
  const operation = mapCaptureOperation(
    composite['operation'],
    expectedCaptureId,
  );
  const raw = mapRawCapture(composite['raw']);
  const result = mapCaptureDocument(composite['result']);
  const source = operation.source;
  if (
    !sameCaptureSource(raw.source, result.source) ||
    (source !== null &&
      source !== undefined &&
      !sameCaptureSource(source, raw.source))
  ) {
    fail('result source does not match the capture operation');
  }
  return { operation, raw, result };
}

export function mapRawCapture(value: unknown): RawCapture {
  const raw = record(value, 'raw capture');
  const segments = nonEmptyArray(raw['segments'], 'segments').map(
    mapRawSegment,
  );
  segments.forEach((segment, index) => {
    if (segment.order !== index) fail('raw segment order is not contiguous');
  });
  const sourceText = stringValue(raw['sourceText'], 'sourceText');
  if (sourceText !== segments.map((segment) => segment.text).join('\n')) {
    fail('raw sourceText does not match its segments');
  }
  return {
    schemaVersion: literal(raw, 'schemaVersion', '2'),
    diagnosticOnly: literal(raw, 'diagnosticOnly', true),
    source: mapSource(raw['source']),
    segments,
    sourceText,
    extractionEngine: mapEngine(raw['extractionEngine'], 'extractionEngine'),
    warnings: warnings(raw['warnings']),
    createdAt: timestamp(raw['createdAt'], 'createdAt'),
  };
}

function mapCaptureFailure(
  value: unknown,
): NonNullable<CaptureOperation['error']> {
  const failure = record(value, 'capture error');
  const code = pattern(
    failure['code'],
    'error.code',
    /^[a-z][a-z0-9_]{1,63}$/u,
  );
  const message = text(failure['message'], 'error.message');
  if ([...message].length > 500) fail('error.message exceeds the limit');
  const stage =
    failure['stage'] === undefined || failure['stage'] === null
      ? null
      : text(failure['stage'], 'error.stage');
  const retryable = failure['retryable'];
  if (retryable !== undefined && typeof retryable !== 'boolean') {
    fail('error.retryable must be boolean');
  }
  return { code, message, stage, retryable: retryable ?? false };
}

function mapSource(value: unknown): CaptureDocument['source'] {
  const source = record(value, 'source');
  const bytes = integer(source['bytes'], 'source.bytes');
  if (bytes < 1) fail('source.bytes must be positive');
  return {
    sha256: pattern(source['sha256'], 'source.sha256', /^[0-9a-f]{64}$/u),
    fileName: text(source['fileName'], 'source.fileName'),
    mediaType: text(source['mediaType'], 'source.mediaType'),
    bytes,
  };
}

function sameCaptureSource(
  left: CaptureDocument['source'],
  right: CaptureDocument['source'],
): boolean {
  return (
    left.sha256 === right.sha256 &&
    left.fileName === right.fileName &&
    left.mediaType === right.mediaType &&
    left.bytes === right.bytes
  );
}

function mapRawSegment(value: unknown): RawCaptureSegment {
  const segment = record(value, 'raw segment');
  return {
    segmentId: text(segment['segmentId'], 'segmentId'),
    order: nonNegativeInteger(segment['order'], 'segment.order'),
    locator: mapLocator(segment['locator']),
    text: text(segment['text'], 'segment.text'),
  };
}

function mapBlock(value: unknown): CaptureBlock {
  const block = record(value, 'capture block');
  const blockType = text(block['type'], 'block.type');
  if (
    ![
      'heading',
      'paragraph',
      'list-item',
      'table',
      'quote',
      'transcript',
    ].includes(blockType)
  ) {
    fail(`block.type is unsupported: ${blockType}`);
  }
  return {
    blockId: text(block['blockId'], 'block.blockId'),
    order: nonNegativeInteger(block['order'], 'block.order'),
    type: blockType as CaptureBlock['type'],
    sourceSegmentId: text(block['sourceSegmentId'], 'block.sourceSegmentId'),
    locator: mapLocator(block['locator']),
    sourceText: text(block['sourceText'], 'block.sourceText'),
    targetText: text(block['targetText'], 'block.targetText'),
  };
}

function mapLocator(value: unknown): RawCapture['segments'][number]['locator'] {
  const locator = record(value, 'locator');
  const kind = locator['kind'];
  if (kind === 'page') {
    const page = integer(locator['page'], 'locator.page');
    if (page < 1) fail('locator.page must be positive');
    const boundingBox = locator['boundingBox'];
    if (boundingBox == null) return { kind, page, boundingBox: null };
    if (
      !Array.isArray(boundingBox) ||
      boundingBox.length !== 4 ||
      boundingBox.some(
        (item) => typeof item !== 'number' || !Number.isFinite(item),
      )
    ) {
      fail('locator.boundingBox must contain exactly four finite numbers');
    }
    return {
      kind,
      page,
      boundingBox: boundingBox as [number, number, number, number],
    };
  }
  if (kind === 'time') {
    const startMs = nonNegativeInteger(locator['startMs'], 'locator.startMs');
    const endMs = integer(locator['endMs'], 'locator.endMs');
    if (endMs <= startMs) fail('locator.endMs must be greater than startMs');
    return { kind, startMs, endMs };
  }
  fail(`locator.kind is unsupported: ${String(kind)}`);
}

function mapEngine(value: unknown, label: string): CaptureEngine {
  const engine = record(value, label);
  return {
    engine: text(engine['engine'], `${label}.engine`),
    model: text(engine['model'], `${label}.model`),
    digest: pattern(
      engine['digest'],
      `${label}.digest`,
      /^sha256:[0-9a-f]{64}$/u,
    ),
    device:
      engine['device'] == null
        ? null
        : text(engine['device'], `${label}.device`),
  };
}

function warnings(value: unknown): string[] {
  if (value == null) return [];
  return array(value, 'warnings').map((item, index) =>
    text(item, `warnings[${index}]`),
  );
}

export function record(value: unknown, label: string): UnknownRecord {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

export function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function nonEmptyArray(value: unknown, label: string): unknown[] {
  const result = array(value, label);
  if (result.length === 0) fail(`${label} must be a non-empty array`);
  return result;
}

export function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`);
  return value;
}

function enumValue<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(`${label} has an unsupported value`);
  }
  return value as T;
}

function nullableEnumValue<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T | null {
  if (value == null) return null;
  return enumValue(value, label, allowed);
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    fail(`${label} must be an integer`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const result = integer(value, label);
  if (result < 0) fail(`${label} must not be negative`);
  return result;
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label);
  if (
    !/[zZ]|[+-]\d{2}:?\d{2}$/u.test(result) ||
    Number.isNaN(Date.parse(result))
  ) {
    fail(`${label} must be an ISO timestamp with a timezone`);
  }
  return result;
}

function pattern(value: unknown, label: string, expression: RegExp): string {
  const result = text(value, label);
  if (!expression.test(result)) fail(`${label} has an invalid format`);
  return result;
}

function literal<T>(recordValue: UnknownRecord, key: string, expected: T): T {
  if (recordValue[key] !== expected) fail(`${key} must be ${String(expected)}`);
  return expected;
}

export function fail(message: string): never {
  throw new CaptureClientProtocolError(message);
}

export function exactCaptureOperation(
  operation: CaptureOperation,
): CaptureOperation {
  return {
    protocolVersion: '2',
    captureId: operation.captureId,
    ingestionId: operation.ingestionId,
    kind: operation.kind,
    status: operation.status,
    progress: operation.progress,
    partialRevision: operation.partialRevision,
    lastEventSequence: operation.lastEventSequence,
    source: operation.source,
    error: operation.error,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    completedAt: operation.completedAt,
  };
}

export function toApiCaptureDocument(
  document: CaptureDocument,
): ApiCaptureDocument {
  return {
    schemaVersion: document.schemaVersion,
    source: { ...document.source },
    rawSegments: document.rawSegments.map((segment: RawCaptureSegment) => ({
      ...segment,
      locator: toApiLocator(segment.locator),
    })),
    blocks: document.blocks.map((block: CaptureBlock) => ({
      ...block,
      locator: toApiLocator(block.locator),
    })),
    sourceText: document.sourceText,
    targetText: document.targetText,
    extractionEngine: { ...document.extractionEngine },
    structuringEngine: { ...document.structuringEngine },
    warnings: [...(document.warnings ?? [])],
    createdAt: document.createdAt,
    completedAt: document.completedAt,
  };
}

function toApiLocator(
  locator: RawCaptureSegment['locator'],
): ApiCaptureDocument['rawSegments'][number]['locator'] {
  if (locator.kind === 'time') {
    return {
      kind: 'time',
      startMs: locator.startMs,
      endMs: locator.endMs,
    };
  }
  return {
    kind: 'page',
    page: locator.page,
    boundingBox:
      locator.boundingBox === undefined || locator.boundingBox === null
        ? locator.boundingBox
        : [...locator.boundingBox],
  };
}

export function opaqueCaptureId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    fail('captureId has an invalid format');
  }
  return value;
}

function isSourceKind(value: string): value is CaptureSourceKind {
  return value === 'pdf' || value === 'image' || value === 'audio';
}

function isStructuringMode(value: string): value is StructuringMode {
  return value === 'runtime' || value === 'host';
}

export function assertCaptureRuntimeMinorCompatible(
  runtimeVersion: string,
): void {
  const expectedMinor = parseRuntimeMinor(CAPTURE_RUNTIME_VERSION);
  if (parseRuntimeMinor(runtimeVersion) !== expectedMinor) {
    throw new Error(
      `Capture runtime ${runtimeVersion} is incompatible with client runtime minor ${expectedMinor} while the client is on 0.x.`,
    );
  }
}

function parseRuntimeMinor(version: string): number {
  const minor = Number.parseInt(
    version.trim().replace(/^v/iu, '').split('.')[1] ?? '',
    10,
  );
  return Number.isFinite(minor) ? minor : -1;
}

export function assertRequirementReady(
  requirements: readonly RuntimeRequirement[],
  requirementId: RuntimeRequirement['requirementId'],
  displayName: string,
): void {
  const requirement = requirements.find(
    (candidate) => candidate.requirementId === requirementId,
  );
  if (requirement?.status === 'ready') return;
  const detail =
    requirement?.detail ?? 'The runtime requirement is unavailable.';
  throw new Error(`${displayName} is unavailable. ${detail}`);
}
