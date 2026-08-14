import { inject, Injectable } from '@angular/core';
import { CAPTURE_RUNTIME_VERSION } from '@cert-prep/capture-runtime-version';
import type {
  CaptureDocumentV1 as ApiCaptureDocumentV1,
  RuntimeInstallationV1 as ApiRuntimeInstallationV1,
  RuntimeReadyV1 as ApiRuntimeReadyV1,
  RuntimeRequirementV1 as ApiRuntimeRequirementV1,
} from '@cert-prep/api';
import {
  defer,
  forkJoin,
  map,
  switchMap,
  tap,
  type Observable,
} from 'rxjs';
import {
  assertCaptureRuntimeCompatible,
  CAPTURE_RUNTIME_MAJOR,
} from '@gx-capture/capture-workbench-ui';
import type {
  CaptureBlockV1,
  CaptureClient,
  CaptureDocumentV1,
  CaptureEngineV1,
  CaptureEventStreamOptions,
  CaptureEventV2,
  CaptureFailureV1,
  CaptureOperationV2,
  CaptureReviewEditV1,
  CaptureSourceKind,
  CaptureStreamingResult,
  CaptureStructuringProvider,
  CaptureStructuringRequest,
  CommitStreamingStructuredResultRequest,
  PartialCaptureV2,
  RawCaptureSegmentV1,
  RawCaptureV1,
  ReportStreamingStructuringFailureRequest,
  RuntimeInstallationV1,
  RuntimeReadyV1,
  RuntimeRequirementV1,
  StartRuntimeInstallationRequest,
  StartStreamingCaptureRequest,
} from '@gx-capture/capture-workbench-ui';
import { CERT_PREP_API } from '../../constants/cert-prep-api.constants';
import { CertPrepRuntimeConfig } from '../../services/cert-prep-api.service';
import { ProjectStore } from '../../stores/project.store';
import { certPrepCaptureEventStream } from './cert-prep-capture-event-stream';

interface CaptureRecord {
  readonly projectId: string;
  readonly documentId: string;
  readonly sourceSha256: string;
  readonly structuringRequestId: string;
}

/**
 * Adapts Cert Prep's durable document pipeline to the published streaming v2
 * client contract. Browser requests only reach the authenticated Cert Prep
 * backend; the Capture Runtime address and sidecar credential remain private
 * to the backend coordinator.
 */
@Injectable({ providedIn: 'root' })
export class CertPrepCaptureClient
  implements CaptureClient, CaptureStructuringProvider
{
  private readonly api = inject(CERT_PREP_API);
  private readonly projects = inject(ProjectStore);
  private readonly runtimeConfig = inject(CertPrepRuntimeConfig);
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

  captureEvents(
    id: string,
    options: CaptureEventStreamOptions = {},
  ): Observable<CaptureEventV2> {
    const captureId = opaqueCaptureId(id);
    return defer(() => {
      const record = this.requireCapture(captureId);
      return this.runtimeConfig.getBackendConfig().pipe(
        switchMap((config) =>
          certPrepCaptureEventStream(
            globalThis.fetch.bind(globalThis),
            captureEventsUrl(config.base_url, record.projectId, captureId),
            {
              method: 'GET',
              headers: {
                Accept: 'text/event-stream',
                Authorization: `Bearer ${config.token}`,
              },
              credentials: 'omit',
              redirect: 'error',
              signal: options.signal,
              lastEventId: options.lastEventId,
              expectedCaptureId: captureId,
            },
          ),
        ),
      );
    });
  }

  startStreamingCapture(
    request: StartStreamingCaptureRequest,
  ): Observable<CaptureOperationV2> {
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
      map((response) => {
        const operation = this.rememberOperation(response, projectId);
        if (operation.kind !== request.sourceKind) {
          fail('capture kind does not match the requested source');
        }
        return operation;
      }),
    );
  }

  getStreamingCapture(
    id: string,
    signal?: AbortSignal,
  ): Observable<CaptureOperationV2> {
    const captureId = opaqueCaptureId(id);
    const record = this.requireCapture(captureId);
    return this.api
      .getCapture(record.projectId, captureId, { signal })
      .pipe(
        map((response) =>
          this.rememberOperation(response, record.projectId, captureId),
        ),
      );
  }

  cancelStreamingCapture(
    id: string,
    signal?: AbortSignal,
  ): Observable<CaptureOperationV2> {
    const captureId = opaqueCaptureId(id);
    const record = this.requireCapture(captureId);
    return this.api
      .cancelCapture(record.projectId, captureId, { signal })
      .pipe(
        map((response) =>
          this.rememberOperation(response, record.projectId, captureId),
        ),
      );
  }

  getStreamingPartial(
    id: string,
    signal?: AbortSignal,
  ): Observable<PartialCaptureV2> {
    const captureId = opaqueCaptureId(id);
    const record = this.requireCapture(captureId);
    return this.api
      .getPartial(record.projectId, captureId, { signal })
      .pipe(map((response) => mapPartialCapture(response, captureId)));
  }

  getStreamingResult(
    id: string,
    signal?: AbortSignal,
  ): Observable<CaptureStreamingResult> {
    const captureId = opaqueCaptureId(id);
    const record = this.requireCapture(captureId);
    return this.api.getResult(record.projectId, captureId, { signal }).pipe(
      map((response) => mapCaptureStreamingResult(response, captureId)),
      map((result) => ({
        operation: this.rememberOperation(
          result.operation,
          record.projectId,
          captureId,
          record.documentId,
        ),
        raw: result.raw,
        result: result.result,
      })),
      tap((result) => {
        this.completedDocuments.set(
          result.result.source.sha256,
          record.documentId,
        );
        this.latestDocumentId = record.documentId;
      }),
    );
  }

  commitStreamingStructuredResult(
    id: string,
    request: CommitStreamingStructuredResultRequest,
    signal?: AbortSignal,
  ): Observable<CaptureOperationV2> {
    const captureId = opaqueCaptureId(id);
    const record = this.requireCapture(captureId);
    return this.api
      .commitCapture(
        record.projectId,
        captureId,
        {
          clientRequestId: request.clientRequestId,
          candidate: toApiCaptureDocument(request.candidate),
        },
        { signal },
      )
      .pipe(
        map((response) =>
          this.rememberOperation(response, record.projectId, captureId),
        ),
      );
  }

  reportStreamingStructuringFailure(
    id: string,
    request: ReportStreamingStructuringFailureRequest,
    signal?: AbortSignal,
  ): Observable<CaptureOperationV2> {
    const captureId = opaqueCaptureId(id);
    const record = this.requireCapture(captureId);
    return this.api
      .reportStructuringFailure(
        record.projectId,
        captureId,
        {
          ...(request.clientRequestId === undefined
            ? {}
            : { clientRequestId: request.clientRequestId }),
          code: request.code,
          message: request.message,
        },
        { signal },
      )
      .pipe(
        map((response) =>
          this.rememberOperation(response, record.projectId, captureId),
        ),
      );
  }

  deleteStreamingCapture(
    id: string,
    signal?: AbortSignal,
  ): Observable<void> {
    const captureId = opaqueCaptureId(id);
    const record = this.requireCapture(captureId);
    return this.api.deleteCapture(record.projectId, captureId, { signal }).pipe(
      tap(() => this.captures.delete(captureId)),
    );
  }

  structure(request: CaptureStructuringRequest): Observable<CaptureDocumentV1> {
    return defer(() => {
      const capture = this.captureForSource(request.raw.source.sha256);
      const review = request.review ?? { reviewVersion: 1 as const, edits: [] };
      return this.api
        .structureCapture(
          capture.record.projectId,
          capture.captureId,
          {
            clientRequestId: capture.record.structuringRequestId,
            review: {
              reviewVersion: review.reviewVersion,
              edits: (review.edits ?? []).map((edit: CaptureReviewEditV1) => ({
                segmentId: edit.segmentId,
                reviewedText: edit.reviewedText,
              })),
            },
          },
          { signal: request.signal },
        )
        .pipe(
          map(mapCaptureDocument),
          tap(() => request.reportProgress(1)),
        );
    });
  }

  documentIdForSourceSha256(sourceSha256: string): string | null {
    const completedDocumentId = this.completedDocuments.get(sourceSha256);
    if (completedDocumentId !== undefined) return completedDocumentId;
    for (const record of [...this.captures.values()].reverse()) {
      if (record.sourceSha256 === sourceSha256) return record.documentId;
    }
    return this.latestDocumentId;
  }

  private rememberOperation(
    response: unknown,
    projectId: string,
    expectedCaptureId?: string,
    fallbackDocumentId?: string,
  ): CaptureOperationV2 {
    const decoded = mapCaptureOperation(response, expectedCaptureId);
    const responseRecord = record(response, 'capture operation');
    const documentId =
      responseRecord['documentId'] === undefined
        ? text(fallbackDocumentId, 'documentId')
        : text(responseRecord['documentId'], 'documentId');
    const existing = this.captures.get(decoded.captureId);
    const sourceSha256 = decoded.source?.sha256 ?? existing?.sourceSha256 ?? '';
    this.captures.set(decoded.captureId, {
      projectId,
      documentId,
      sourceSha256,
      structuringRequestId:
        existing?.structuringRequestId ?? structuringRequestId(decoded.captureId),
    });
    if (sourceSha256 !== '') {
      this.completedDocuments.set(sourceSha256, documentId);
    }
    this.latestDocumentId = documentId;
    return exactCaptureOperation(decoded);
  }

  private requireProjectId(): string {
    const projectId = this.projects.selectedProjectId();
    if (projectId === null || projectId.trim().length === 0) {
      throw new Error('Select a Cert Prep project before capturing a document.');
    }
    return projectId;
  }

  private requireCapture(id: string): CaptureRecord {
    const existing = this.captures.get(id);
    if (existing !== undefined) return existing;
    return {
      projectId: this.requireProjectId(),
      documentId: id,
      sourceSha256: '',
      structuringRequestId: structuringRequestId(id),
    };
  }

  private captureForSource(sourceSha256: string): {
    readonly captureId: string;
    readonly record: CaptureRecord;
  } {
    const captures = [...this.captures.entries()].reverse();
    const capture = captures.find(
      ([, record]) => record.sourceSha256 === sourceSha256,
    );
    if (capture === undefined) {
      throw new Error('Cert Prep capture state is unavailable for structuring.');
    }
    return { captureId: capture[0], record: capture[1] };
  }
}

function mapReady(response: ApiRuntimeReadyV1): RuntimeReadyV1 {
  if (response.service !== 'capture-runtime') {
    throw new Error('Cert Prep backend returned a non-Capture Runtime service.');
  }
  if (
    response.capabilities.supportsCancellation !== true ||
    response.capabilities.supportsRawDiagnostics !== true
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
      captureKinds: response.capabilities.captureKinds.filter(isSourceKind),
      structuringModes: response.capabilities.structuringModes.filter(
        isStructuringMode,
      ),
      supportsCancellation: true,
      supportsRawDiagnostics: true,
      maxUploadBytes: response.capabilities.maxUploadBytes,
    },
    message: response.message,
  };
}

function mapRequirement(
  requirement: ApiRuntimeRequirementV1,
): RuntimeRequirementV1 {
  return {
    requirementId:
      requirement.requirementId as RuntimeRequirementV1['requirementId'],
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

type UnknownRecord = Record<string, unknown>;

function mapCaptureDocument(value: unknown): CaptureDocumentV1 {
  const document = record(value, 'capture document');
  return {
    schemaVersion: literal(document, 'schemaVersion', '1'),
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

function mapCaptureOperation(
  value: unknown,
  expectedCaptureId?: string,
): CaptureOperationV2 {
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
    status: status as CaptureOperationV2['status'],
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

function mapPartialCapture(
  value: unknown,
  expectedCaptureId: string,
): PartialCaptureV2 {
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
    if (segment.order !== index) fail('partial segment order is not contiguous');
  });
  if (new Set(segments.map((segment) => segment.segmentId)).size !== segments.length) {
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

function mapCaptureStreamingResult(
  value: unknown,
  expectedCaptureId: string,
): CaptureStreamingResult {
  const composite = record(value, 'capture result');
  const operation = mapCaptureOperation(composite['operation'], expectedCaptureId);
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

function mapRawCapture(value: unknown): RawCaptureV1 {
  const raw = record(value, 'raw capture');
  const segments = nonEmptyArray(raw['segments'], 'segments').map(mapRawSegment);
  segments.forEach((segment, index) => {
    if (segment.order !== index) fail('raw segment order is not contiguous');
  });
  const sourceText = stringValue(raw['sourceText'], 'sourceText');
  if (sourceText !== segments.map((segment) => segment.text).join('\n')) {
    fail('raw sourceText does not match its segments');
  }
  return {
    schemaVersion: literal(raw, 'schemaVersion', '1'),
    diagnosticOnly: literal(raw, 'diagnosticOnly', true),
    source: mapSource(raw['source']),
    segments,
    sourceText,
    extractionEngine: mapEngine(raw['extractionEngine'], 'extractionEngine'),
    warnings: warnings(raw['warnings']),
    createdAt: timestamp(raw['createdAt'], 'createdAt'),
  };
}

function mapCaptureFailure(value: unknown): NonNullable<CaptureOperationV2['error']> {
  const failure = record(value, 'capture error');
  const code = pattern(failure['code'], 'error.code', /^[a-z][a-z0-9_]{1,63}$/u);
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

function mapSource(value: unknown): CaptureDocumentV1['source'] {
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
  left: CaptureDocumentV1['source'],
  right: CaptureDocumentV1['source'],
): boolean {
  return (
    left.sha256 === right.sha256 &&
    left.fileName === right.fileName &&
    left.mediaType === right.mediaType &&
    left.bytes === right.bytes
  );
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

function mapEngine(value: unknown, label: string): CaptureEngineV1 {
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

function record(value: unknown, label: string): UnknownRecord {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function nonEmptyArray(value: unknown, label: string): unknown[] {
  const result = array(value, label);
  if (result.length === 0) fail(`${label} must be a non-empty array`);
  return result;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  return value;
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
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/u.test(result) || Number.isNaN(Date.parse(result))) {
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

function exactCaptureOperation(
  operation: CaptureOperationV2,
): CaptureOperationV2 {
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

function toApiCaptureDocument(
  document: CaptureDocumentV1,
): ApiCaptureDocumentV1 {
  return {
    schemaVersion: document.schemaVersion,
    source: { ...document.source },
    rawSegments: document.rawSegments.map((segment: RawCaptureSegmentV1) => ({
      ...segment,
      locator: toApiLocator(segment.locator),
    })),
    blocks: document.blocks.map((block: CaptureBlockV1) => ({
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
  locator: RawCaptureSegmentV1['locator'],
): ApiCaptureDocumentV1['rawSegments'][number]['locator'] {
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

function captureEventsUrl(
  baseUrl: string,
  projectId: string,
  captureId: string,
): string {
  const base = baseUrl.replace(/\/+$/u, '');
  return `${base}/projects/${encodeURIComponent(projectId)}/capture-workbench/captures/${encodeURIComponent(captureId)}/events`;
}

function structuringRequestId(captureId: string): string {
  return `${captureId.slice(0, 118)}-structure`;
}

function opaqueCaptureId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    fail('captureId has an invalid format');
  }
  return value;
}

function isSourceKind(value: string): value is CaptureSourceKind {
  return value === 'pdf' || value === 'image' || value === 'audio';
}

function isStructuringMode(
  value: string,
): value is RuntimeReadyV1['capabilities']['structuringModes'][number] {
  return value === 'runtime' || value === 'host';
}

function assertCaptureAdmission(
  ready: RuntimeReadyV1,
  requirements: readonly RuntimeRequirementV1[],
  sourceKind: CaptureSourceKind,
): void {
  if (!ready['ready']) throw new Error('Capture Runtime is not ready.');
  assertCaptureRuntimeCompatible(ready, CAPTURE_RUNTIME_MAJOR, 'host');
  assertCaptureRuntimeMinorCompatible(ready.runtimeVersion);
  if (!ready['capabilities'].captureKinds.includes(sourceKind)) {
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
    version.trim().replace(/^v/iu, '').split('.')[1] ?? '',
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
  const detail =
    requirement?.detail ?? 'The runtime requirement is unavailable.';
  throw new Error(`${displayName} is unavailable. ${detail}`);
}
