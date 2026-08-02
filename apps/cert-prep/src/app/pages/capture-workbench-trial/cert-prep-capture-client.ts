import { inject, Injectable } from '@angular/core';
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
import { assertCaptureRuntimeCompatible } from '@gx-capture/capture-workbench';
import type {
  CaptureClient,
  ConfirmCaptureRequest,
  CaptureDocumentV1,
  CaptureFailureV1,
  CaptureJobV1,
  CaptureJobStage,
  CaptureJobStatus,
  CaptureSourceKind,
  CommitStructuredResultRequest,
  CreateCaptureRequest,
  RawCaptureV1,
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
      .pipe(map((raw) => raw as unknown as RawCaptureV1));
  }

  getResult(id: string, signal?: AbortSignal): Observable<CaptureDocumentV1> {
    const record = this.requireCapture(id);
    return this.api
      .getResult(record.projectId, id, { signal })
      .pipe(map((document) => document as unknown as CaptureDocumentV1));
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
      supportsCancellation: response.capabilities.supportsCancellation,
      supportsRawDiagnostics: response.capabilities.supportsRawDiagnostics,
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
  assertCaptureRuntimeCompatible(ready, 0, 'host');
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
