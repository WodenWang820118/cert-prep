import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { CertPrepGeneratedClient } from '@cert-prep/api';
import { CAPTURE_RUNTIME_VERSION } from '@cert-prep/capture-runtime-version';
import { firstValueFrom, lastValueFrom, of, throwError, toArray } from 'rxjs';
import type {
  CaptureDocument,
  CaptureStructuringRequest,
  RuntimeCapabilities,
} from '@gx-capture/capture-workbench-ui';
import { CERT_PREP_API } from '../../core/data';
import { CertPrepRuntimeConfig } from '../../core/data';
import { ProjectStore } from '../../projects/data';
import { CertPrepCaptureClient } from './cert-prep-capture-client';

const TEST_PROJECT_ID = 'project-1';
const TEST_BACKEND_TOKEN = 'backend-token';

type ApiMocks = Record<
  | 'captureRuntimeReady'
  | 'captureRuntimeRequirements'
  | 'getSourceMarkdown'
  | 'createCapture'
  | 'getCapture'
  | 'deleteCapture'
  | 'getPartial'
  | 'getRaw'
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
      captureRuntimeRequirements: vi.fn().mockReturnValue(
        of({
          items: [
            readyRequirement('text-recognition', ['pdf', 'image']),
            readyRequirement('speech-recognition', ['recording']),
          ],
        }),
      ),
      getSourceMarkdown: vi.fn().mockReturnValue(of(new Blob(['# scan']))),
      createCapture: vi.fn().mockReturnValue(of(makeOperation())),
      getCapture: vi.fn().mockReturnValue(of(makeOperation())),
      deleteCapture: vi.fn().mockReturnValue(of(undefined)),
      getPartial: vi.fn().mockReturnValue(of(makePartial())),
      getRaw: vi.fn().mockReturnValue(of(makeRaw())),
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

    const request$ = client.startCapture({
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
    await expect(lastValueFrom(stream$)).resolves.toMatchObject({
      sequence: 4,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(url).toBe(
      'http://127.0.0.1:8765/projects/project-1/capture-reviews/capture-1/events',
    );
    expect(url).not.toContain(TEST_BACKEND_TOKEN);
    expect(headers.get('Authorization')).toBe(`Bearer ${TEST_BACKEND_TOKEN}`);
    expect(headers.get('Last-Event-ID')).toBe('3');
    expect(init.credentials).toBe('omit');
  });

  it('accepts a bounded batched multi-page segment event', async () => {
    await seedCapture();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        sseFrame(4, 'segment', {
          segments: [
            {
              segmentId: 'segment-large',
              order: 0,
              locator: { kind: 'page', page: 1 },
              text: 'x'.repeat(70 * 1024),
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      firstValueFrom(client.captureEvents('capture-1', { lastEventId: 3 })),
    ).resolves.toMatchObject({
      captureId: 'capture-1',
      sequence: 4,
      eventType: 'segment',
      segments: [{ segmentId: 'segment-large' }],
    });
  });

  it('accepts events as the 0.11.0 runtime serializes them, progress and speaker fields included', async () => {
    await seedCapture();
    const segment = {
      segmentId: 'segment-1',
      order: 0,
      locator: { kind: 'page', page: 1 },
      text: 'page one',
      speaker: null,
      speakerOverlap: false,
    };
    const body = [
      sseFrame(1, 'checkpoint', {
        pagesDone: null,
        pagesTotal: null,
        durationMs: null,
        segments: [],
        error: null,
      }),
      sseFrame(2, 'segment', {
        pagesDone: 1,
        pagesTotal: 3,
        durationMs: null,
        segments: [segment],
        error: null,
      }),
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

    const events = await lastValueFrom(
      client.captureEvents('capture-1').pipe(toArray()),
    );

    expect(events).toMatchObject([
      { sequence: 1, eventType: 'checkpoint', pagesDone: null },
      {
        sequence: 2,
        eventType: 'segment',
        pagesDone: 1,
        pagesTotal: 3,
        segments: [{ segmentId: 'segment-1', speakerOverlap: false }],
      },
    ]);
  });

  it.each([
    ['a zero page total', { pagesTotal: 0 }],
    ['a negative page count', { pagesDone: -1 }],
    ['a fractional duration', { durationMs: 1.5 }],
    [
      'a non-boolean speaker overlap',
      {
        segments: [
          {
            segmentId: 'segment-1',
            order: 0,
            locator: { kind: 'page', page: 1 },
            text: 'page one',
            speakerOverlap: 'no',
          },
        ],
      },
    ],
  ])('rejects an event with %s', async (_label, payload) => {
    await seedCapture();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(sseFrame(1, 'checkpoint', payload), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    );

    await expect(
      lastValueFrom(client.captureEvents('capture-1')),
    ).rejects.toThrow();
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
        reviewVersion: 2,
        edits: [{ segmentId: 'segment-1', reviewedText: 'Corrected text' }],
      },
      documentContract: {
        schemaVersion: '2',
        schemaSha256: 'schema-digest',
        jsonSchema: {},
      },
      signal: controller.signal,
      reportProgress: progress,
    };

    const structure$ = client.structure(structureRequest);
    expect(typeof structure$.subscribe).toBe('function');
    await expect(firstValueFrom(structure$)).resolves.toMatchObject({
      schemaVersion: '2',
      blocks: [{ targetText: 'Recognized OCR text' }],
    });

    expect(api.structureCapture).toHaveBeenCalledWith(
      TEST_PROJECT_ID,
      'capture-1',
      {
        clientRequestId: 'capture-1-structure',
        review: {
          reviewVersion: 2,
          edits: [{ segmentId: 'segment-1', reviewedText: 'Corrected text' }],
        },
      },
      { signal: controller.signal },
    );
    expect(JSON.stringify(api.structureCapture.mock.calls)).not.toContain(
      'schema-digest',
    );
    expect(progress).toHaveBeenCalledWith(1);
  });

  it('translates the published workbench review envelope to the host v2 contract', async () => {
    await seedCapture();
    const progress = vi.fn();
    const controller = new AbortController();
    const request: CaptureStructuringRequest = {
      raw: makeRaw(),
      review: {
        reviewVersion: 1,
        edits: [],
      },
      documentContract: {
        schemaVersion: '2',
        schemaSha256: 'schema-digest',
        jsonSchema: {},
      },
      signal: controller.signal,
      reportProgress: progress,
    };

    await firstValueFrom(client.structure(request));

    expect(api.structureCapture).toHaveBeenCalledWith(
      TEST_PROJECT_ID,
      'capture-1',
      {
        clientRequestId: 'capture-1-structure',
        review: {
          reviewVersion: 2,
          edits: [],
        },
      },
      { signal: controller.signal },
    );
  });

  it('commits the component candidate using the caller idempotency key', async () => {
    await seedCapture();
    const candidate = makeDocument();

    const commit$ = client.commitStructure('capture-1', {
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
      firstValueFrom(client.getPartial('capture-1')),
    ).resolves.toMatchObject({
      protocolVersion: '2',
      captureId: 'capture-1',
      revision: 1,
      segments: [{ text: 'Recognized OCR text' }],
    });
    await expect(
      firstValueFrom(client.getRaw('capture-1')),
    ).resolves.toMatchObject({
      schemaVersion: '2',
      source: { sha256: 'a'.repeat(64) },
      segments: [{ text: 'Recognized OCR text' }],
    });
    await expect(
      firstValueFrom(client.getResult('capture-1')),
    ).resolves.toMatchObject({
      operation: { protocolVersion: '2', status: 'completed' },
      raw: { diagnosticOnly: true },
      result: { schemaVersion: '2' },
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
      firstValueFrom(client.getResult('capture-1')),
    ).rejects.toThrow('result source does not match the capture operation');
  });

  it.each([
    {
      status: 'recorded' as const,
      engine: 'text-recognition',
      model: 'capture-ocr-v1',
      device: 'igpu',
      runtimeVersion: CAPTURE_RUNTIME_VERSION,
    },
    {
      status: 'reconstructed' as const,
      engine: 'text-recognition',
      model: null,
      device: null,
      runtimeVersion: null,
    },
  ])(
    'keeps the $status extraction provenance of a result by its source digest',
    async (provenance) => {
      await seedCapture();
      expect(
        client.extractionProvenanceForSourceSha256('a'.repeat(64)),
      ).toBeNull();
      api.getResult.mockReturnValueOnce(
        of({ ...makeCompositeResult(), extractionProvenance: provenance }),
      );

      const result = await firstValueFrom(client.getResult('capture-1'));

      expect(result).toMatchObject({ extractionProvenance: provenance });
      expect(
        client.extractionProvenanceForSourceSha256('a'.repeat(64)),
      ).toEqual(provenance);
      expect(
        client.extractionProvenanceForSourceSha256('b'.repeat(64)),
      ).toBeNull();
    },
  );

  it.each([
    ['is missing', undefined],
    [
      'has an unknown status',
      { status: 'rebuilt', engine: 'text-recognition', model: null, device: null, runtimeVersion: null },
    ],
    [
      'has no engine',
      { status: 'recorded', engine: '', model: null, device: null, runtimeVersion: null },
    ],
    [
      'has a non-string model',
      { status: 'recorded', engine: 'text-recognition', model: 7, device: null, runtimeVersion: null },
    ],
  ])(
    'rejects a result whose extraction provenance %s',
    async (_case, provenance) => {
      await seedCapture();
      const malformed = {
        ...makeCompositeResult(),
        extractionProvenance: provenance,
      } as unknown as ReturnType<typeof makeCompositeResult>;
      api.getResult.mockReturnValueOnce(of(malformed));

      await expect(
        firstValueFrom(client.getResult('capture-1')),
      ).rejects.toThrow(/extractionProvenance/u);
      expect(
        client.extractionProvenanceForSourceSha256('a'.repeat(64)),
      ).toBeNull();
    },
  );

  it('forwards cancellation, failure reporting, and deletion through the backend', async () => {
    await seedCapture();

    await firstValueFrom(client.cancelCapture('capture-1'));
    await firstValueFrom(
      client.reportStructuringFailure('capture-1', {
        clientRequestId: 'failure-1',
        code: 'host_structuring_failed',
        message: 'Host structuring failed.',
      }),
    );
    await firstValueFrom(client.deleteCapture('capture-1'));

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
    expect(client.sourceIdForSha256('a'.repeat(64))).toBe('source-1');
  });

  it.each([undefined, null, 'NVIDIA GeForce RTX 4060'])(
    'preserves structuring deviceName %s through result, review and commit',
    async (deviceName) => {
      await seedCapture();
      const document = makeDocument();
      const engine = { ...document.structuringEngine, device: 'cuda',
        ...(deviceName === undefined ? {} : { deviceName }) };
      const candidate = { ...document, structuringEngine: engine };
      api.getResult.mockReturnValueOnce(of({ ...makeCompositeResult(), result: candidate }));
      const result = await firstValueFrom(client.getResult('capture-1'));
      expect(result.result.structuringEngine).toEqual(engine);
      api.structureCapture.mockReturnValueOnce(of(candidate));
      const reviewed = await firstValueFrom(client.structure({
        raw: makeRaw(), review: { reviewVersion: 1, edits: [] },
        documentContract: { schemaVersion: '2', schemaSha256: 'schema-digest', jsonSchema: {} },
        signal: new AbortController().signal, reportProgress: vi.fn(),
      }));
      expect(reviewed.structuringEngine).toEqual(engine);
      await firstValueFrom(client.commitStructure('capture-1', {
        clientRequestId: 'commit-device', candidate: reviewed,
      }));
      expect(api.commitCapture.mock.calls[0][2].candidate.structuringEngine).toEqual(engine);
    },
  );

  it.each(['', '   ', 42, {}, false])('rejects invalid deviceName %s', async (deviceName) => {
    await seedCapture();
    const document = makeDocument();
    api.getResult.mockReturnValueOnce(of({ ...makeCompositeResult(), result: {
      ...document, structuringEngine: { ...document.structuringEngine, deviceName },
    } }));
    await expect(firstValueFrom(client.getResult('capture-1')))
      .rejects.toThrow('structuringEngine.deviceName');
  });

  it('accepts waiting_input and rejects the retired created status', async () => {
    await seedCapture();
    api.getCapture.mockReturnValueOnce(of(makeOperation({ status: 'waiting_input' })));
    await expect(firstValueFrom(client.getCapture('capture-1')))
      .resolves.toMatchObject({ status: 'waiting_input' });
    api.getCapture.mockReturnValueOnce(of(makeOperation({ status: 'created' })));
    await expect(firstValueFrom(client.getCapture('capture-1')))
      .rejects.toThrow('capture status is unsupported');
  });

  it.each(['recording', 'audio'])('decodes SSE kind %s against 0.11.0', async (kind) => {
    await seedCapture();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      sseFrame(4, 'checkpoint', { kind }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    )));
    const stream = firstValueFrom(client.captureEvents('capture-1'));
    if (kind === 'recording') {
      await expect(stream).resolves.toMatchObject({ kind: 'recording' });
    } else {
      await expect(stream).rejects.toThrow('event stream is invalid');
    }
  });

  it('admits recording with speech recognition and preserves its ingestion identity', async () => {
    api.createCapture.mockReturnValueOnce(of({ ...makeOperation(), kind: 'recording',
      ingestionId: 'runtime-ingestion-recording' }));
    await expect(firstValueFrom(client.startCapture({
      clientRequestId: 'recording-1', file: new File(['audio'], 'lecture.mp3'),
      sourceKind: 'recording', structuringMode: 'host',
    }))).resolves.toMatchObject({ kind: 'recording', ingestionId: 'runtime-ingestion-recording' });
    expect(api.createCapture).toHaveBeenCalledOnce();
  });

  it.each([
    ['maxUploadBytes', undefined], ['maxChunkBytes', 0], ['maxChunkBytes', 4 * 1024 * 1024 + 1],
    ['checkpointIntervalMs', -1], ['heartbeatIntervalMs', 1.5], ['stallTimeoutMs', Number.NaN],
    ['supportsProgressiveRecording', undefined], ['captureKinds', ['audio']],
    ['structuringModes', ['unknown']],
  ] as const)('rejects malformed capability %s=%s before upload', async (field, value) => {
    api.captureRuntimeReady.mockReturnValueOnce(of(readyResponse({ capabilities: { [field]: value } })));
    await expect(firstValueFrom(client.startCapture({
      clientRequestId: 'bad-capability', file: new File(['pdf'], 'scan.pdf'),
      sourceKind: 'pdf', structuringMode: 'host',
    }))).rejects.toThrow(`capabilities.${field}`);
    expect(api.createCapture).not.toHaveBeenCalled();
  });

  it('preserves false capability flags from a valid runtime', async () => {
    api.captureRuntimeReady.mockReturnValueOnce(of(readyResponse({ capabilities: {
      supportsCancellation: false, supportsRawDiagnostics: false, supportsProgressiveRecording: false,
    } })));
    const ready = await firstValueFrom(client.getReady());
    expect(ready.capabilities).toMatchObject({ supportsCancellation: false,
      supportsRawDiagnostics: false, supportsProgressiveRecording: false });
    expect(ready).not.toHaveProperty('schemaSha256');
  });

  it('maps readiness and preserves the browser abort signal', async () => {
    const controller = new AbortController();
    await expect(
      firstValueFrom(client.getReady(controller.signal)),
    ).resolves.toMatchObject({
      service: 'capture-runtime',
      runtimeVersion: CAPTURE_RUNTIME_VERSION,
      ocrCompute: {
        runtimeVersion: CAPTURE_RUNTIME_VERSION,
        contractSetSha256: 'a'.repeat(64),
      },
      capabilities: readyCapabilities(),
    });
    expect(api.captureRuntimeReady).toHaveBeenCalledWith({
      signal: controller.signal,
    });
  });

  it.each([
    ['dedicated', 'gpu', null, false, null],
    ['integrated', 'gpu', null, false, null],
    [
      'integrated',
      'cpu-fallback',
      'no_compatible_gpu',
      true,
      'ocr_cpu_fallback',
    ],
    [
      'unknown',
      'cpu-fallback',
      'gpu_provider_unavailable',
      true,
      'ocr_cpu_fallback',
    ],
  ] as const)(
    'maps the runtime-owned %s %s OCR compute decision',
    async (adapterClass, mode, reasonCode, userNoticeRequired, noticeCode) => {
      api.captureRuntimeReady.mockReturnValueOnce(
        of(
          readyResponse({
            ocrCompute: {
              ...readyOcrCompute(),
              adapterClass,
              mode,
              reasonCode,
              userNoticeRequired,
              noticeCode,
            },
          }),
        ),
      );

      await expect(firstValueFrom(client.getReady())).resolves.toMatchObject({
        ocrCompute: {
          adapterClass,
          mode,
          reasonCode,
          userNoticeRequired,
          noticeCode,
        },
      });
    },
  );

  it('rejects a malformed GPU-DML preflight instead of creating a CPU fallback state', async () => {
    api.captureRuntimeReady.mockReturnValueOnce(
      of(
        readyResponse({
          ocrCompute: {
            ...readyOcrCompute(),
            mode: 'gpu',
            reasonCode: 'no_compatible_gpu',
            userNoticeRequired: true,
            noticeCode: 'ocr_cpu_fallback',
          },
        }),
      ),
    );

    await expect(firstValueFrom(client.getReady())).rejects.toThrow(
      'gpu cannot carry a fallback reason or notice',
    );
  });

  it.each([
    [
      'pdf',
      'text-recognition',
      'Text recognition is unavailable',
      new File(['pdf'], 'scan.pdf', { type: 'application/pdf' }),
    ],
    [
      'image',
      'text-recognition',
      'Text recognition is unavailable',
      new File(['image'], 'scan.png', { type: 'image/png' }),
    ],
    [
      'recording',
      'speech-recognition',
      'Speech recognition is unavailable',
      new File(['recording'], 'lecture.mp3', { type: 'audio/mpeg' }),
    ],
  ] as const)(
    'rejects %s before upload when its runtime requirement is unavailable',
    async (sourceKind, requirementId, expectedError, file) => {
      api.captureRuntimeRequirements.mockReturnValueOnce(
        of({
          items: [
            requirementId === 'text-recognition'
              ? unavailableRequirement('text-recognition', ['pdf', 'image'])
              : readyRequirement('text-recognition', ['pdf', 'image']),
            requirementId === 'speech-recognition'
              ? unavailableRequirement('speech-recognition', ['recording'])
              : readyRequirement('speech-recognition', ['recording']),
          ],
        }),
      );

      await expect(
        firstValueFrom(
          client.startCapture({
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
        client.startCapture({
          clientRequestId: 'wrong-runtime',
          file: new File(['pdf'], 'scan.pdf', { type: 'application/pdf' }),
          sourceKind: 'pdf',
          structuringMode: 'host',
        }),
      ),
    ).rejects.toThrow(/incompatible with client runtime minor \d+/);
    expect(api.createCapture).not.toHaveBeenCalled();
  });

  it('surfaces backend failures without manufacturing a success operation', async () => {
    await seedCapture();
    api.getCapture.mockReturnValueOnce(
      throwError(() => new Error('backend unavailable')),
    );

    await expect(
      firstValueFrom(client.getCapture('capture-1')),
    ).rejects.toThrow('backend unavailable');
  });

  it.each([
    [
      'a non-Capture Runtime service',
      { service: 'other-service' },
      'non-Capture Runtime service',
    ],
    [
      'capabilities outside the Capture contract',
      { capabilities: { supportsCancellation: 'yes' } },
      'capabilities.supportsCancellation',
    ],
    [
      'an OCR preflight for a different runtime version',
      { ocrCompute: { ...readyOcrCompute(), runtimeVersion: '9.9.9' } },
      'ocrCompute.runtimeVersion does not match runtimeVersion',
    ],
    [
      'a cpu-fallback preflight without a notice',
      {
        ocrCompute: {
          ...readyOcrCompute(),
          mode: 'cpu-fallback',
          reasonCode: 'no_compatible_gpu',
          userNoticeRequired: false,
          noticeCode: null,
        },
      },
      'cpu-fallback requires a reason and user notice',
    ],
    [
      'a preflight with a malformed contract digest',
      { ocrCompute: { ...readyOcrCompute(), contractSetSha256: 'nope' } },
      'ocrCompute.contractSetSha256',
    ],
  ] as const)(
    'rejects readiness with %s',
    async (_label, override, message) => {
      api.captureRuntimeReady.mockReturnValueOnce(
        of(readyResponse(override as Record<string, unknown>)),
      );

      await expect(firstValueFrom(client.getReady())).rejects.toThrow(message);
    },
  );

  it('rejects a capture kind the runtime does not advertise before upload', async () => {
    api.captureRuntimeReady.mockReturnValueOnce(
      of(readyResponse({ capabilities: { captureKinds: ['image'] } })),
    );

    await expect(
      firstValueFrom(
        client.startCapture({
          clientRequestId: 'unsupported-kind',
          file: new File(['pdf'], 'scan.pdf', { type: 'application/pdf' }),
          sourceKind: 'pdf',
          structuringMode: 'host',
        }),
      ),
    ).rejects.toThrow('Capture Runtime does not support PDF capture.');
    expect(api.createCapture).not.toHaveBeenCalled();
  });

  it('rejects a runtime that reports not ready before upload', async () => {
    api.captureRuntimeReady.mockReturnValueOnce(
      of(readyResponse({ ready: false })),
    );

    await expect(
      firstValueFrom(
        client.startCapture({
          clientRequestId: 'not-ready',
          file: new File(['pdf'], 'scan.pdf', { type: 'application/pdf' }),
          sourceKind: 'pdf',
          structuringMode: 'host',
        }),
      ),
    ).rejects.toThrow('Capture Runtime is not ready.');
    expect(api.createCapture).not.toHaveBeenCalled();
  });

  it('rejects an operation whose kind differs from the requested source', async () => {
    api.createCapture.mockReturnValueOnce(
      of({ ...makeOperation(), kind: 'image' }),
    );

    await expect(
      firstValueFrom(
        client.startCapture({
          clientRequestId: 'kind-mismatch',
          file: new File(['pdf'], 'scan.pdf', { type: 'application/pdf' }),
          sourceKind: 'pdf',
          structuringMode: 'host',
        }),
      ),
    ).rejects.toThrow('capture kind does not match the requested source');
  });

  it('rejects malformed capture identifiers before any backend call', () => {
    expect(() => client.getCapture('bad id')).toThrow(
      'captureId has an invalid format',
    );
    expect(api.getCapture).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a different captureId',
      { captureId: 'capture-2' },
      'captureId does not match',
    ],
    [
      'an unsupported status',
      { status: 'bogus' },
      'capture status is unsupported',
    ],
    [
      'an out-of-range progress',
      { progress: 2 },
      'capture progress is invalid',
    ],
    [
      'a failed status without an error',
      { status: 'failed', error: null },
      'capture error does not match status',
    ],
    [
      'a terminal status without completedAt',
      { status: 'completed', completedAt: null },
      'completedAt does not match capture status',
    ],
    [
      'another protocol version',
      { protocolVersion: '1' },
      'protocolVersion must be 2',
    ],
  ] as const)(
    'rejects an operation response with %s',
    async (_label, override, message) => {
      await seedCapture();
      api.getCapture.mockReturnValueOnce(
        of({ ...makeOperation(), ...override }),
      );

      await expect(
        firstValueFrom(client.getCapture('capture-1')),
      ).rejects.toThrow(message);
    },
  );

  it('passes the caller abort signal to every capture request', async () => {
    await seedCapture();
    const { signal } = new AbortController();

    await firstValueFrom(client.getCapture('capture-1', signal));
    await firstValueFrom(client.getPartial('capture-1', signal));
    await firstValueFrom(client.getRaw('capture-1', signal));
    await firstValueFrom(client.getResult('capture-1', signal));
    await firstValueFrom(client.cancelCapture('capture-1', signal));
    await firstValueFrom(client.deleteCapture('capture-1', signal));

    expect(api.getCapture).toHaveBeenLastCalledWith(
      TEST_PROJECT_ID,
      'capture-1',
      { signal },
    );
    expect(api.getPartial).toHaveBeenCalledWith(TEST_PROJECT_ID, 'capture-1', {
      signal,
    });
    expect(api.getRaw).toHaveBeenCalledWith(TEST_PROJECT_ID, 'capture-1', {
      signal,
    });
    expect(api.getResult).toHaveBeenCalledWith(TEST_PROJECT_ID, 'capture-1', {
      signal,
    });
    expect(api.cancelCapture).toHaveBeenCalledWith(
      TEST_PROJECT_ID,
      'capture-1',
      { signal },
    );
    expect(api.deleteCapture).toHaveBeenCalledWith(
      TEST_PROJECT_ID,
      'capture-1',
      { signal },
    );
  });

  it('rejects composite results whose source digest diverges', async () => {
    await seedCapture();
    const composite = makeCompositeResult();
    api.getResult.mockReturnValueOnce(
      of({
        ...composite,
        result: {
          ...composite.result,
          source: { ...composite.result.source, sha256: 'c'.repeat(64) },
        },
      }),
    );

    await expect(
      firstValueFrom(client.getResult('capture-1')),
    ).rejects.toThrow('result source does not match the capture operation');
  });

  async function seedCapture(): Promise<void> {
    await firstValueFrom(
      client.startCapture({
        clientRequestId: 'seed-capture',
        file: new File(['pdf'], 'scan.pdf', { type: 'application/pdf' }),
        sourceKind: 'pdf',
        structuringMode: 'host',
      }),
    );
  }
});

function makeOperation(
  override: {
    readonly status?: string;
    readonly lastEventSequence?: number;
  } = {},
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
    sourceId: 'source-1',
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
    schemaVersion: '2' as const,
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
      engine: 'text-recognition',
      model: `capture-runtime@${CAPTURE_RUNTIME_VERSION}`,
      digest: `sha256:${'a'.repeat(64)}`,
      device: 'directml',
    },
    warnings: [],
    createdAt: '2026-07-23T10:00:00.000Z',
  };
}

function makeDocument(): CaptureDocument {
  return {
    schemaVersion: '2',
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
    extractionProvenance: {
      status: 'recorded' as const,
      engine: makeRaw().extractionEngine.engine,
      model: makeRaw().extractionEngine.model,
      device: null,
      runtimeVersion: CAPTURE_RUNTIME_VERSION,
    },
    raw: makeRaw(),
    result: makeDocument(),
  };
}

function sseFrame(
  sequence: number,
  eventType: string,
  payload: Record<string, unknown> = {},
): string {
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
    ...payload,
  };
  return `id: ${sequence}\nevent: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`;
}

function readyCapabilities(): RuntimeCapabilities {
  return {
    captureKinds: ['pdf', 'image', 'recording'],
    structuringModes: ['host'],
    supportsCancellation: true,
    supportsRawDiagnostics: true,
    maxUploadBytes: 50_000_000,
    maxChunkBytes: 4 * 1024 * 1024,
    checkpointIntervalMs: 1000,
    heartbeatIntervalMs: 5000,
    stallTimeoutMs: 60000,
    supportsProgressiveRecording: true,
  };
}

function readyOcrCompute() {
  return {
    apiVersion: '2.0',
    schemaVersion: '1',
    service: 'capture-runtime',
    runtimeVersion: CAPTURE_RUNTIME_VERSION,
    contractSetVersion: '2',
    contractSetSha256: 'a'.repeat(64),
    workerSha256: 'b'.repeat(64),
    mode: 'gpu',
    adapterClass: 'dedicated',
    reasonCode: null,
    userNoticeRequired: false,
    noticeCode: null,
  } as const;
}

function readyResponse(override: Record<string, unknown>) {
  const runtimeVersion =
    typeof override['runtimeVersion'] === 'string'
      ? override['runtimeVersion']
      : CAPTURE_RUNTIME_VERSION;
  const base = {
    ready: true,
    service: 'capture-runtime',
    apiVersion: '2.0',
    runtimeVersion,
    captureDocumentSchemaVersion: '2',
    capabilities: readyCapabilities(),
    ocrCompute: { ...readyOcrCompute(), runtimeVersion },
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
  requirementId: 'text-recognition' | 'speech-recognition',
  requiredFor: readonly string[],
) {
  return {
    requirementId,
    kind: requirementId,
    displayName:
      requirementId === 'text-recognition'
        ? 'Text recognition'
        : 'Speech recognition',
    status: 'unavailable',
    requiredFor,
    installStrategy: 'runtime-catalog',
    detail: 'No downloadable model is published for this runtime release.',
    artifact: null,
  };
}

function readyRequirement(
  requirementId: 'text-recognition' | 'speech-recognition',
  requiredFor: readonly string[],
) {
  return {
    ...unavailableRequirement(requirementId, requiredFor),
    status: 'ready',
    detail: null,
  };
}
