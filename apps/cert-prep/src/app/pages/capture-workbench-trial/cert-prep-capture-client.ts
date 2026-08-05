import { inject, Injectable } from '@angular/core';
import { CAPTURE_RUNTIME_VERSION } from '@cert-prep/capture-runtime-version';
import type {
  CaptureReviewJobRead as ApiCaptureReviewJobRead,
  RuntimeInstallationV1 as ApiRuntimeInstallationV1,
  RuntimeReadyV1 as ApiRuntimeReadyV1,
  RuntimeRequirementV1 as ApiRuntimeRequirementV1,
} from '@cert-prep/api';
import {
  defer,
  forkJoin,
  map,
  of,
  switchMap,
  throwError,
  type Observable,
} from 'rxjs';
import {
  assertCaptureRuntimeCompatible,
  CAPTURE_RUNTIME_MAJOR,
} from '@gx-capture/capture-workbench';
import type {
  CaptureClient,
  CaptureBlockV1,
  ConfirmCaptureRequest,
  CaptureEngineV1,
  CaptureDocumentV1,
  CaptureFailureV1,
  CaptureJobV1,
  CaptureJobStage,
  CaptureJobStatus,
  CaptureSourceKind,
  CommitStructuredResultRequest,
  CreateCaptureRequest,
  RawCaptureV1,
  RawCaptureSegmentV1,
  ReportStructuringFailureRequest,
  RuntimeInstallationV1,
  RuntimeReadyV1,
  RuntimeRequirementV1,
  StartRuntimeInstallationRequest,
} from '@gx-capture/capture-workbench';
import { CERT_PREP_API } from '../../constants/cert-prep-api.constants';
import { ProjectStore } from '../../stores/project.store';

interface CaptureRecord {
  readonly projectId: string;
  readonly documentId: string;
  readonly sourceSha256: string;
  readonly sourceKind: CaptureSourceKind;
  readonly bytes: number;
}

/**
 * Adapts cert-prep's durable document pipeline to Capture Workbench's client
 * contract. The browser only sees the cert-prep API; the sidecar credential
 * and loopback address remain owned by the backend coordinator.
 */
@Injectable({ providedIn: 'root' })
export class CertPrepCaptureClient implements CaptureClient {
  private readonly api = inject(CERT_PREP_API);
  private readonly projects = inject(ProjectStore);
  private readonly captures = new Map<string, CaptureRecord>();
  private readonly completedDocuments = new Map<string, string>();
  private latestDocumentId: string | null = null;

  getReady(signal?: AbortSignal): Observable<RuntimeReadyV1> {
    return this.api.captureRuntimeReady({ signal }).pipe(map(mapReady));
  }

  getDocumentMarkdown(
    projectId: string,
    documentId: string,
    signal?: AbortSignal,
  ): Observable<Blob> {
    return this.api.getDocumentMarkdown(projectId, documentId, { signal });
  }

  getRequirements(
    signal?: AbortSignal,
  ): Observable<readonly RuntimeRequirementV1[]> {
    return this.api.captureRuntimeRequirements({ signal }).pipe(
      map((response) => response.items.map(mapRequirement)),
    );
  }

  startInstallation(
    request: StartRuntimeInstallationRequest,
    signal?: AbortSignal,
  ): Observable<RuntimeInstallationV1> {
    return this.api
      .startCaptureRuntimeInstallation(
        { requirementId: request.requirementId, consent: request.consent },
        {
          headers: { 'X-Idempotency-Key': request.clientRequestId },
          signal,
        },
      )
      .pipe(map(mapInstallation));
  }

  listInstallations(
    signal?: AbortSignal,
  ): Observable<readonly RuntimeInstallationV1[]> {
    return this.api
      .captureRuntimeInstallations({ signal })
      .pipe(map((response) => response.items.map(mapInstallation)));
  }

  getInstallation(
    id: string,
    signal?: AbortSignal,
  ): Observable<RuntimeInstallationV1> {
    return this.api
      .captureRuntimeInstallation(id, { signal })
      .pipe(map(mapInstallation));
  }

  cancelInstallation(
    id: string,
    signal?: AbortSignal,
  ): Observable<RuntimeInstallationV1> {
    return this.api
      .cancelCaptureRuntimeInstallation(id, { signal })
      .pipe(map(mapInstallation));
  }

  createCapture(request: CreateCaptureRequest): Observable<CaptureJobV1> {
    const projectId = this.requireProjectId();
    return defer(() =>
      forkJoin({
        ready: this.getReady(request.signal),
        requirements: this.getRequirements(request.signal),
      }),
    ).pipe(
      switchMap(({ ready, requirements }) => {
        assertCaptureAdmission(ready, requirements, request.sourceKind);
        const formData = new FormData();
        formData.append('file', request.file, request.file.name);
        return this.api.createCapture(projectId, formData, {
          headers: { 'X-Cert-Prep-Operation-Id': request.clientRequestId },
          signal: request.signal,
        });
      }),
      map((job) => {
        const sourceKind = request.sourceKind;
        const source = job.source;
        if (source == null) {
          throw new Error('Cert Prep did not return a capture source.');
        }
        this.captures.set(job.captureId, {
          projectId: projectId,
          documentId: job.documentId,
          sourceSha256: source.sha256,
          sourceKind,
          bytes: source.bytes,
        });
        this.completedDocuments.set(source.sha256, job.documentId);
        this.latestDocumentId = job.documentId;
        return mapCaptureJob(job, sourceKind, request.file.size);
      }),
    );
  }

  getCapture(id: string, signal?: AbortSignal): Observable<CaptureJobV1> {
    const record = this.requireCapture(id);
    return this.api
      .getCapture(record.projectId, id, { signal })
      .pipe(map((job) => mapCaptureJob(job, record.sourceKind, record.bytes)));
  }

  cancelCapture(id: string, signal?: AbortSignal): Observable<CaptureJobV1> {
    const record = this.requireCapture(id);
    return this.api
      .cancelCapture(record.projectId, id, { signal })
      .pipe(map((job) => mapCaptureJob(job, record.sourceKind, record.bytes)));
  }

  confirmCapture(
    id: string,
    request: ConfirmCaptureRequest,
    signal?: AbortSignal,
  ): Observable<CaptureJobV1> {
    const record = this.requireCapture(id);
    return this.api
      .confirmCapture(
        record.projectId,
        id,
        {
          clientRequestId: request.clientRequestId,
          review: {
            reviewVersion: request.review.reviewVersion,
            edits: request.review.edits.map((edit) => ({
              segmentId: edit.segmentId,
              reviewedText: edit.reviewedText,
            })),
          },
        },
        { signal },
      )
      .pipe(map((job) => mapCaptureJob(job, record.sourceKind, record.bytes)));
  }

  getRaw(id: string, signal?: AbortSignal): Observable<RawCaptureV1> {
    const record = this.requireCapture(id);
    return this.api
      .getRaw(record.projectId, id, { signal })
      .pipe(map(mapRawCapture));
  }

  getResult(id: string, signal?: AbortSignal): Observable<CaptureDocumentV1> {
    const record = this.requireCapture(id);
    return this.api
      .getResult(record.projectId, id, { signal })
      .pipe(map(mapCaptureDocument));
  }

  commitStructuredResult(
    id: string,
    request: CommitStructuredResultRequest,
    signal?: AbortSignal,
  ): Observable<CaptureJobV1> {
    void id;
    void request;
    void signal;
    return throwError(
      () =>
        new Error(
          'Host structuring is owned by the cert-prep backend coordinator.',
        ),
    );
  }

  reportStructuringFailure(
    id: string,
    request: ReportStructuringFailureRequest,
    signal?: AbortSignal,
  ): Observable<CaptureJobV1> {
    void id;
    void request;
    void signal;
    return throwError(
      () =>
        new Error(
          'Host structuring failures are owned by the cert-prep backend coordinator.',
        ),
    );
  }

  deleteCapture(id: string, signal?: AbortSignal): Observable<void> {
    void signal;
    this.captures.delete(id);
    return of(undefined);
  }

  documentIdForSourceSha256(sourceSha256: string): string | null {
    const completedDocumentId = this.completedDocuments.get(sourceSha256);
    if (completedDocumentId !== undefined) return completedDocumentId;
    for (const record of this.captures.values()) {
      // The backend document is the durable owner of the source digest. The
      // completed event carries that digest, not the internal task id.
      if (record.sourceSha256 === sourceSha256) return record.documentId;
    }
    // The trial page accepts one PDF at a time. Keep completion handoff
    // durable even when a browser-side digest implementation differs from
    // the backend's canonical upload digest.
    return this.latestDocumentId;
  }

  private requireProjectId(): string {
    const projectId = this.projects.selectedProjectId();
    if (projectId === null || projectId.trim().length === 0) {
      throw new Error('Select a Cert Prep project before capturing a document.');
    }
    return projectId;
  }

  private requireCapture(id: string): CaptureRecord {
    const record = this.captures.get(id);
    if (record !== undefined) {
      return record;
    }
    const projectId = this.requireProjectId();
    return {
      projectId,
      documentId: id,
      sourceSha256: '',
      sourceKind: 'pdf',
      bytes: 1,
    };
  }
}

function mapReady(response: ApiRuntimeReadyV1): RuntimeReadyV1 {
  if (response.service !== 'capture-runtime') {
    throw new Error('Cert Prep backend returned a non-Capture Runtime service.');
  }
  return {
    ready: response.ready,
    service: 'capture-runtime',
    apiVersion: response.apiVersion,
    runtimeVersion: response.runtimeVersion,
    captureDocumentSchemaVersion: response.captureDocumentSchemaVersion,
    capabilities: {
      captureKinds: response.capabilities.captureKinds.filter(isSourceKind),
      structuringModes: response.capabilities.structuringModes.filter(
        isStructuringMode,
      ),
      supportsCancellation:
        response.capabilities.supportsCancellation ?? false,
      supportsRawDiagnostics:
        response.capabilities.supportsRawDiagnostics ?? false,
      maxUploadBytes: response.capabilities.maxUploadBytes,
    },
    message: response.message,
  };
}

function mapRequirement(
  requirement: ApiRuntimeRequirementV1,
): RuntimeRequirementV1 {
  return {
    requirementId: requirement.requirementId as RuntimeRequirementV1['requirementId'],
    kind: requirement.kind,
    displayName: requirement.displayName,
    status: requirement.status as RuntimeRequirementV1['status'],
    requiredFor: requirement.requiredFor,
    installStrategy: requirement.installStrategy,
    detail: requirement.detail,
  };
}

function mapInstallation(
  installation: ApiRuntimeInstallationV1,
): RuntimeInstallationV1 {
  return {
    installationId: installation.installationId,
    requirementId:
      installation.requirementId as RuntimeInstallationV1['requirementId'],
    status: installation.status as RuntimeInstallationV1['status'],
    progress: installation.progress,
    error: installation.error == null ? null : mapFailure(installation.error),
    createdAt: installation.createdAt,
    updatedAt: installation.updatedAt,
    completedAt: installation.completedAt,
  };
}

function mapFailure(
  failure: NonNullable<ApiRuntimeInstallationV1['error']>,
): CaptureFailureV1 {
  return {
    code: failure.code,
    message: failure.message,
    stage: isFailureStage(failure.stage) ? failure.stage : null,
    retryable: failure.retryable ?? false,
  };
}

class CaptureClientProtocolError extends Error {
  constructor(message: string) {
    super(`Capture API returned an invalid contract: ${message}`);
    this.name = 'CaptureClientProtocolError';
  }
}

type UnknownRecord = Record<string, unknown>;

function mapRawCapture(value: unknown): RawCaptureV1 {
  const raw = record(value, 'raw capture');
  return {
    schemaVersion: literal(raw, 'schemaVersion', '1'),
    diagnosticOnly: literal(raw, 'diagnosticOnly', true),
    source: mapSource(raw['source']),
    segments: nonEmptyArray(raw['segments'], 'segments').map(mapRawSegment),
    sourceText: text(raw['sourceText'], 'sourceText'),
    extractionEngine: mapEngine(raw['extractionEngine'], 'extractionEngine'),
    warnings: warnings(raw['warnings']),
    createdAt: timestamp(raw['createdAt'], 'createdAt'),
  };
}

function mapCaptureDocument(value: unknown): CaptureDocumentV1 {
  const document = record(value, 'capture document');
  return {
    schemaVersion: literal(document, 'schemaVersion', '1'),
    source: mapSource(document['source']),
    rawSegments: nonEmptyArray(document['rawSegments'], 'rawSegments').map(mapRawSegment),
    blocks: nonEmptyArray(document['blocks'], 'blocks').map(mapBlock),
    sourceText: text(document['sourceText'], 'sourceText'),
    targetText: text(document['targetText'], 'targetText'),
    extractionEngine: mapEngine(document['extractionEngine'], 'extractionEngine'),
    structuringEngine: mapEngine(document['structuringEngine'], 'structuringEngine'),
    warnings: warnings(document['warnings']),
    createdAt: timestamp(document['createdAt'], 'createdAt'),
    completedAt: timestamp(document['completedAt'], 'completedAt'),
  };
}

function mapSource(value: unknown): CaptureDocumentV1['source'] {
  const source = record(value, 'source');
  const bytes = integer(source['bytes'], 'source.bytes');
  if (bytes < 1) fail('source.bytes must be positive');
  return {
    sha256: pattern(source['sha256'], 'source.sha256', /^[0-9a-f]{64}$/),
    fileName: text(source['fileName'], 'source.fileName'),
    mediaType: text(source['mediaType'], 'source.mediaType'),
    bytes,
  };
}

function mapRawSegment(value: unknown): RawCaptureSegmentV1 {
  const segment = record(value, 'raw segment');
  return {
    segmentId: text(segment['segmentId'], 'segmentId'),
    order: nonNegativeInteger(segment['order'], 'segment.order'),
    locator: mapLocator(segment['locator']),
    text: text(segment['text'], 'segment.text'),
  };
}

function mapBlock(value: unknown): CaptureBlockV1 {
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
    type: blockType as CaptureBlockV1['type'],
    sourceSegmentId: text(block['sourceSegmentId'], 'block.sourceSegmentId'),
    locator: mapLocator(block['locator']),
    sourceText: text(block['sourceText'], 'block.sourceText'),
    targetText: text(block['targetText'], 'block.targetText'),
  };
}

function mapLocator(value: unknown): RawCaptureV1['segments'][number]['locator'] {
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
      boundingBox.some((item) => typeof item !== 'number' || !Number.isFinite(item))
    ) {
      fail('locator.boundingBox must contain exactly four finite numbers');
    }
    return { kind, page, boundingBox: boundingBox as [number, number, number, number] };
  }
  if (kind === 'time') {
    const startMs = nonNegativeInteger(locator['startMs'], 'locator.startMs');
    const endMs = integer(locator['endMs'], 'locator.endMs');
    if (endMs <= startMs) fail('locator.endMs must be greater than startMs');
    return { kind, startMs, endMs };
  }
  fail(`locator.kind is unsupported: ${String(kind)}`);
}

function mapEngine(value: unknown, label: string): CaptureEngineV1 {
  const engine = record(value, label);
  const digest = pattern(engine['digest'], `${label}.digest`, /^sha256:[0-9a-f]{64}$/);
  return {
    engine: text(engine['engine'], `${label}.engine`),
    model: text(engine['model'], `${label}.model`),
    digest,
    device:
      engine['device'] == null
        ? null
        : text(engine['device'], `${label}.device`),
  };
}

function warnings(value: unknown): string[] {
  if (value == null) return [];
  return nonEmptyArray(value, 'warnings', true).map((item, index) =>
    text(item, `warnings[${index}]`),
  );
}

function record(value: unknown, label: string): UnknownRecord {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function nonEmptyArray(
  value: unknown,
  label: string,
  allowEmpty = false,
): unknown[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail(`${label} must be a non-empty array`);
  }
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
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
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(result) || Number.isNaN(Date.parse(result))) {
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

function fail(message: string): never {
  throw new CaptureClientProtocolError(message);
}

function mapCaptureJob(
  job: ApiCaptureReviewJobRead,
  sourceKind: CaptureSourceKind,
  bytes: number,
): CaptureJobV1 {
  const status = job.status as CaptureJobStatus;
  const stage = job.stage as CaptureJobStage;
  const source = job.source == null
    ? null
    : {
        sha256: job.source.sha256,
        fileName: job.source.fileName,
        mediaType: job.source.mediaType || mediaTypeFor(job.source.fileName, sourceKind),
        bytes: Math.max(1, bytes || job.source.bytes),
      };
  const completed = status === 'completed' || status === 'failed' || status === 'cancelled';
  return {
    captureId: job.captureId,
    status,
    stage,
    structuringMode: 'host',
    progress: job.progress,
    source,
    error: job.error == null
      ? null
      : {
          code: job.error.code,
          message: job.error.message,
          stage: isFailureStage(job.error.stage) ? job.error.stage : null,
          retryable: job.error.retryable ?? false,
        },
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: completed ? job.completedAt ?? job.updatedAt : null,
  };
}

function mediaTypeFor(fileName: string, sourceKind: CaptureSourceKind): string {
  if (sourceKind === 'pdf' || fileName.toLowerCase().endsWith('.pdf')) {
    return 'application/pdf';
  }
  if (sourceKind === 'audio') return 'audio/mpeg';
  return 'image/png';
}

function isSourceKind(value: string): value is CaptureSourceKind {
  return value === 'pdf' || value === 'image' || value === 'audio';
}

function isStructuringMode(
  value: string,
): value is RuntimeReadyV1['capabilities']['structuringModes'][number] {
  return value === 'runtime' || value === 'host';
}

function isFailureStage(
  value: string | null | undefined,
): value is NonNullable<CaptureFailureV1['stage']> {
  return (
    value === 'queued' ||
    value === 'extracting' ||
    value === 'awaiting_structuring' ||
    value === 'structuring' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled' ||
    value === 'uploading' ||
    value === 'preprocessing' ||
    value === 'runtime' ||
    value === 'input'
  );
}

function assertCaptureAdmission(
  ready: RuntimeReadyV1,
  requirements: readonly RuntimeRequirementV1[],
  sourceKind: CaptureSourceKind,
): void {
  if (!ready.ready) {
    throw new Error('Capture Runtime is not ready.');
  }
  assertCaptureRuntimeCompatible(ready, CAPTURE_RUNTIME_MAJOR, 'host');
  assertCaptureRuntimeMinorCompatible(ready.runtimeVersion);
  if (!ready.capabilities.captureKinds.includes(sourceKind)) {
    throw new Error(
      `Capture Runtime does not support ${sourceKind.toUpperCase()} capture.`,
    );
  }
  if (sourceKind === 'image') {
    assertRequirementReady(requirements, 'windowsml-ocr', 'WindowsML OCR');
  }
  if (sourceKind === 'audio') {
    assertRequirementReady(
      requirements,
      'whisper-primary',
      'Whisper transcription',
    );
  }
}

function assertCaptureRuntimeMinorCompatible(runtimeVersion: string): void {
  const expectedMinor = parseRuntimeMinor(CAPTURE_RUNTIME_VERSION);
  if (parseRuntimeMinor(runtimeVersion) !== expectedMinor) {
    throw new Error(
      `Capture runtime ${runtimeVersion} is incompatible with client runtime minor ${expectedMinor} while the client is on 0.x.`,
    );
  }
}

function parseRuntimeMinor(version: string): number {
  const minor = Number.parseInt(
    version.trim().replace(/^v/i, '').split('.')[1] ?? '',
    10,
  );
  return Number.isFinite(minor) ? minor : -1;
}

function assertRequirementReady(
  requirements: readonly RuntimeRequirementV1[],
  requirementId: RuntimeRequirementV1['requirementId'],
  displayName: string,
): void {
  const requirement = requirements.find(
    (candidate) => candidate.requirementId === requirementId,
  );
  if (requirement?.status === 'ready') return;
  const detail = requirement?.detail ?? 'The runtime requirement is unavailable.';
  throw new Error(`${displayName} is unavailable. ${detail}`);
}
