import { inject, Injectable } from '@angular/core';
import { defer, forkJoin, map, switchMap, tap, type Observable } from 'rxjs';
import type {
  CaptureClient,
  CaptureDocument,
  CaptureEventStreamOptions,
  CaptureEvent,
  CaptureOperation,
  CaptureReviewEdit,
  CaptureSourceKind,
  CaptureStreamingResult,
  CaptureStructuringProvider,
  CaptureStructuringRequest,
  CommitStreamingStructuredResultRequest,
  PartialCapture,
  RawCapture,
  ReportStreamingStructuringFailureRequest,
  RuntimeInstallation,
  RuntimeReady,
  RuntimeRequirement,
  StartRuntimeInstallationRequest,
  StartStreamingCaptureRequest,
} from '@gx-capture/capture-workbench-ui';
import {
  assertCaptureRuntimeCompatible,
  CAPTURE_RUNTIME_MAJOR,
} from '@gx-capture/capture-workbench-ui';
import { CERT_PREP_API } from '../../core/data';
import { CertPrepRuntimeConfig } from '../../core/data';
import { ProjectStore } from '../../projects/data';
import { certPrepCaptureEventStream } from './cert-prep-capture-event-stream';
import {
  array,
  assertCaptureRuntimeMinorCompatible,
  assertRequirementReady,
  exactCaptureOperation,
  fail,
  mapCaptureDocument,
  mapCaptureOperation,
  mapCaptureStreamingResult,
  mapInstallation,
  mapPartialCapture,
  mapRawCapture,
  mapReady,
  mapRequirement,
  opaqueCaptureId,
  record,
  text,
  toApiCaptureDocument,
} from './cert-prep-capture-protocol';
import type { CaptureRecord, CaptureRuntimeReady } from '../domain';

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

  getReady(signal?: AbortSignal): Observable<CaptureRuntimeReady> {
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
  ): Observable<readonly RuntimeRequirement[]> {
    return this.api
      .captureRuntimeRequirements({ signal })
      .pipe(map((response) => response.items.map(mapRequirement)));
  }

  startInstallation(
    request: StartRuntimeInstallationRequest,
    signal?: AbortSignal,
  ): Observable<RuntimeInstallation> {
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
  ): Observable<readonly RuntimeInstallation[]> {
    return this.api
      .captureRuntimeInstallations({ signal })
      .pipe(map((response) => response.items.map(mapInstallation)));
  }

  getInstallation(
    id: string,
    signal?: AbortSignal,
  ): Observable<RuntimeInstallation> {
    return this.api
      .captureRuntimeInstallation(id, { signal })
      .pipe(map(mapInstallation));
  }

  cancelInstallation(
    id: string,
    signal?: AbortSignal,
  ): Observable<RuntimeInstallation> {
    return this.api
      .cancelCaptureRuntimeInstallation(id, { signal })
      .pipe(map(mapInstallation));
  }

  captureEvents(
    id: string,
    options: CaptureEventStreamOptions = {},
  ): Observable<CaptureEvent> {
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
  ): Observable<CaptureOperation> {
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
  ): Observable<CaptureOperation> {
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
  ): Observable<CaptureOperation> {
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
  ): Observable<PartialCapture> {
    const captureId = opaqueCaptureId(id);
    const record = this.requireCapture(captureId);
    return this.api
      .getPartial(record.projectId, captureId, { signal })
      .pipe(map((response) => mapPartialCapture(response, captureId)));
  }

  getStreamingRaw(id: string, signal?: AbortSignal): Observable<RawCapture> {
    const captureId = opaqueCaptureId(id);
    const record = this.requireCapture(captureId);
    return this.api
      .getRaw(record.projectId, captureId, { signal })
      .pipe(map(mapRawCapture));
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
  ): Observable<CaptureOperation> {
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
  ): Observable<CaptureOperation> {
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

  deleteStreamingCapture(id: string, signal?: AbortSignal): Observable<void> {
    const captureId = opaqueCaptureId(id);
    const record = this.requireCapture(captureId);
    return this.api
      .deleteCapture(record.projectId, captureId, { signal })
      .pipe(tap(() => this.captures.delete(captureId)));
  }

  structure(request: CaptureStructuringRequest): Observable<CaptureDocument> {
    return defer(() => {
      const capture = this.captureForSource(request.raw.source.sha256);
      const review = request.review ?? { reviewVersion: 2 as const, edits: [] };
      return this.api
        .structureCapture(
          capture.record.projectId,
          capture.captureId,
          {
            clientRequestId: capture.record.structuringRequestId,
            review: {
              // The published workbench currently emits reviewVersion 1.
              // Cert Prep's backend host envelope is v2; the review edit
              // semantics are unchanged, so translate at this adapter
              // boundary instead of leaking the UI protocol version to the
              // backend contract.
              reviewVersion: 2,
              edits: (review.edits ?? []).map((edit: CaptureReviewEdit) => ({
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
  ): CaptureOperation {
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
        existing?.structuringRequestId ??
        structuringRequestId(decoded.captureId),
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
      throw new Error(
        'Select a Cert Prep project before capturing a document.',
      );
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
      throw new Error(
        'Cert Prep capture state is unavailable for structuring.',
      );
    }
    return { captureId: capture[0], record: capture[1] };
  }
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

// Kept in the client: release tooling pins this compatibility gate to this file.
function assertCaptureAdmission(
  ready: RuntimeReady,
  requirements: readonly RuntimeRequirement[],
  sourceKind: CaptureSourceKind,
): void {
  if (!ready['ready']) throw new Error('Capture Runtime is not ready.');
  assertCaptureRuntimeCompatible(ready, CAPTURE_RUNTIME_MAJOR, 'host');
  assertCaptureRuntimeMinorCompatible(ready.runtimeVersion);
  const capabilities = record(ready['capabilities'], 'capabilities');
  const captureKinds = array(
    capabilities['captureKinds'],
    'capabilities.captureKinds',
  );
  if (!captureKinds.includes(sourceKind)) {
    throw new Error(
      `Capture Runtime does not support ${sourceKind.toUpperCase()} capture.`,
    );
  }
  if (sourceKind === 'pdf' || sourceKind === 'image') {
    assertRequirementReady(requirements, 'windowsml-ocr', 'WindowsML OCR');
  }
  if (sourceKind === 'audio') {
    assertRequirementReady(
      requirements,
      'speech-recognition',
      'Speech recognition',
    );
  }
}
