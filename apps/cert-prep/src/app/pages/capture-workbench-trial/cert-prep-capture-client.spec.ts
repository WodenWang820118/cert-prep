import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { CertPrepGeneratedClient } from '@cert-prep/api';
import { firstValueFrom, of, throwError } from 'rxjs';
import type {
  CaptureLocatorV1,
  RawCaptureSegmentV1,
  RawCaptureV1,
} from '@gx-capture/capture-workbench';
import { CERT_PREP_API } from '../../constants/cert-prep-api.constants';
import { ProjectStore } from '../../stores/project.store';
import { CertPrepCaptureClient } from './cert-prep-capture-client';

const TEST_PROJECT_ID = 'project-1';

type ApiMocks = {
  captureRuntimeReady: ReturnType<typeof vi.fn>;
  captureRuntimeRequirements: ReturnType<typeof vi.fn>;
  getDocumentMarkdown: ReturnType<typeof vi.fn>;
  createCapture: ReturnType<typeof vi.fn>;
  getCapture: ReturnType<typeof vi.fn>;
  getRaw: ReturnType<typeof vi.fn>;
  confirmCapture: ReturnType<typeof vi.fn>;
  cancelCapture: ReturnType<typeof vi.fn>;
  getResult: ReturnType<typeof vi.fn>;
};

describe('CertPrepCaptureClient', () => {
  const job = makeJob();
  const raw = makeRaw();
  const result = makeResult();
  const selectedProjectId = signal<string | null>(TEST_PROJECT_ID);
  let api: ApiMocks;
  let client: CertPrepCaptureClient;

  beforeEach(() => {
    api = {
      captureRuntimeReady: vi.fn().mockReturnValue(
        of({
          ready: true,
          service: 'capture-runtime',
          apiVersion: '1.0',
          runtimeVersion: '0.3.10',
          captureDocumentSchemaVersion: '1',
          capabilities: {
            captureKinds: ['pdf'],
            structuringModes: ['host'],
            supportsCancellation: true,
            supportsRawDiagnostics: true,
            maxUploadBytes: 50_000_000,
          },
        }),
      ),
      captureRuntimeRequirements: vi.fn().mockReturnValue(of({ items: [] })),
      getDocumentMarkdown: vi.fn().mockReturnValue(of(new Blob(['# scan']))),
      createCapture: vi.fn().mockReturnValue(of(job)),
      getCapture: vi.fn().mockReturnValue(of(job)),
      getRaw: vi.fn().mockReturnValue(of(raw)),
      confirmCapture: vi.fn().mockReturnValue(of(job)),
      cancelCapture: vi.fn().mockReturnValue(of(job)),
      getResult: vi.fn().mockReturnValue(of(result)),
    };
    TestBed.configureTestingModule({
      providers: [
        CertPrepCaptureClient,
        {
          provide: CERT_PREP_API,
          useValue: api as unknown as CertPrepGeneratedClient,
        },
        { provide: ProjectStore, useValue: { selectedProjectId } },
      ],
    });
    client = TestBed.inject(CertPrepCaptureClient);
  });

  it('uploads once through the review capture API without sidecar credentials', async () => {
    const signalController = new AbortController();
    const file = new File(['pdf'], 'scan.pdf', { type: 'application/pdf' });

    const mappedJob = await firstValueFrom(
      client.createCapture({
        clientRequestId: 'request-1',
        file,
        sourceKind: 'pdf',
        structuringMode: 'host',
        signal: signalController.signal,
      }),
    );

    expect(api.createCapture).toHaveBeenCalledWith(
      TEST_PROJECT_ID,
      expect.any(FormData),
      {
        headers: { 'X-Cert-Prep-Operation-Id': 'request-1' },
        signal: signalController.signal,
      },
    );
    const body = api.createCapture.mock.calls[0]?.[1] as FormData;
    expect((body.get('file') as File).name).toBe('scan.pdf');
    expect(JSON.stringify(api.createCapture.mock.calls)).not.toContain(
      'Authorization',
    );
    expect(mappedJob).toMatchObject({
      captureId: job.captureId,
      status: 'running',
      stage: 'awaiting_structuring',
      structuringMode: 'host',
    });
  });

  it('confirms only the capture id and reviewed text overlay', async () => {
    await firstValueFrom(
      client.createCapture({
        clientRequestId: 'request-2',
        file: new File(['pdf'], 'scan.pdf', { type: 'application/pdf' }),
        sourceKind: 'pdf',
        structuringMode: 'host',
      }),
    );

    await firstValueFrom(
      client.confirmCapture(
        job.captureId,
        {
          clientRequestId: 'confirm-2',
          review: {
            reviewVersion: 1,
            edits: [{ segmentId: 'segment-1', reviewedText: 'corrected' }],
          },
        },
        new AbortController().signal,
      ),
    );

    expect(api.confirmCapture).toHaveBeenCalledWith(
      TEST_PROJECT_ID,
      job.captureId,
      {
        clientRequestId: 'confirm-2',
        review: {
          reviewVersion: 1,
          edits: [{ segmentId: 'segment-1', reviewedText: 'corrected' }],
        },
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(JSON.stringify(api.confirmCapture.mock.calls)).not.toContain(
      'Authorization',
    );
  });

  it('keeps the durable document mapping after the UI task is deleted', async () => {
    await firstValueFrom(
      client.createCapture({
        clientRequestId: 'request-delete',
        file: new File(['pdf'], 'scan.pdf', { type: 'application/pdf' }),
        sourceKind: 'pdf',
        structuringMode: 'host',
      }),
    );

    await firstValueFrom(client.deleteCapture(job.captureId));

    expect(client.documentIdForSourceSha256(job.source.sha256)).toBe(
      job.documentId,
    );
  });

  it('hands off the latest single-PDF document when browser and backend digests differ', async () => {
    await firstValueFrom(
      client.createCapture({
        clientRequestId: 'request-digest-fallback',
        file: new File(['pdf'], 'scan.pdf', { type: 'application/pdf' }),
        sourceKind: 'pdf',
        structuringMode: 'host',
      }),
    );

    expect(client.documentIdForSourceSha256('b'.repeat(64))).toBe(
      job.documentId,
    );
  });

  it('maps readiness and forwards the browser abort signal to the backend proxy', async () => {
    const signalController = new AbortController();
    const ready = await firstValueFrom(client.getReady(signalController.signal));

    expect(ready).toMatchObject({
      service: 'capture-runtime',
      runtimeVersion: '0.3.10',
      capabilities: { captureKinds: ['pdf'], structuringModes: ['host'] },
    });
    expect(api.captureRuntimeReady).toHaveBeenCalledWith({
      signal: signalController.signal,
    });
    expect(JSON.stringify(api.captureRuntimeReady.mock.calls)).not.toContain(
      'Authorization',
    );
  });

  it('passes core-only unavailable requirements through to the published component', async () => {
    const detail = 'No downloadable model is published for this runtime release.';
    api.captureRuntimeRequirements.mockReturnValueOnce(
      of({
        items: [
          {
            requirementId: 'windowsml-ocr',
            kind: 'ocr',
            displayName: 'WindowsML OCR',
            status: 'unavailable',
            requiredFor: ['pdf', 'image'],
            installStrategy: 'unavailable',
            detail,
            artifact: null,
          },
          {
            requirementId: 'whisper-primary',
            kind: 'speech-to-text',
            displayName: 'Whisper',
            status: 'unavailable',
            requiredFor: ['audio'],
            installStrategy: 'unavailable',
            detail,
            artifact: null,
          },
        ],
      }),
    );

    await expect(firstValueFrom(client.getRequirements())).resolves.toEqual([
      expect.objectContaining({
        requirementId: 'windowsml-ocr',
        status: 'unavailable',
        detail,
      }),
      expect.objectContaining({
        requirementId: 'whisper-primary',
        status: 'unavailable',
        detail,
      }),
    ]);
    expect(api.captureRuntimeRequirements).toHaveBeenCalledWith({
      signal: undefined,
    });
  });

  it('dispatches an embedded-text PDF through the backend despite unavailable OCR and Whisper requirements', async () => {
    const detail = 'No downloadable model is published for this runtime release.';
    api.captureRuntimeRequirements.mockReturnValueOnce(
      of({
        items: [
          unavailableRequirement('windowsml-ocr', ['pdf', 'image'], detail),
          unavailableRequirement('whisper-primary', ['audio'], detail),
        ],
      }),
    );
    const signalController = new AbortController();

    await expect(
      firstValueFrom(
        client.createCapture({
          clientRequestId: 'embedded-text-pdf',
          file: new File(['embedded text'], 'embedded-text.pdf', {
            type: 'application/pdf',
          }),
          sourceKind: 'pdf',
          structuringMode: 'host',
          signal: signalController.signal,
        }),
      ),
    ).resolves.toMatchObject({ captureId: job.captureId });

    expect(api.captureRuntimeReady).toHaveBeenCalledWith({
      signal: signalController.signal,
    });
    expect(api.captureRuntimeRequirements).toHaveBeenCalledWith({
      signal: signalController.signal,
    });
    expect(api.createCapture).toHaveBeenCalledTimes(1);
  });

  it('rejects an image before create when WindowsML is unavailable', async () => {
    api.captureRuntimeReady.mockReturnValueOnce(of(readyResponse({})));
    api.captureRuntimeRequirements.mockReturnValueOnce(
      of({
        items: [
          unavailableRequirement('windowsml-ocr', ['pdf', 'image']),
          readyRequirement('whisper-primary', ['audio']),
        ],
      }),
    );

    await expect(
      firstValueFrom(
        client.createCapture({
          clientRequestId: 'blocked-image',
          file: new File(['png'], 'blocked.png', { type: 'image/png' }),
          sourceKind: 'image',
          structuringMode: 'host',
        }),
      ),
    ).rejects.toThrow('WindowsML OCR is unavailable');

    expect(api.createCapture).not.toHaveBeenCalled();
  });

  it('rejects audio before create when Whisper is unavailable', async () => {
    api.captureRuntimeReady.mockReturnValueOnce(of(readyResponse({})));
    api.captureRuntimeRequirements.mockReturnValueOnce(
      of({
        items: [
          readyRequirement('windowsml-ocr', ['pdf', 'image']),
          unavailableRequirement('whisper-primary', ['audio']),
        ],
      }),
    );

    await expect(
      firstValueFrom(
        client.createCapture({
          clientRequestId: 'blocked-audio',
          file: new File(['audio'], 'blocked.mp3', { type: 'audio/mpeg' }),
          sourceKind: 'audio',
          structuringMode: 'host',
        }),
      ),
    ).rejects.toThrow('Whisper transcription is unavailable');

    expect(api.createCapture).not.toHaveBeenCalled();
  });

  it.each([
    ['not ready', { ready: false }, 'not ready'],
    ['wrong service', { service: 'other-runtime' }, 'non-Capture Runtime service'],
    [
      'unsupported runtime major',
      { runtimeVersion: '1.0.0' },
      'incompatible with client runtime major',
    ],
    [
      'unsupported runtime minor',
      { runtimeVersion: '0.2.8' },
      'incompatible with client runtime minor 3',
    ],
    ['unsupported API major', { apiVersion: '2.0' }, 'Capture API 2.0 is incompatible'],
    ['wrong schema', { captureDocumentSchemaVersion: '2' }, 'schema'],
    [
      'missing host structuring',
      { capabilities: { ...readyCapabilities(), structuringModes: ['runtime'] } },
      'host structuring',
    ],
    [
      'missing PDF capability',
      { capabilities: { ...readyCapabilities(), captureKinds: ['image'] } },
      'does not support PDF capture',
    ],
  ])('rejects $0 before create', async (_label, override, expectedError) => {
    api.captureRuntimeReady.mockReturnValueOnce(of(readyResponse(override)));

    await expect(
      firstValueFrom(
        client.createCapture({
          clientRequestId: `incompatible-${_label}`,
          file: new File(['pdf'], 'embedded-text.pdf', {
            type: 'application/pdf',
          }),
          sourceKind: 'pdf',
          structuringMode: 'host',
        }),
      ),
    ).rejects.toThrow(expectedError);

    expect(api.createCapture).not.toHaveBeenCalled();
  });

  it('downloads Markdown through cert-prep without exposing sidecar credentials', async () => {
    const signalController = new AbortController();
    const markdown = await firstValueFrom(
      client.getDocumentMarkdown(
        TEST_PROJECT_ID,
        job.documentId,
        signalController.signal,
      ),
    );

    expect(markdown).toBeInstanceOf(Blob);
    expect(api.getDocumentMarkdown).toHaveBeenCalledWith(
      TEST_PROJECT_ID,
      job.documentId,
      { signal: signalController.signal },
    );
    expect(JSON.stringify(api.getDocumentMarkdown.mock.calls)).not.toContain(
      'Authorization',
    );
  });

  it('maps backend raw and committed CaptureDocumentV1 projections', async () => {
    await firstValueFrom(
      client.createCapture({
        clientRequestId: 'request-3',
        file: new File(['pdf'], 'scan.pdf', { type: 'application/pdf' }),
        sourceKind: 'pdf',
        structuringMode: 'host',
      }),
    );

    const rawProjection = await firstValueFrom(client.getRaw(job.captureId));
    const resultProjection = await firstValueFrom(
      client.getResult(job.captureId),
    );

    expect(rawProjection).toMatchObject({
      diagnosticOnly: true,
      sourceText: 'Recognized OCR text',
      segments: [{ text: 'Recognized OCR text' }],
    });
    expect(resultProjection).toMatchObject({
      sourceText: 'Recognized OCR text',
      targetText: 'Recognized OCR text',
      structuringEngine: { engine: 'cert-prep-host-structuring' },
      blocks: [{ type: 'paragraph', targetText: 'Recognized OCR text' }],
    });
  });

  it('maps time locators and page bounding boxes without trusting API casts', async () => {
    const rawWithTimeLocator = makeRaw();
    rawWithTimeLocator.segments[0].locator = {
      kind: 'time',
      startMs: 10,
      endMs: 20,
    };
    api.getRaw.mockReturnValueOnce(of(rawWithTimeLocator));

    await expect(firstValueFrom(client.getRaw('capture-1'))).resolves.toMatchObject({
      segments: [{ locator: { kind: 'time', startMs: 10, endMs: 20 } }],
    });

    const rawWithBoundingBox = makeRaw();
    rawWithBoundingBox.segments[0].locator = {
      kind: 'page',
      page: 1,
      boundingBox: [0, 1, 100, 200],
    };
    api.getRaw.mockReturnValueOnce(of(rawWithBoundingBox));

    await expect(firstValueFrom(client.getRaw('capture-1'))).resolves.toMatchObject({
      segments: [{ locator: { kind: 'page', boundingBox: [0, 1, 100, 200] } }],
    });
  });

  it.each([
    ['raw schema version', () => ({ ...makeRaw(), schemaVersion: '2' })],
    [
      'unknown locator kind',
      () => ({
        ...makeRaw(),
        segments: [{ ...makeRaw().segments[0], locator: { kind: 'line', page: 1 } }],
      }),
    ],
    [
      'invalid document block type',
      () => ({
        ...makeResult(),
        blocks: [{ ...makeResult().blocks[0], type: 'unknown' }],
      }),
    ],
  ])('rejects %s at the API boundary', async (_label, payload) => {
    if (_label === 'invalid document block type') {
      api.getResult.mockReturnValueOnce(of(payload()));
      await expect(firstValueFrom(client.getResult('capture-1'))).rejects.toThrow(
        'invalid contract',
      );
      return;
    }
    api.getRaw.mockReturnValueOnce(of(payload()));
    await expect(firstValueFrom(client.getRaw('capture-1'))).rejects.toThrow(
      'invalid contract',
    );
  });

  it('cancels processing through cert-prep and fails closed for browser-owned structuring', async () => {
    await firstValueFrom(
      client.createCapture({
        clientRequestId: 'request-4',
        file: new File(['pdf'], 'scan.pdf', { type: 'application/pdf' }),
        sourceKind: 'pdf',
        structuringMode: 'host',
      }),
    );

    await firstValueFrom(client.cancelCapture(job.captureId));
    expect(api.cancelCapture).toHaveBeenCalledWith(
      TEST_PROJECT_ID,
      job.captureId,
      { signal: undefined },
    );
    await expect(
      firstValueFrom(
        client.commitStructuredResult(job.captureId, {
          clientRequestId: 'request-4',
          candidate: {} as never,
        }),
      ),
    ).rejects.toThrow('owned by the cert-prep backend coordinator');
  });

  it('surfaces backend status failures without converting them into fake success', async () => {
    api.getCapture.mockReturnValueOnce(
      throwError(() => new Error('backend unavailable')),
    );
    await firstValueFrom(
      client.createCapture({
        clientRequestId: 'request-5',
        file: new File(['pdf'], 'scan.pdf', { type: 'application/pdf' }),
        sourceKind: 'pdf',
        structuringMode: 'host',
      }),
    );

    await expect(firstValueFrom(client.getCapture(job.captureId))).rejects.toThrow(
      'backend unavailable',
    );
  });
});

function makeJob() {
  return {
    captureId: 'capture-1',
    documentId: 'document-1',
    status: 'running',
    stage: 'awaiting_structuring',
    structuringMode: 'host',
    progress: 0.7,
    source: {
      sha256: 'a'.repeat(64),
      fileName: 'scan.pdf',
      mediaType: 'application/pdf',
      bytes: 3,
    },
    error: null,
    createdAt: '2026-07-23T10:00:00.000Z',
    updatedAt: '2026-07-23T10:00:01.000Z',
    completedAt: null,
  };
}

type MutableRawCaptureFixture = Omit<RawCaptureV1, 'segments'> & {
  segments: Array<
    Omit<RawCaptureSegmentV1, 'locator'> & { locator: CaptureLocatorV1 }
  >;
};

function makeRaw(): MutableRawCaptureFixture {
  return {
    schemaVersion: '1',
    diagnosticOnly: true,
    source: makeJob().source,
    segments: [
      {
        segmentId: 'segment-1',
        order: 0,
        locator: { kind: 'page', page: 1 },
        text: 'Recognized OCR text',
      },
    ],
    sourceText: 'Recognized OCR text',
    extractionEngine: {
      engine: 'windowsml_ocr',
      model: 'capture-runtime@0.3.10',
      digest: `sha256:${'a'.repeat(64)}`,
      device: 'WindowsML',
    },
    warnings: [],
    createdAt: '2026-07-23T10:00:00.000Z',
  };
}

function makeResult() {
  return {
    schemaVersion: '1',
    source: makeJob().source,
    rawSegments: makeRaw().segments,
    blocks: [
      {
        blockId: 'block-segment-1',
        order: 0,
        type: 'paragraph',
        sourceSegmentId: 'segment-1',
        locator: { kind: 'page', page: 1 },
        sourceText: 'Recognized OCR text',
        targetText: 'Recognized OCR text',
      },
    ],
    sourceText: 'Recognized OCR text',
    targetText: 'Recognized OCR text',
    extractionEngine: makeRaw().extractionEngine,
    structuringEngine: {
      engine: 'cert-prep-host-structuring',
      model: 'cert-prep-backend',
      digest: `sha256:${'a'.repeat(64)}`,
      device: null,
    },
    warnings: [],
    createdAt: '2026-07-23T10:00:00.000Z',
    completedAt: '2026-07-23T10:00:02.000Z',
  };
}

function readyCapabilities() {
  return {
    captureKinds: ['pdf', 'image', 'audio'],
    structuringModes: ['host'],
    supportsCancellation: true,
    supportsRawDiagnostics: true,
    maxUploadBytes: 50_000_000,
  };
}

function readyResponse(override: Record<string, unknown>) {
  const base = {
    ready: true,
    service: 'capture-runtime',
    apiVersion: '1.0',
    runtimeVersion: '0.3.10',
    captureDocumentSchemaVersion: '1',
    capabilities: readyCapabilities(),
  };
  return {
    ...base,
    ...override,
    capabilities: {
      ...base.capabilities,
      ...(override['capabilities'] as Record<string, unknown> | undefined),
    },
  };
}

function unavailableRequirement(
  requirementId: 'windowsml-ocr' | 'whisper-primary',
  requiredFor: readonly string[],
  detail = 'No downloadable model is published for this runtime release.',
) {
  return {
    requirementId,
    kind: requirementId === 'windowsml-ocr' ? 'ocr' : 'speech-to-text',
    displayName:
      requirementId === 'windowsml-ocr' ? 'WindowsML OCR' : 'Whisper transcription',
    status: 'unavailable',
    requiredFor,
    installStrategy: 'runtime-catalog',
    detail,
    artifact: null,
  };
}

function readyRequirement(
  requirementId: 'windowsml-ocr' | 'whisper-primary',
  requiredFor: readonly string[],
) {
  return {
    ...unavailableRequirement(requirementId, requiredFor),
    status: 'ready',
    detail: null,
  };
}
