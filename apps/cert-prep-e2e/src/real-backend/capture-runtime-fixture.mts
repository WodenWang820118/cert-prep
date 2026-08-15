import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CAPTURE_RUNTIME_MODEL,
  CAPTURE_RUNTIME_VERSION,
} from '../../../../tools/capture-runtime-version.mts';

const defaultHost = '127.0.0.1';
const defaultPort = Number(
  process.env['CERT_PREP_E2E_CAPTURE_RUNTIME_PORT'] ?? 8767,
);
const defaultToken =
  process.env['CERT_PREP_E2E_CAPTURE_RUNTIME_TOKEN'] ??
  'real-e2e-capture-runtime-token';
const apiVersion = '2.0';
const runtimeVersion = CAPTURE_RUNTIME_VERSION;
const schemaVersion = '2';
const captureDocumentSchemaSha256 =
  '850afd212d049c25da41d3867ba5477451a6a2c6c7e41f116fe60f26b6a35335';
const backendVenv = resolve(process.cwd(), '..', 'cert-prep-backend', '.venv');
const sitePackagesRoots = [resolve(backendVenv, 'Lib', 'site-packages')];
const linuxLib = resolve(backendVenv, 'lib');
if (existsSync(linuxLib)) {
  for (const entry of readdirSync(linuxLib, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('python')) {
      sitePackagesRoots.push(resolve(linuxLib, entry.name, 'site-packages'));
    }
  }
}
const contractBundlePath = sitePackagesRoots
  .map((sitePackages) =>
    resolve(
      sitePackages,
      'capture_runtime_client',
      'private',
      'assets',
      'contract-set.json',
    ),
  )
  .find((candidate) => existsSync(candidate));
if (!contractBundlePath) {
  throw new Error(
    `Capture Runtime contract asset was not found under ${backendVenv}. ` +
      `Checked: ${sitePackagesRoots.join(', ')}`,
  );
}
const contractBundleBytes = readFileSync(contractBundlePath);
const contractSetSha256 = createHash('sha256')
  .update(contractBundleBytes)
  .digest('hex');
const engineDigest = `sha256:${'a'.repeat(64)}`;
const maxChunkBytes = 1024 * 1024;
const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
const terminalEvents = new Set(['completed', 'failed', 'cancelled']);

type SourceKind = 'pdf' | 'image' | 'audio';
type CaptureStatus =
  | 'created'
  | 'waiting_input'
  | 'extracting'
  | 'awaiting_structuring'
  | 'structuring'
  | 'completed'
  | 'failed'
  | 'cancelled';

interface CaptureSource {
  readonly sha256: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly bytes: number;
}

interface IngestionRecord {
  readonly id: string;
  readonly clientRequestId: string;
  readonly kind: SourceKind;
  readonly fileName: string;
  readonly mediaType: string;
  readonly totalBytes: number;
  readonly sourceSha256: string;
  readonly expiresAt: string;
  readonly chunks: Map<number, ChunkRecord>;
  status: 'open' | 'ready';
  bytes: Buffer;
  finalizedSha256: string | null;
}

interface ChunkRecord {
  readonly index: number;
  readonly offset: number;
  readonly end: number;
  readonly digest: string;
  readonly idempotencyKey: string;
  readonly bytes: Buffer;
}

interface CaptureEvent {
  readonly protocolVersion: '2';
  readonly eventId: string;
  readonly sequence: number;
  readonly captureId: string;
  readonly kind: SourceKind;
  readonly eventType: string;
  readonly stage: string;
  readonly progress: number;
  readonly partialRevision?: number;
  readonly coveredUntilMs?: number;
  readonly segments?: readonly Record<string, unknown>[];
  readonly error?: Record<string, unknown>;
  readonly createdAt: string;
}

interface SseSubscriber {
  readonly response: ServerResponse;
  sequence: number;
}

interface IdempotentPayload {
  readonly key: string;
  readonly digest: string;
}

interface CaptureRecord {
  readonly id: string;
  readonly clientRequestId: string;
  readonly ingestionId: string;
  readonly kind: SourceKind;
  readonly source: CaptureSource;
  readonly createdAt: string;
  readonly events: CaptureEvent[];
  readonly subscribers: Set<SseSubscriber>;
  status: CaptureStatus;
  progress: number;
  partialRevision: number;
  updatedAt: string;
  completedAt: string | null;
  error: Record<string, unknown> | null;
  partial: Record<string, unknown> | null;
  document: Record<string, unknown> | null;
  extractionTimer: ReturnType<typeof setTimeout> | null;
  commit: IdempotentPayload | null;
  failure: IdempotentPayload | null;
}

export interface CaptureRuntimeFixtureOptions {
  readonly host?: string;
  readonly port?: number;
  readonly token?: string;
}

export function startCaptureRuntimeFixture(
  options: CaptureRuntimeFixtureOptions = {},
): Server {
  const host = options.host ?? defaultHost;
  const port = options.port ?? defaultPort;
  const token = options.token ?? defaultToken;
  const ingestions = new Map<string, IngestionRecord>();
  const ingestionsByRequest = new Map<string, string>();
  const captures = new Map<string, CaptureRecord>();
  const capturesByRequest = new Map<string, string>();

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(
        request.url ?? '/',
        `http://${request.headers.host ?? `${host}:${port}`}`,
      );
      if (request.method === 'GET' && url.pathname === '/__e2e/health') {
        writeJson(response, 200, { status: 'ok' });
        return;
      }
      if (!isAuthorized(request, token)) {
        writeProblem(
          response,
          401,
          'unauthorized',
          'Capture Runtime fixture requires a bearer token.',
        );
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v2/health/ready') {
        writeJson(response, 200, readiness());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/meta/v2/contracts') {
        writeJson(response, 200, contractIndex());
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/meta/v2/contracts/sha256/${contractSetSha256}`
      ) {
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': contractBundleBytes.byteLength,
          ETag: contractSetSha256,
          'X-Contract-Sha256': contractSetSha256,
        });
        response.end(contractBundleBytes);
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/v2/streaming/health/ready'
      ) {
        writeJson(response, 200, streamingReadiness());
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/v2/runtime/requirements'
      ) {
        writeJson(response, 200, runtimeRequirements());
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/ingestions') {
        await openIngestion(
          request,
          response,
          ingestions,
          ingestionsByRequest,
        );
        return;
      }
      const ingestionByRequest =
        /^\/v2\/ingestions\/by-client-request\/([^/]+)$/u.exec(url.pathname);
      if (request.method === 'GET' && ingestionByRequest !== null) {
        const clientRequestId = decodeURIComponent(ingestionByRequest[1]);
        const id = ingestionsByRequest.get(clientRequestId);
        const ingestion = id === undefined ? undefined : ingestions.get(id);
        if (ingestion === undefined) {
          writeProblem(response, 404, 'ingestion_not_found', 'Ingestion was not found.');
          return;
        }
        writeJson(response, 200, ingestionView(ingestion));
        return;
      }
      const chunkMatch =
        /^\/v2\/ingestions\/([^/]+)\/chunks\/([0-9]+)$/u.exec(url.pathname);
      if (request.method === 'PUT' && chunkMatch !== null) {
        const ingestion = ingestions.get(chunkMatch[1]);
        if (ingestion === undefined) {
          writeProblem(response, 404, 'ingestion_not_found', 'Ingestion was not found.');
          return;
        }
        await appendChunk(
          request,
          response,
          ingestion,
          Number(chunkMatch[2]),
        );
        return;
      }
      const finalizeMatch = /^\/v2\/ingestions\/([^/]+)\/finalize$/u.exec(
        url.pathname,
      );
      if (request.method === 'POST' && finalizeMatch !== null) {
        const ingestion = ingestions.get(finalizeMatch[1]);
        if (ingestion === undefined) {
          writeProblem(response, 404, 'ingestion_not_found', 'Ingestion was not found.');
          return;
        }
        await finalizeIngestion(request, response, ingestion);
        return;
      }
      const ingestionMatch = /^\/v2\/ingestions\/([^/]+)$/u.exec(url.pathname);
      if (ingestionMatch !== null) {
        const ingestion = ingestions.get(ingestionMatch[1]);
        if (ingestion === undefined) {
          writeProblem(response, 404, 'ingestion_not_found', 'Ingestion was not found.');
          return;
        }
        if (request.method === 'GET') {
          writeJson(response, 200, ingestionView(ingestion));
          return;
        }
        if (request.method === 'DELETE') {
          ingestions.delete(ingestion.id);
          ingestionsByRequest.delete(ingestion.clientRequestId);
          writeNoContent(response);
          return;
        }
      }
      if (request.method === 'POST' && url.pathname === '/v2/captures') {
        await startCapture(
          request,
          response,
          ingestions,
          captures,
          capturesByRequest,
        );
        return;
      }
      const captureByRequest =
        /^\/v2\/captures\/by-client-request\/([^/]+)$/u.exec(url.pathname);
      if (request.method === 'GET' && captureByRequest !== null) {
        const clientRequestId = decodeURIComponent(captureByRequest[1]);
        const id = capturesByRequest.get(clientRequestId);
        const capture = id === undefined ? undefined : captures.get(id);
        if (capture === undefined) {
          writeProblem(
            response,
            404,
            'capture_not_found',
            'Streaming capture was not found.',
          );
          return;
        }
        writeJson(response, 200, captureOperation(capture));
        return;
      }
      const captureRoute =
        /^\/v2\/captures\/([^/]+)(?:\/(events|partial|raw|result|cancel|structure(?:\/commit|\/failure)?))?$/u.exec(
          url.pathname,
        );
      if (captureRoute === null) {
        writeProblem(
          response,
          404,
          'not_found',
          'Capture Runtime fixture route not found.',
        );
        return;
      }
      const capture = captures.get(captureRoute[1]);
      if (capture === undefined) {
        writeProblem(
          response,
          404,
          'capture_not_found',
          'Streaming capture was not found.',
        );
        return;
      }
      const action = captureRoute[2];
      if (request.method === 'GET' && action === undefined) {
        writeJson(response, 200, captureOperation(capture));
        return;
      }
      if (request.method === 'GET' && action === 'events') {
        streamEvents(request, response, capture);
        return;
      }
      if (request.method === 'GET' && action === 'partial') {
        if (capture.partial === null) {
          writeProblem(
            response,
            409,
            'partial_unavailable',
            'Progressive partial capture is not available yet.',
          );
          return;
        }
        writeJson(response, 200, capture.partial);
        return;
      }
      if (request.method === 'GET' && action === 'raw') {
        if (capture.partial === null) {
          writeProblem(
            response,
            409,
            'raw_unavailable',
            'Raw capture diagnostics are not available yet.',
          );
          return;
        }
        writeJson(response, 200, rawCapture(capture));
        return;
      }
      if (request.method === 'GET' && action === 'result') {
        if (capture.document === null || capture.status !== 'completed') {
          writeProblem(
            response,
            409,
            'result_unavailable',
            'Structured progressive result is not available.',
          );
          return;
        }
        writeJson(response, 200, {
          operation: captureOperation(capture),
          raw: rawCapture(capture),
          result: capture.document,
        });
        return;
      }
      if (request.method === 'POST' && action === 'cancel') {
        cancelCapture(response, capture);
        return;
      }
      if (request.method === 'POST' && action === 'structure/commit') {
        await commitStructure(request, response, capture);
        return;
      }
      if (request.method === 'POST' && action === 'structure/failure') {
        await reportStructureFailure(request, response, capture);
        return;
      }
      if (request.method === 'POST' && action === 'structure') {
        writeProblem(
          response,
          409,
          'invalid_capture_state',
          'The fixture only supports host-owned structuring.',
        );
        return;
      }
      if (request.method === 'DELETE' && action === undefined) {
        if (!terminalStatuses.has(capture.status)) {
          writeProblem(
            response,
            409,
            'capture_delete_rejected',
            'Active captures must be cancelled before deletion.',
          );
          return;
        }
        closeCapture(capture);
        captures.delete(capture.id);
        capturesByRequest.delete(capture.clientRequestId);
        writeNoContent(response);
        return;
      }
      writeProblem(
        response,
        409,
        'invalid_capture_state',
        'Capture Runtime fixture state does not support this request.',
      );
    } catch {
      if (!response.headersSent) {
        writeProblem(
          response,
          500,
          'fixture_error',
          'Capture Runtime fixture rejected the request.',
        );
      } else {
        response.destroy();
      }
    }
  });

  server.listen(port, host);
  server.on('close', () => {
    for (const capture of captures.values()) closeCapture(capture);
  });
  return server;
}

async function openIngestion(
  request: IncomingMessage,
  response: ServerResponse,
  ingestions: Map<string, IngestionRecord>,
  byRequest: Map<string, string>,
): Promise<void> {
  const body = await readJsonObject(request);
  const clientRequestId = requiredString(body, 'clientRequestId');
  const kind = sourceKind(body['kind']);
  const fileName = requiredString(body, 'fileName');
  const mediaType = requiredString(body, 'mediaType');
  const totalBytes = positiveInteger(body['totalBytes']);
  const sourceSha256 = sha256(body['sourceSha256']);
  if (body['protocolVersion'] !== '2' || body['mode'] !== 'file') {
    writeProblem(response, 422, 'invalid_ingestion', 'Ingestion metadata is invalid.');
    return;
  }
  const existingId = byRequest.get(clientRequestId);
  if (existingId !== undefined) {
    const existing = ingestions.get(existingId);
    if (
      existing === undefined ||
      existing.kind !== kind ||
      existing.fileName !== fileName ||
      existing.mediaType !== mediaType ||
      existing.totalBytes !== totalBytes ||
      existing.sourceSha256 !== sourceSha256
    ) {
      writeProblem(
        response,
        409,
        'idempotency_conflict',
        'Ingestion request id was already used with different metadata.',
      );
      return;
    }
    writeJson(response, 201, ingestionView(existing));
    return;
  }
  const ingestion: IngestionRecord = {
    id: randomUUID(),
    clientRequestId,
    kind,
    fileName,
    mediaType,
    totalBytes,
    sourceSha256,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    chunks: new Map(),
    status: 'open',
    bytes: Buffer.alloc(0),
    finalizedSha256: null,
  };
  ingestions.set(ingestion.id, ingestion);
  byRequest.set(clientRequestId, ingestion.id);
  writeJson(response, 201, ingestionView(ingestion));
}

async function appendChunk(
  request: IncomingMessage,
  response: ServerResponse,
  ingestion: IngestionRecord,
  chunkIndex: number,
): Promise<void> {
  if (ingestion.status !== 'open') {
    writeProblem(response, 409, 'chunk_rejected', 'Ingestion is not open.');
    return;
  }
  const range = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/u.exec(
    header(request, 'content-range'),
  );
  const digestMatch = /^sha-256=([0-9a-f]{64})$/u.exec(
    header(request, 'digest'),
  );
  const idempotencyKey = header(request, 'x-idempotency-key');
  if (range === null || digestMatch === null || idempotencyKey === '') {
    writeProblem(
      response,
      422,
      'invalid_chunk_headers',
      'Content-Range, Digest, and idempotency headers are required.',
    );
    return;
  }
  const offset = Number(range[1]);
  const end = Number(range[2]);
  const total = Number(range[3]);
  const bytes = await readBody(request);
  const digest = digestMatch[1];
  if (
    total !== ingestion.totalBytes ||
    end < offset ||
    end - offset + 1 !== bytes.length ||
    bytes.length > maxChunkBytes
  ) {
    writeProblem(
      response,
      422,
      'chunk_length_mismatch',
      'Chunk boundaries do not match the ingestion.',
    );
    return;
  }
  if (createHash('sha256').update(bytes).digest('hex') !== digest) {
    writeProblem(
      response,
      409,
      'chunk_checksum_mismatch',
      'Chunk checksum does not match Digest.',
    );
    return;
  }
  const existing = ingestion.chunks.get(chunkIndex);
  if (existing !== undefined) {
    if (
      existing.offset !== offset ||
      existing.end !== end ||
      existing.digest !== digest ||
      existing.idempotencyKey !== idempotencyKey ||
      !existing.bytes.equals(bytes)
    ) {
      writeProblem(response, 409, 'chunk_conflict', 'Chunk retry does not match.');
      return;
    }
    writeJson(response, 200, ingestionView(ingestion));
    return;
  }
  if (
    chunkIndex !== ingestion.chunks.size ||
    offset !== ingestion.bytes.length
  ) {
    writeProblem(
      response,
      409,
      'chunk_out_of_order',
      'Chunks must be uploaded in contiguous order.',
    );
    return;
  }
  ingestion.chunks.set(chunkIndex, {
    index: chunkIndex,
    offset,
    end,
    digest,
    idempotencyKey,
    bytes,
  });
  ingestion.bytes = Buffer.concat([ingestion.bytes, bytes]);
  writeJson(response, 200, ingestionView(ingestion));
}

async function finalizeIngestion(
  request: IncomingMessage,
  response: ServerResponse,
  ingestion: IngestionRecord,
): Promise<void> {
  const body = await readJsonObject(request);
  const totalBytes = positiveInteger(body['totalBytes']);
  const declaredSha256 = sha256(body['sha256']);
  const actualSha256 = createHash('sha256').update(ingestion.bytes).digest('hex');
  if (
    body['protocolVersion'] !== '2' ||
    totalBytes !== ingestion.totalBytes ||
    ingestion.bytes.length !== ingestion.totalBytes ||
    declaredSha256 !== actualSha256 ||
    declaredSha256 !== ingestion.sourceSha256
  ) {
    writeProblem(
      response,
      409,
      'ingestion_finalize_rejected',
      'Finalized source metadata does not match the uploaded bytes.',
    );
    return;
  }
  ingestion.status = 'ready';
  ingestion.finalizedSha256 = declaredSha256;
  writeJson(response, 200, ingestionView(ingestion));
}

async function startCapture(
  request: IncomingMessage,
  response: ServerResponse,
  ingestions: ReadonlyMap<string, IngestionRecord>,
  captures: Map<string, CaptureRecord>,
  byRequest: Map<string, string>,
): Promise<void> {
  const body = await readJsonObject(request);
  const clientRequestId = requiredString(body, 'clientRequestId');
  const ingestionId = requiredString(body, 'ingestionId');
  if (
    body['protocolVersion'] !== '2' ||
    body['structuringMode'] !== 'host' ||
    body['startPolicy'] !== 'eager'
  ) {
    writeProblem(response, 422, 'invalid_capture', 'Capture metadata is invalid.');
    return;
  }
  const ingestion = ingestions.get(ingestionId);
  if (ingestion === undefined || ingestion.status !== 'ready') {
    writeProblem(response, 404, 'ingestion_not_found', 'Ready ingestion was not found.');
    return;
  }
  const existingId = byRequest.get(clientRequestId);
  if (existingId !== undefined) {
    const existing = captures.get(existingId);
    if (existing === undefined || existing.ingestionId !== ingestionId) {
      writeProblem(
        response,
        409,
        'idempotency_conflict',
        'Capture request id was already used with different metadata.',
      );
      return;
    }
    writeJson(response, 202, captureOperation(existing));
    return;
  }
  const now = new Date().toISOString();
  const capture: CaptureRecord = {
    id: randomUUID(),
    clientRequestId,
    ingestionId,
    kind: ingestion.kind,
    source: {
      sha256: ingestion.sourceSha256,
      fileName: ingestion.fileName,
      mediaType: ingestion.mediaType,
      bytes: ingestion.totalBytes,
    },
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    events: [],
    subscribers: new Set(),
    status: 'extracting',
    progress: 0.1,
    partialRevision: 0,
    error: null,
    partial: null,
    document: null,
    extractionTimer: null,
    commit: null,
    failure: null,
  };
  captures.set(capture.id, capture);
  byRequest.set(clientRequestId, capture.id);
  appendEvent(capture, {
    eventType: 'accepted',
    stage: 'extracting',
    progress: 0.1,
  });
  capture.extractionTimer = setTimeout(() => finishExtraction(capture), 25);
  writeJson(response, 202, captureOperation(capture));
}

function finishExtraction(capture: CaptureRecord): void {
  capture.extractionTimer = null;
  if (capture.status !== 'extracting') return;
  if (capture.kind === 'image') {
    const now = new Date().toISOString();
    capture.status = 'failed';
    capture.progress = 1;
    capture.updatedAt = now;
    capture.completedAt = now;
    capture.error = {
      code: 'no_text_detected',
      message: 'The deterministic image fixture contains no text.',
      stage: 'extracting',
      retryable: false,
    };
    appendEvent(capture, {
      eventType: 'failed',
      stage: 'failed',
      progress: 1,
      error: capture.error,
    });
    return;
  }
  const segments = captureSegments(capture.kind);
  const now = new Date().toISOString();
  capture.status = 'awaiting_structuring';
  capture.progress = 0.75;
  capture.partialRevision = 1;
  capture.updatedAt = now;
  capture.partial = {
    protocolVersion: '2',
    captureId: capture.id,
    source: capture.source,
    revision: 1,
    coveredUntilMs: capture.kind === 'audio' ? 2_000 : 0,
    segments,
    sourceText: segments.map((segment) => segment['text']).join('\n'),
    extractionEngine: extractionEngine(capture.kind),
    updatedAt: now,
  };
  appendEvent(capture, {
    eventType: 'segment',
    stage: 'extracting',
    progress: 0.65,
    partialRevision: 1,
    coveredUntilMs: capture.kind === 'audio' ? 2_000 : 0,
    segments,
  });
  appendEvent(capture, {
    eventType: 'checkpoint',
    stage: 'awaiting_structuring',
    progress: 0.75,
    partialRevision: 1,
    coveredUntilMs: capture.kind === 'audio' ? 2_000 : 0,
  });
}

function streamEvents(
  request: IncomingMessage,
  response: ServerResponse,
  capture: CaptureRecord,
): void {
  const cursorHeader = header(request, 'last-event-id');
  const cursor = cursorHeader === '' ? -1 : Number(cursorHeader);
  if (!Number.isSafeInteger(cursor) || cursor < -1) {
    writeProblem(
      response,
      422,
      'invalid_event_cursor',
      'Last-Event-ID must be an integer greater than or equal to -1.',
    );
    return;
  }
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  });
  let sequence = cursor;
  for (const event of capture.events) {
    if (event.sequence <= sequence) continue;
    response.write(eventFrame(event));
    sequence = event.sequence;
    if (terminalEvents.has(event.eventType)) {
      response.end();
      return;
    }
  }
  if (terminalStatuses.has(capture.status)) {
    response.end();
    return;
  }
  const subscriber: SseSubscriber = { response, sequence };
  capture.subscribers.add(subscriber);
  response.on('close', () => {
    capture.subscribers.delete(subscriber);
  });
}

async function commitStructure(
  request: IncomingMessage,
  response: ServerResponse,
  capture: CaptureRecord,
): Promise<void> {
  const key = header(request, 'x-idempotency-key');
  const bytes = await readBody(request);
  const payloadDigest = createHash('sha256').update(bytes).digest('hex');
  if (key === '') {
    writeProblem(response, 422, 'invalid_idempotency_key', 'Idempotency key is required.');
    return;
  }
  if (capture.commit !== null) {
    if (capture.commit.key !== key || capture.commit.digest !== payloadDigest) {
      writeProblem(
        response,
        409,
        'idempotency_conflict',
        'Structuring request id was already used with a different candidate.',
      );
      return;
    }
    writeJson(response, 200, captureOperation(capture));
    return;
  }
  if (capture.status !== 'awaiting_structuring' || capture.partial === null) {
    writeProblem(
      response,
      409,
      'invalid_capture_state',
      'Capture is not awaiting host structuring.',
    );
    return;
  }
  const candidate = parseJsonObject(bytes);
  const source = object(candidate['source']);
  if (
    candidate['schemaVersion'] !== '2' ||
    source['sha256'] !== capture.source.sha256 ||
    !Array.isArray(candidate['rawSegments']) ||
    !Array.isArray(candidate['blocks'])
  ) {
    writeProblem(
      response,
      422,
      'invalid_candidate',
      'Structured candidate does not match the capture source.',
    );
    return;
  }
  capture.commit = { key, digest: payloadDigest };
  capture.document = candidate;
  const now = new Date().toISOString();
  capture.status = 'completed';
  capture.progress = 1;
  capture.updatedAt = now;
  capture.completedAt = now;
  appendEvent(capture, {
    eventType: 'completed',
    stage: 'completed',
    progress: 1,
    partialRevision: capture.partialRevision,
  });
  writeJson(response, 200, captureOperation(capture));
}

async function reportStructureFailure(
  request: IncomingMessage,
  response: ServerResponse,
  capture: CaptureRecord,
): Promise<void> {
  const key = header(request, 'x-idempotency-key');
  const bytes = await readBody(request);
  const payloadDigest = createHash('sha256').update(bytes).digest('hex');
  if (key === '') {
    writeProblem(response, 422, 'invalid_idempotency_key', 'Idempotency key is required.');
    return;
  }
  if (capture.failure !== null) {
    if (capture.failure.key !== key || capture.failure.digest !== payloadDigest) {
      writeProblem(
        response,
        409,
        'idempotency_conflict',
        'Structuring failure request id conflicts with an earlier request.',
      );
      return;
    }
    writeJson(response, 200, captureOperation(capture));
    return;
  }
  if (capture.status !== 'awaiting_structuring') {
    writeProblem(
      response,
      409,
      'invalid_capture_state',
      'Capture is not awaiting host structuring.',
    );
    return;
  }
  const failure = parseJsonObject(bytes);
  const code = requiredString(failure, 'code');
  const message = requiredString(failure, 'message');
  capture.failure = { key, digest: payloadDigest };
  capture.status = 'failed';
  capture.progress = 1;
  capture.updatedAt = new Date().toISOString();
  capture.completedAt = capture.updatedAt;
  capture.error = { code, message, stage: 'structuring', retryable: false };
  appendEvent(capture, {
    eventType: 'failed',
    stage: 'failed',
    progress: 1,
    error: capture.error,
  });
  writeJson(response, 200, captureOperation(capture));
}

function cancelCapture(response: ServerResponse, capture: CaptureRecord): void {
  if (!terminalStatuses.has(capture.status)) {
    if (capture.extractionTimer !== null) {
      clearTimeout(capture.extractionTimer);
      capture.extractionTimer = null;
    }
    capture.status = 'cancelled';
    capture.progress = 1;
    capture.updatedAt = new Date().toISOString();
    capture.completedAt = capture.updatedAt;
    capture.error = null;
    appendEvent(capture, {
      eventType: 'cancelled',
      stage: 'cancelled',
      progress: 1,
      partialRevision: capture.partialRevision,
    });
  }
  writeJson(response, 200, captureOperation(capture));
}

function appendEvent(
  capture: CaptureRecord,
  input: Omit<
    CaptureEvent,
    'protocolVersion' | 'eventId' | 'sequence' | 'captureId' | 'kind' | 'createdAt'
  >,
): void {
  const sequence = capture.events.length;
  const event: CaptureEvent = {
    protocolVersion: '2',
    eventId: `${capture.id}/${sequence}`,
    sequence,
    captureId: capture.id,
    kind: capture.kind,
    ...input,
    createdAt: new Date().toISOString(),
  };
  capture.events.push(event);
  capture.updatedAt = event.createdAt;
  for (const subscriber of [...capture.subscribers]) {
    if (event.sequence <= subscriber.sequence) continue;
    subscriber.response.write(eventFrame(event));
    subscriber.sequence = event.sequence;
    if (terminalEvents.has(event.eventType)) {
      subscriber.response.end();
      capture.subscribers.delete(subscriber);
    }
  }
}

function closeCapture(capture: CaptureRecord): void {
  if (capture.extractionTimer !== null) clearTimeout(capture.extractionTimer);
  capture.extractionTimer = null;
  for (const subscriber of capture.subscribers) subscriber.response.end();
  capture.subscribers.clear();
}

function ingestionView(ingestion: IngestionRecord): Record<string, unknown> {
  return {
    protocolVersion: '2',
    kind: ingestion.kind,
    ingestionId: ingestion.id,
    status: ingestion.status,
    fileName: ingestion.fileName,
    mediaType: ingestion.mediaType,
    totalBytes: ingestion.totalBytes,
    receivedBytes: ingestion.bytes.length,
    contiguousBytes: ingestion.bytes.length,
    nextChunkIndex: ingestion.chunks.size,
    nextOffset: ingestion.bytes.length,
    sourceSha256: ingestion.sourceSha256,
    finalizedSha256: ingestion.finalizedSha256,
    expiresAt: ingestion.expiresAt,
  };
}

function captureOperation(capture: CaptureRecord): Record<string, unknown> {
  return {
    protocolVersion: '2',
    captureId: capture.id,
    ingestionId: capture.ingestionId,
    kind: capture.kind,
    status: capture.status,
    progress: capture.progress,
    partialRevision: capture.partialRevision,
    lastEventSequence: Math.max(0, capture.events.length - 1),
    source: capture.source,
    error: capture.error,
    createdAt: capture.createdAt,
    updatedAt: capture.updatedAt,
    completedAt: capture.completedAt,
  };
}

function rawCapture(capture: CaptureRecord): Record<string, unknown> {
  if (capture.partial === null) throw new Error('Partial capture is unavailable.');
  return {
    schemaVersion,
    diagnosticOnly: true,
    source: capture.source,
    segments: capture.partial['segments'],
    sourceText: capture.partial['sourceText'],
    extractionEngine: capture.partial['extractionEngine'],
    warnings: [],
    createdAt: capture.createdAt,
  };
}

function captureSegments(kind: SourceKind): readonly Record<string, unknown>[] {
  if (kind === 'audio') {
    return [
      {
        segmentId: 'segment-1',
        order: 0,
        locator: { kind: 'time', startMs: 0, endMs: 2_000 },
        text: 'Least privilege limits cloud permissions and reduces credential exposure.',
      },
    ];
  }
  return [
    {
      segmentId: 'segment-1',
      order: 0,
      locator: { kind: 'page', page: 1 },
      text: 'Least privilege limits cloud permissions and reduces credential exposure.',
    },
    {
      segmentId: 'segment-2',
      order: 1,
      locator: { kind: 'page', page: 2 },
      text: 'Defense in depth combines independent controls and reduces single points of failure.',
    },
  ];
}

function extractionEngine(kind: SourceKind): Record<string, unknown> {
  return {
    engine:
      kind === 'audio'
        ? 'capture-runtime-whisper'
        : 'capture-runtime-windowsml',
    model: CAPTURE_RUNTIME_MODEL,
    digest: engineDigest,
    device: 'test',
  };
}

function readiness(): Record<string, unknown> {
  return {
    ready: true,
    service: 'capture-runtime',
    apiVersion,
    runtimeVersion,
    captureDocumentSchemaVersion: schemaVersion,
    captureDocumentSchemaSha256,
    contractSetVersion: '2',
    capabilities: {
      captureKinds: ['pdf', 'image', 'audio'],
      structuringModes: ['host'],
      supportsCancellation: true,
      supportsRawDiagnostics: true,
      maxUploadBytes: 50_000_000,
    },
  };
}

function contractIndex(): Record<string, unknown> {
  return {
    catalogVersion: '2',
    runtimeVersion,
    contractSetVersion: '2',
    surfaces: [{ id: 'v2', title: 'Capture Runtime v2' }],
    sha256: contractSetSha256,
    href: `/meta/v2/contracts/sha256/${contractSetSha256}`,
  };
}

function streamingReadiness(): Record<string, unknown> {
  return {
    protocolVersion: '2',
    captureKinds: ['pdf', 'image', 'audio'],
    supportsProgressiveAudio: true,
    maxChunkBytes,
    checkpointIntervalMs: 1_000,
    heartbeatIntervalMs: 5_000,
    stallTimeoutMs: 90_000,
  };
}

function runtimeRequirements(): Record<string, unknown> {
  return {
    items: [
      {
        requirementId: 'windowsml-ocr',
        kind: 'ocr',
        displayName: 'WindowsML OCR',
        status: 'ready',
        requiredFor: ['pdf', 'image'],
        installStrategy: 'test',
      },
      {
        requirementId: 'whisper-primary',
        kind: 'speech-to-text',
        displayName: 'Whisper',
        status: 'ready',
        requiredFor: ['audio'],
        installStrategy: 'test',
      },
    ],
  };
}

function eventFrame(event: CaptureEvent): string {
  return `id: ${event.sequence}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`;
}

function sourceKind(value: unknown): SourceKind {
  if (value !== 'pdf' && value !== 'image' && value !== 'audio') {
    throw new Error('Source kind is invalid.');
  }
  return value;
}

function requiredString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const candidate = value[key];
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new Error(`${key} is required.`);
  }
  return candidate;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('A positive integer is required.');
  }
  return value;
}

function sha256(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error('A SHA-256 digest is required.');
  }
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('An object is required.');
  }
  return value as Record<string, unknown>;
}

function parseJsonObject(body: Buffer): Record<string, unknown> {
  return object(JSON.parse(body.toString('utf8')) as unknown);
}

async function readJsonObject(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  return parseJsonObject(await readBody(request));
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function writeProblem(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  writeJson(response, status, { error: { code, message } });
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(body.length),
    connection: 'close',
  });
  response.end(body);
}

function writeNoContent(response: ServerResponse): void {
  response.writeHead(204, { connection: 'close' });
  response.end();
}

const entry = process.argv[1];
if (
  entry !== undefined &&
  import.meta.url === pathToFileURL(resolve(entry)).href
) {
  const server = startCaptureRuntimeFixture();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}
