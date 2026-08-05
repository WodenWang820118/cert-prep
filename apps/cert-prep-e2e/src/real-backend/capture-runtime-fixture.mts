import { createHash, randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {
  CAPTURE_RUNTIME_MODEL,
  CAPTURE_RUNTIME_VERSION,
} from '../../../../tools/capture-runtime-version.mts';

const host = '127.0.0.1';
const port = Number(process.env['CERT_PREP_E2E_CAPTURE_RUNTIME_PORT'] ?? 8767);
const token = process.env['CERT_PREP_E2E_CAPTURE_RUNTIME_TOKEN'] ?? 'real-e2e-capture-runtime-token';
const apiVersion = '1.0';
const runtimeVersion = CAPTURE_RUNTIME_VERSION;
const schemaVersion = '1';
const digest = `sha256:${'a'.repeat(64)}`;

interface CaptureSource {
  readonly sha256: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly bytes: number;
}

interface CaptureRecord {
  readonly id: string;
  readonly source: CaptureSource;
  readonly raw: Record<string, unknown> | null;
  job: Record<string, unknown>;
  document: Record<string, unknown> | null;
}

const captures = new Map<string, CaptureRecord>();

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
    if (!isAuthorized(request)) {
      writeJson(response, 401, {
        error: {
          code: 'unauthorized',
          message: 'Capture Runtime fixture requires a bearer token.',
        },
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/health/ready') {
      writeJson(response, 200, readiness());
      return;
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/v1/runtime/requirements'
    ) {
      writeJson(response, 200, {
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
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/captures') {
      await createCapture(request, response);
      return;
    }

    const captureMatch =
      /^\/v1\/captures\/([^/]+)(?:\/(raw|result|structure|cancel))?$/u.exec(
        url.pathname,
      );
    if (captureMatch === null) {
      writeJson(response, 404, {
        error: {
          code: 'not_found',
          message: 'Capture Runtime fixture route not found.',
        },
      });
      return;
    }
    const capture = captures.get(captureMatch[1]);
    if (capture === undefined) {
      writeJson(response, 404, {
        error: { code: 'not_found', message: 'Capture not found.' },
      });
      return;
    }

    const action = captureMatch[2];
    if (request.method === 'GET' && action === undefined) {
      writeJson(response, 200, capture.job);
      return;
    }
    if (request.method === 'GET' && action === 'raw' && capture.raw !== null) {
      writeJson(response, 200, capture.raw);
      return;
    }
    if (
      request.method === 'GET' &&
      action === 'result' &&
      capture.document !== null
    ) {
      writeJson(response, 200, capture.document);
      return;
    }
    if (request.method === 'POST' && action === 'structure') {
      await commitStructure(request, response, capture);
      return;
    }
    if (request.method === 'POST' && action === 'cancel') {
      cancelCapture(response, capture);
      return;
    }
    if (request.method === 'DELETE' && action === undefined) {
      captures.delete(capture.id);
      response.writeHead(204).end();
      return;
    }
    writeJson(response, 409, {
      error: {
        code: 'invalid_state',
        message: 'Capture Runtime fixture state does not support this request.',
      },
    });
  } catch (error) {
    writeJson(response, 500, {
      error: {
        code: 'fixture_error',
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});

server.listen(port, host);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

async function createCapture(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBody(request);
  const multipart = parseMultipart(request.headers['content-type'], body);
  const source: CaptureSource = {
    sha256: createHash('sha256').update(multipart.fileBytes).digest('hex'),
    fileName: multipart.fileName,
    mediaType: multipart.mediaType,
    bytes: multipart.fileBytes.length,
  };
  const id = randomUUID();
  const now = new Date().toISOString();

  if (multipart.sourceKind === 'image') {
    const job = captureJob({
      id,
      source,
      status: 'failed',
      stage: 'failed',
      progress: 1,
      error: {
        code: 'no_text_detected',
        message: 'The deterministic image fixture contains no text.',
        stage: 'extracting',
        retryable: false,
      },
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    });
    captures.set(id, { id, source, raw: null, job, document: null });
    writeJson(response, 201, job);
    return;
  }

  const raw = rawCapture(source, multipart.sourceKind, now);
  const job = captureJob({
    id,
    source,
    status: 'running',
    stage: 'awaiting_structuring',
    progress: 0.75,
    error: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  });
  captures.set(id, { id, source, raw, job, document: null });
  writeJson(response, 201, job);
}

async function commitStructure(
  request: IncomingMessage,
  response: ServerResponse,
  capture: CaptureRecord,
): Promise<void> {
  if (capture.raw === null || capture.job['status'] !== 'running') {
    writeJson(response, 409, {
      error: {
        code: 'invalid_state',
        message: 'Capture is not awaiting host structuring.',
      },
    });
    return;
  }
  const candidate = JSON.parse(
    (await readBody(request)).toString('utf8'),
  ) as Record<string, unknown>;
  const now = new Date().toISOString();
  capture.document = candidate;
  capture.job = captureJob({
    id: capture.id,
    source: capture.source,
    status: 'completed',
    stage: 'completed',
    progress: 1,
    error: null,
    createdAt: String(capture.job['createdAt']),
    updatedAt: now,
    completedAt: now,
  });
  writeJson(response, 200, capture.job);
}

function cancelCapture(response: ServerResponse, capture: CaptureRecord): void {
  const now = new Date().toISOString();
  capture.job = captureJob({
    id: capture.id,
    source: capture.source,
    status: 'cancelled',
    stage: 'cancelled',
    progress: 1,
    error: null,
    createdAt: String(capture.job['createdAt']),
    updatedAt: now,
    completedAt: now,
  });
  writeJson(response, 200, capture.job);
}

function readiness(): Record<string, unknown> {
  return {
    ready: true,
    service: 'capture-runtime',
    apiVersion,
    runtimeVersion,
    captureDocumentSchemaVersion: schemaVersion,
    capabilities: {
      captureKinds: ['pdf', 'image', 'audio'],
      structuringModes: ['host'],
      supportsCancellation: true,
      supportsRawDiagnostics: true,
      maxUploadBytes: 50_000_000,
    },
  };
}

function captureJob(input: {
  readonly id: string;
  readonly source: CaptureSource;
  readonly status: string;
  readonly stage: string;
  readonly progress: number;
  readonly error: Record<string, unknown> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}): Record<string, unknown> {
  return {
    captureId: input.id,
    status: input.status,
    stage: input.stage,
    structuringMode: 'host',
    progress: input.progress,
    source: input.source,
    error: input.error,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    completedAt: input.completedAt,
  };
}

function rawCapture(
  source: CaptureSource,
  sourceKind: string,
  createdAt: string,
): Record<string, unknown> {
  const segments = [
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
  return {
    schemaVersion,
    diagnosticOnly: true,
    source,
    segments,
    sourceText: segments.map((segment) => segment.text).join('\n'),
    extractionEngine: {
      engine:
        sourceKind === 'audio'
          ? 'capture-runtime-whisper'
          : 'capture-runtime-windowsml',
      model: CAPTURE_RUNTIME_MODEL,
      digest,
      device: 'test',
    },
    warnings: [],
    createdAt,
  };
}

function parseMultipart(
  contentType: string | undefined,
  body: Buffer,
): {
  sourceKind: string;
  fileName: string;
  mediaType: string;
  fileBytes: Buffer;
} {
  const boundary = /boundary="?([^";]+)"?/u.exec(contentType ?? '')?.[1];
  if (boundary === undefined) {
    throw new Error('Capture fixture expected multipart form data.');
  }
  const delimiter = Buffer.from(`--${boundary}`);
  let sourceKind = 'pdf';
  let fileName = 'fixture.pdf';
  let mediaType = 'application/octet-stream';
  let fileBytes: Buffer | undefined;

  for (
    let start = body.indexOf(delimiter);
    start >= 0;
    start = body.indexOf(delimiter, start + delimiter.length)
  ) {
    const partStart = start + delimiter.length;
    if (body.subarray(partStart, partStart + 2).equals(Buffer.from('--'))) {
      break;
    }
    const contentStart = body.indexOf(Buffer.from('\r\n\r\n'), partStart);
    if (contentStart < 0) continue;
    const partEnd = body.indexOf(delimiter, contentStart + 4);
    if (partEnd < 0) continue;
    const headers = body.subarray(partStart, contentStart).toString('utf8');
    const content = body.subarray(contentStart + 4, partEnd - 2);
    const name = /name="([^"]+)"/u.exec(headers)?.[1];
    if (name === 'sourceKind') {
      sourceKind = content.toString('utf8');
    } else if (name === 'file') {
      fileBytes = content;
      fileName = /filename="([^"]*)"/u.exec(headers)?.[1] ?? fileName;
      mediaType =
        /^content-type:\s*(.+)$/imu.exec(headers)?.[1]?.trim() ?? mediaType;
    }
  }
  if (fileBytes === undefined) {
    throw new Error('Capture fixture did not receive a file part.');
  }
  return { sourceKind, fileName, mediaType, fileBytes };
}

function isAuthorized(request: IncomingMessage): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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
