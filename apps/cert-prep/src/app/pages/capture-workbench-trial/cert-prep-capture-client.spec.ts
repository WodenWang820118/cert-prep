import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { CertPrepGeneratedClient } from '@cert-prep/api';
import { CAPTURE_RUNTIME_VERSION } from '@cert-prep/capture-runtime-version';
import { firstValueFrom, lastValueFrom, of, throwError, toArray } from 'rxjs';
import type {
  CaptureDocumentV1,
  CaptureStructuringRequest,
} from '@gx-capture/capture-workbench';
import { CERT_PREP_API } from '../../constants/cert-prep-api.constants';
import { CertPrepRuntimeConfig } from '../../services/cert-prep-api.service';
import { ProjectStore } from '../../stores/project.store';
import { CertPrepCaptureClient } from './cert-prep-capture-client';

const TEST_PROJECT_ID = 'project-1';
const TEST_BACKEND_TOKEN = 'backend-token';

type ApiMocks = Record<
  | 'captureRuntimeReady'
  | 'captureRuntimeRequirements'
  | 'getDocumentMarkdown'
  | 'createCapture'
  | 'getCapture'
  | 'deleteCapture'
  | 'getPartial'
  | 'structureCapture'
  | 'commitCapture'
  | 'reportStructuringFailure'
  | 'cancelCapture'
  | 'getResult',
  ReturnType<typeof vi.fn>
>;

describe('CertPrepCaptureClient streaming v2 seam', () => {
  const selectedProjectId = signal<string | null>(TEST_PROJECT_ID);
  let api: ApiMocks;
  let client: CertPrepCaptureClient;

  beforeEach(() => {
    api = {
      captureRuntimeReady: vi.fn().mockReturnValue(of(readyResponse({}))),
      captureRuntimeRequirements: vi.fn().mockReturnValue(of({ items: [] })),
      getDocumentMarkdown: vi.fn().mockReturnValue(of(new Blob(['# scan']))),
      createCapture: vi.fn().mockReturnValue(of(makeOperation())),
      getCapture: vi.fn().mockReturnValue(of(makeOperation())),
      deleteCapture: vi.fn().mockReturnValue(of(undefined)),
      getPartial: vi.fn().mockReturnValue(of(makePartial())),
      structureCapture: vi.fn().mockReturnValue(of(makeDocument())),
      commitCapture: vi
        .fn()
        .mockReturnValue(of(makeOperation({ status: 'structuring' }))),
      reportStructuringFailure: vi
        .fn()
        .mockReturnValue(of(makeOperation({ status: 'failed' }))),
      cancelCapture: vi
        .fn()
        .mockReturnValue(of(makeOperation({ status: 'cancelled' }))),
      getResult: vi.fn().mockReturnValue(of(makeCompositeResult())),
    };
    TestBed.configureTestingModule({
      providers: [
        CertPrepCaptureClient,
        {
          provide: CERT_PREP_API,
          useValue: api as unknown as CertPrepGeneratedClient,
        },
        { provide: ProjectStore, useValue: { selectedProjectId } },
        {
          provide: CertPrepRuntimeConfig,
          useValue: {
            getBackendConfig: vi.fn().mockReturnValue(
              of({
                base_url: 'http://127.0.0.1:8765/',
                token: TEST_BACKEND_TOKEN,
              }),
            ),
          },
        },
      ],
    });
    client = TestBed.inject(CertPrepCaptureClient);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('starts a v2 operation through the backend without exposing sidecar credentials', async () => {
    const controller = new AbortController();
    const file = new File(['pdf'], 'scan.pdf', { type: 'application/pdf' });

    const request$ = client.startStreamingCapture({
      clientRequestId: 'request-1',
      file,
      sourceKind: 'pdf',
      structuringMode: 'host',
      signal: controller.signal,
    });
    expect(typeof request$.subscribe).toBe('function');
    expect(request$).not.toBeInstanceOf(Promise);

    await expect(firstValueFrom(request$)).resolves.toMatchObject({
      protocolVersion: '2',
      captureId: 'capture-1',
      ingestionId: 'ingestion-1',
      status: 'awaiting_structuring',
    });
    expect(api.createCapture).toHaveBeenCalledWith(
      TEST_PROJECT_ID,
      expect.any(FormData),
      {
        headers: { 'X-Cert-Prep-Operation-Id': 'request-1' },
        signal: controller.signal,
      },
    );
    const body = api.createCapture.mock.calls[0]?.[1] as FormData;
    expect((body.get('file') as File).name).toBe('scan.pdf');
    expect(JSON.stringify(api.createCapture.mock.calls)).not.toContain(
      'Authorization',
    );
  });

  it('opens a cold authenticated replay stream for every subscription', async () => {
    await seedCapture();
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(sseFrame(4, 'checkpoint'), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const stream$ = client.captureEvents('capture-1', { lastEventId: 3 });
    await expect(lastValueFrom(stream$)).resolves.toMatchObject({
      captureId: 'capture-1',
      sequence: 4,
      eventType: 'checkpoint',
    });
    await expect(lastValueFrom(stream$)).resolves.toMatchObject({ sequence: 4 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(url).toBe(
      'http://127.0.0.1:8765/projects/project-1/capture-workbench/captures/capture-1/events',
    );
    expect(url).not.toContain(TEST_BACKEND_TOKEN);
    expect(headers.get('Authorization')).toBe(`Bearer ${TEST_BACKEND_TOKEN}`);
    expect(headers.get('Last-Event-ID')).toBe('3');
    expect(init.credentials).toBe('omit');
  });

  it('ignores standalone SSE heartbeats and other no-data blocks', async () => {
    await seedCapture();
    const body = [
      ': keep-alive\n\n',
      'id: ignored\nevent: heartbeat\nretry: 1000\n\n',
      sseFrame(4, 'checkpoint'),
    ].join('');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    );

    const events = await firstValueFrom(
      client.captureEvents('capture-1').pipe(toArray()),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      captureId: 'capture-1',
      sequence: 4,
      eventType: 'checkpoint',
    });
  });

  it('aborts the stream fetch on unsubscribe without cancelling the capture', async () => {
    await seedCapture();
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn().mockImplementation((_url, init: RequestInit) => {
      requestSignal = init.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    vi.stubGlobal('fetch', fetchMock);

    const subscription = client.captureEvents('capture-1').subscribe();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(requestSignal?.aborted).toBe(false);

    subscription.unsubscribe();

    expect(requestSignal?.aborted).toBe(true);
    expect(api.cancelCapture).not.toHaveBeenCalled();
  });

  it('fails closed on malformed SSE framing with a sanitized error', async () => {
    await seedCapture();
    const malformed = `id: 4\ndata: ${JSON.stringify({
      secret: TEST_BACKEND_TOKEN,
    })}\n\n`;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(malformed, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    );

    const error = await lastValueFrom(client.captureEvents('capture-1')).catch(
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('event stream is invalid');
    expect(String(error)).not.toContain(TEST_BACKEND_TOKEN);
  });

  it('treats a colonless SSE data field as dispatchable malformed data', async () => {
    await seedCapture();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('id: 4\nevent: checkpoint\ndata\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    );

    const error = await lastValueFrom(client.captureEvents('capture-1')).catch(
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('event stream is invalid');
  });

  it('delegates reviewed host structuring to the backend as an Observable', async () => {
    await seedCapture();
    const progress = vi.fn();
    const controller = new AbortController();
    const structureRequest: CaptureStructuringRequest = {
      raw: makeRaw(),
      review: {
        reviewVersion: 1,
        edits: [{ segmentId: 'segment-1', reviewedText: 'Corrected text' }],
      },
      documentContract: {
        schemaVersion: '1',
        schemaSha256: 'schema-digest',
        jsonSchema: {},
      },
      signal: controller.signal,
      reportProgress: progress,
    };

    const structure$ = client.structure(structureRequest);
    expect(typeof structure$.subscribe).toBe('function');
    await expect(firstValueFrom(structure$)).resolves.toMatchObject({
      schemaVersion: '1',
      blocks: [{ targetText: 'Recognized OCR text' }],
    });

    expect(api.structureCapture).toHaveBeenCalledWith(
      TEST_PROJECT_ID,
      'capture-1',
      {
        clientRequestId: 'capture-1-structure',
        review: {
          reviewVersion: 1,
          edits: [
            { segmentId: 'segment-1', reviewedText: 'Corrected text' },
          ],
        },
      },
      { signal: controller.signal },
    );
    expect(JSON.stringify(api.structureCapture.mock.calls)).not.toContain(
      'schema-digest',
    );
    expect(progress).toHaveBeenCalledWith(1);
  });

  it('commits the component candidate using the caller idempotency key', async () => {
    await seedCapture();
    const candidate = makeDocument();

    const commit$ = client.commitStreamingStructuredResult('capture-1', {
      clientRequestId: 'commit-1',
      candidate,
    });
    expect(typeof commit$.subscribe).toBe('function');
    await expect(firstValueFrom(commit$)).resolves.toMatchObject({
      protocolVersion: '2',
      status: 'structuring',
    });
    expect(api.commitCapture).toHaveBeenCalledWith(
      TEST_PROJECT_ID,
      'capture-1',
      { clientRequestId: 'commit-1', candidate },
      { signal: undefined },
    );
  });

  it('maps partial and composite result projections at the v2 boundary', async () => {
    await seedCapture();

    await expect(
      firstValueFrom(client.getStreamingPartial('capture-1')),
    ).resolves.toMatchObject({
      protocolVersion: '2',
      captureId: 'capture-1',
      revision: 1,
      segments: [{ text: 'Recognized OCR text' }],
    });
    await expect(
      firstValueFrom(client.getStreamingResult('capture-1')),
    ).resolves.toMatchObject({
      operation: { protocolVersion: '2', status: 'completed' },
      raw: { diagnosticOnly: true },
      result: { schemaVersion: '1' },
    });
  });

  it('rejects composite results whose full source identities diverge', async () => {
    await seedCapture();
    const composite = makeCompositeResult();
    const mismatched = {
      ...composite,
      result: {
        ...composite.result,
        source: {
          ...composite.result.source,
          fileName: 'different.pdf',
        },
      },
    };
    api.getResult.mockReturnValueOnce(of(mismatched));

    await expect(
      firstValueFrom(client.getStreamingResult('capture-1')),
    ).rejects.toThrow('result source does not match the capture operation');
  });

  it('forwards cancellation, failure reporting, and deletion through the backend', async () => {
    await seedCapture();

    await firstValueFrom(client.cancelStreamingCapture('capture-1'));
    await firstValueFrom(
      client.reportStreamingStructuringFailure('capture-1', {
        clientRequestId: 'failure-1',
        code: 'host_structuring_failed',
        message: 'Host structuring failed.',
      }),
    );
    await firstValueFrom(client.deleteStreamingCapture('capture-1'));

    expect(api.cancelCapture).toHaveBeenCalledWith(
      TEST_PROJECT_ID,
      'capture-1',
      { signal: undefined },
    );
    expect(api.reportStructuringFailure).toHaveBeenCalledWith(
      TEST_PROJECT_ID,
      'capture-1',
      {
        clientRequestId: 'failure-1',
        code: 'host_structuring_failed',
        message: 'Host structuring failed.',
      },
      { signal: undefined },
    );
    expect(api.deleteCapture).toHaveBeenCalledWith(
      TEST_PROJECT_ID,
      'capture-1',
      { signal: undefined },
    );
    expect(client.documentIdForSourceSha256('a'.repeat(64))).toBe('document-1');
  });

  it('maps readiness and preserves the browser abort signal', async () => {
    const controller = new AbortController();
    await expect(firstValueFrom(client.getReady(controller.signal))).resolves.toMatchObject({
      service: 'capture-runtime',
      runtimeVersion: CAPTURE_RUNTIME_VERSION,
      capabilities: { captureKinds: ['pdf', 'image', 'audio'] },
    });
    expect(api.captureRuntimeReady).toHaveBeenCalledWith({
      signal: controller.signal,
    });
  });

  it('allows embedded-text PDF admission without an OCR installation', async () => {
    api.captureRuntimeRequirements.mockReturnValueOnce(
      of({
        items: [
          unavailableRequirement('windowsml-ocr', ['pdf', 'image']),
          unavailableRequirement('whisper-primary', ['audio']),
        ],
      }),
    );

    await expect(
      firstValueFrom(
        client.startStreamingCapture({
          clientRequestId: 'embedded-pdf',
          file: new File(['embedded'], 'scan.pdf', {
            type: 'application/pdf',
          }),
          sourceKind: 'pdf',
          structuringMode: 'host',
        }),
      ),
    ).resolves.toMatchObject({ captureId: 'capture-1' });
  });

  it.each([
    [
      'image',
      'windowsml-ocr',
      'WindowsML OCR is unavailable',
      new File(['image'], 'scan.png', { type: 'image/png' }),
    ],
    [
      'audio',
      'whisper-primary',
      'Whisper transcription is unavailable',
      new File(['audio'], 'lecture.mp3', { type: 'audio/mpeg' }),
    ],
  ] as const)(
    'rejects %s before upload when its runtime requirement is unavailable',
    async (sourceKind, requirementId, expectedError, file) => {
      api.captureRuntimeRequirements.mockReturnValueOnce(
        of({
          items: [
            requirementId === 'windowsml-ocr'
              ? unavailableRequirement('windowsml-ocr', ['pdf', 'image'])
              : readyRequirement('windowsml-ocr', ['pdf', 'image']),
            requirementId === 'whisper-primary'
              ? unavailableRequirement('whisper-primary', ['audio'])
              : readyRequirement('whisper-primary', ['audio']),
          ],
        }),
      );

      await expect(
        firstValueFrom(
          client.startStreamingCapture({
            clientRequestId: `blocked-${sourceKind}`,
            file,
            sourceKind,
            structuringMode: 'host',
          }),
        ),
      ).rejects.toThrow(expectedError);
      expect(api.createCapture).not.toHaveBeenCalled();
    },
  );

  it('fails closed before upload when the runtime handshake is incompatible', async () => {
    api.captureRuntimeReady.mockReturnValueOnce(
      of(readyResponse({ runtimeVersion: '0.2.8' })),
    );

    await expect(
      firstValueFrom(
        client.startStreamingCapture({
          clientRequestId: 'wrong-runtime',
          file: new File(['pdf'], 'scan.pdf', { type: 'application/pdf' }),
          sourceKind: 'pdf',
          structuringMode: 'host',
        }),
      ),
    ).rejects.toThrow('incompatible with client runtime minor 3');
    expect(api.createCapture).not.toHaveBeenCalled();
  });

  it('surfaces backend failures without manufacturing a success operation', async () => {
    await seedCapture();
    api.getCapture.mockReturnValueOnce(
      throwError(() => new Error('backend unavailable')),
    );

    await expect(
      firstValueFrom(client.getStreamingCapture('capture-1')),
    ).rejects.toThrow('backend unavailable');
  });

  async function seedCapture(): Promise<void> {
    await firstValueFrom(
      client.startStreamingCapture({
        clientRequestId: 'seed-capture',
        file: new File(['pdf'], 'scan.pdf', { type: 'application/pdf' }),
        sourceKind: 'pdf',
        structuringMode: 'host',
      }),
    );
  }
});

function makeOperation(
  override: { readonly status?: string; readonly lastEventSequence?: number } = {},
) {
  const status = override.status ?? 'awaiting_structuring';
  const terminal = ['completed', 'failed', 'cancelled'].includes(status);
  return {
    protocolVersion: '2',
    captureId: 'capture-1',
    ingestionId: 'ingestion-1',
    kind: 'pdf',
    status,
    progress: terminal ? 1 : 0.7,
    partialRevision: 1,
    lastEventSequence: override.lastEventSequence ?? 3,
    source: makeSource(),
    error:
      status === 'failed'
        ? {
            code: 'host_structuring_failed',
            message: 'Host structuring failed.',
            stage: 'structuring',
            retryable: false,
          }
        : null,
    createdAt: '2026-07-23T10:00:00.000Z',
    updatedAt: '2026-07-23T10:00:01.000Z',
    completedAt: terminal ? '2026-07-23T10:00:02.000Z' : null,
    documentId: 'document-1',
  };
}

function makeSource() {
  return {
    sha256: 'a'.repeat(64),
    fileName: 'scan.pdf',
    mediaType: 'application/pdf',
    bytes: 3,
  };
}

function makePartial() {
  return {
    protocolVersion: '2',
    captureId: 'capture-1',
    source: makeSource(),
    revision: 1,
    coveredUntilMs: 0,
    segments: makeRaw().segments,
    sourceText: 'Recognized OCR text',
    extractionEngine: makeRaw().extractionEngine,
    updatedAt: '2026-07-23T10:00:01.000Z',
  };
}

function makeRaw() {
  return {
    schemaVersion: '1' as const,
    diagnosticOnly: true as const,
    source: makeSource(),
    segments: [
      {
        segmentId: 'segment-1',
        order: 0,
        locator: { kind: 'page' as const, page: 1 },
        text: 'Recognized OCR text',
      },
    ],
    sourceText: 'Recognized OCR text',
    extractionEngine: {
      engine: 'windowsml_ocr',
      model: `capture-runtime@${CAPTURE_RUNTIME_VERSION}`,
      digest: `sha256:${'a'.repeat(64)}`,
      device: 'WindowsML',
    },
    warnings: [],
    createdAt: '2026-07-23T10:00:00.000Z',
  };
}

function makeDocument(): CaptureDocumentV1 {
  return {
    schemaVersion: '1',
    source: makeSource(),
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

function makeCompositeResult() {
  return {
    operation: makeOperation({ status: 'completed' }),
    raw: makeRaw(),
    result: makeDocument(),
  };
}

function sseFrame(sequence: number, eventType: string): string {
  const event = {
    protocolVersion: '2',
    eventId: `capture-1/${sequence}`,
    sequence,
    captureId: 'capture-1',
    kind: 'pdf',
    eventType,
    stage: 'extracting',
    progress: 0.5,
    partialRevision: 1,
    coveredUntilMs: 0,
    createdAt: '2026-07-23T10:00:01.000Z',
  };
  return `id: ${sequence}\nevent: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`;
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
    runtimeVersion: CAPTURE_RUNTIME_VERSION,
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
) {
  return {
    requirementId,
    kind: requirementId === 'windowsml-ocr' ? 'ocr' : 'speech-to-text',
    displayName:
      requirementId === 'windowsml-ocr'
        ? 'WindowsML OCR'
        : 'Whisper transcription',
    status: 'unavailable',
    requiredFor,
    installStrategy: 'runtime-catalog',
    detail: 'No downloadable model is published for this runtime release.',
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
