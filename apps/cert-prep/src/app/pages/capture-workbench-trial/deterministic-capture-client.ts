import { Injectable } from '@angular/core';
import { of, throwError, type Observable } from 'rxjs';
import type {
  CaptureClient,
  CaptureDocumentV1,
  CaptureJobV1,
  CaptureSourceKind,
  CaptureSourceV1,
  CommitStructuredResultRequest,
  CreateCaptureRequest,
  RawCaptureV1,
  ReportStructuringFailureRequest,
  RuntimeInstallationV1,
  RuntimeReadyV1,
  RuntimeRequirementV1,
  StartRuntimeInstallationRequest,
} from '@gx-capture/capture-workbench';

const DEMO_TIMESTAMP = '2026-01-01T00:00:00.000Z';
const DEMO_DIGEST = `sha256:${'0'.repeat(64)}`;

const READY: RuntimeReadyV1 = {
  ready: true,
  service: 'capture-runtime',
  apiVersion: '1.0',
  runtimeVersion: 'trial-0.3.0',
  captureDocumentSchemaVersion: '1',
  capabilities: {
    captureKinds: ['pdf', 'image', 'audio'],
    structuringModes: ['runtime', 'host'],
    supportsCancellation: true,
    supportsRawDiagnostics: true,
    maxUploadBytes: 25_000_000,
  },
  message: 'Deterministic in-memory trial client.',
};

/**
 * A backend-free CaptureClient used only by the distribution trial route.
 * It intentionally keeps all jobs and results in memory and completes each
 * capture immediately so the Web Component workflow can be exercised without
 * a runtime process, token, API endpoint, or persistence layer.
 */
@Injectable()
export class DeterministicCaptureClient implements CaptureClient {
  private nextCaptureNumber = 1;
  private readonly jobs = new Map<string, CaptureJobV1>();
  private readonly results = new Map<string, CaptureDocumentV1>();

  getReady(): Observable<RuntimeReadyV1> {
    return of(READY);
  }

  getRequirements(): Observable<readonly RuntimeRequirementV1[]> {
    return of([]);
  }

  startInstallation(
    request: StartRuntimeInstallationRequest,
  ): Observable<RuntimeInstallationV1> {
    const timestamp = DEMO_TIMESTAMP;
    return of({
      installationId: `trial-installation-${request.requirementId}`,
      requirementId: request.requirementId,
      status: 'completed',
      progress: 1,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp,
    });
  }

  listInstallations(): Observable<readonly RuntimeInstallationV1[]> {
    return of([]);
  }

  getInstallation(id: string): Observable<RuntimeInstallationV1> {
    return throwError(() => new Error(`Unknown trial installation: ${id}`));
  }

  cancelInstallation(id: string): Observable<RuntimeInstallationV1> {
    return throwError(() => new Error(`Unknown trial installation: ${id}`));
  }

  createCapture(request: CreateCaptureRequest): Observable<CaptureJobV1> {
    const captureId = `trial-capture-${this.nextCaptureNumber++}`;
    const source = this.sourceFor(request.file, request.sourceKind);
    const job = this.job(captureId, 'completed', 'completed', source);
    const document = this.documentFor(source, request.sourceKind);
    this.jobs.set(captureId, job);
    this.results.set(captureId, document);
    return of(job);
  }

  getCapture(id: string): Observable<CaptureJobV1> {
    return this.knownJob(id);
  }

  cancelCapture(id: string): Observable<CaptureJobV1> {
    const current = this.jobs.get(id);
    if (!current) return this.unknownCapture(id);
    const cancelled = this.job(
      id,
      'cancelled',
      'cancelled',
      current.source ?? undefined,
    );
    this.jobs.set(id, cancelled);
    return of(cancelled);
  }

  getRaw(id: string): Observable<RawCaptureV1> {
    const document = this.results.get(id);
    if (!document) return this.unknownCapture(id);
    return of({
      schemaVersion: '1',
      diagnosticOnly: true,
      source: document.source,
      segments: document.rawSegments,
      sourceText: document.sourceText,
      extractionEngine: document.extractionEngine,
      warnings: document.warnings,
      createdAt: document.createdAt,
    });
  }

  getResult(id: string): Observable<CaptureDocumentV1> {
    const document = this.results.get(id);
    return document
      ? of(document)
      : throwError(() => new Error(`Unknown trial capture: ${id}`));
  }

  commitStructuredResult(
    id: string,
    request: CommitStructuredResultRequest,
  ): Observable<CaptureJobV1> {
    const current = this.jobs.get(id);
    if (!current) return this.unknownCapture(id);
    this.results.set(id, request.candidate);
    const completed = this.job(
      id,
      'completed',
      'completed',
      request.candidate.source,
    );
    this.jobs.set(id, completed);
    return of(completed);
  }

  reportStructuringFailure(
    id: string,
    request: ReportStructuringFailureRequest,
  ): Observable<CaptureJobV1> {
    void request;
    const current = this.jobs.get(id);
    if (!current) return this.unknownCapture(id);
    const failed = this.job(
      id,
      'failed',
      'failed',
      current.source ?? undefined,
    );
    this.jobs.set(id, failed);
    return of(failed);
  }

  deleteCapture(id: string): Observable<void> {
    this.jobs.delete(id);
    this.results.delete(id);
    return of(undefined);
  }

  private knownJob(id: string): Observable<CaptureJobV1> {
    const job = this.jobs.get(id);
    return job ? of(job) : this.unknownCapture(id);
  }

  private unknownCapture<T>(id: string): Observable<T> {
    return throwError(() => new Error(`Unknown trial capture: ${id}`));
  }

  private sourceFor(
    file: File,
    sourceKind: CaptureSourceKind,
  ): CaptureSourceV1 {
    return {
      sha256: '0'.repeat(64),
      fileName: file.name,
      mediaType: file.type || mediaTypeFor(sourceKind),
      bytes: file.size,
    };
  }

  private job(
    captureId: string,
    status: CaptureJobV1['status'],
    stage: CaptureJobV1['stage'],
    source?: CaptureSourceV1,
  ): CaptureJobV1 {
    return {
      captureId,
      status,
      stage,
      structuringMode: 'runtime',
      progress: status === 'completed' ? 1 : 0,
      source: source ?? null,
      error: null,
      createdAt: DEMO_TIMESTAMP,
      updatedAt: DEMO_TIMESTAMP,
      completedAt: status === 'completed' ? DEMO_TIMESTAMP : null,
    };
  }

  private documentFor(
    source: CaptureSourceV1,
    sourceKind: CaptureSourceKind,
  ): CaptureDocumentV1 {
    const segmentText = `Demo capture: ${source.fileName}`;
    const segment = {
      segmentId: 'trial-segment-1',
      order: 0,
      locator:
        sourceKind === 'audio'
          ? { kind: 'time' as const, startMs: 0, endMs: 1000 }
          : { kind: 'page' as const, page: 1 },
      text: segmentText,
    };
    return {
      schemaVersion: '1',
      source,
      rawSegments: [segment],
      blocks: [
        {
          blockId: 'trial-block-1',
          order: 0,
          sourceSegmentId: segment.segmentId,
          type: 'paragraph',
          locator: segment.locator,
          sourceText: segmentText,
          targetText: `繁體中文試用結果：${source.fileName}`,
        },
      ],
      sourceText: segmentText,
      targetText: `繁體中文試用結果：${source.fileName}`,
      extractionEngine: {
        engine: 'capture-workbench-trial',
        model: 'deterministic-memory',
        digest: DEMO_DIGEST,
        device: null,
      },
      structuringEngine: {
        engine: 'capture-workbench-trial',
        model: 'deterministic-memory',
        digest: DEMO_DIGEST,
        device: null,
      },
      warnings: ['Trial result generated in memory; no backend was used.'],
      createdAt: DEMO_TIMESTAMP,
      completedAt: DEMO_TIMESTAMP,
    };
  }
}

function mediaTypeFor(sourceKind: CaptureSourceKind): string {
  switch (sourceKind) {
    case 'image':
      return 'image/png';
    case 'audio':
      return 'audio/mpeg';
    default:
      return 'application/pdf';
  }
}
