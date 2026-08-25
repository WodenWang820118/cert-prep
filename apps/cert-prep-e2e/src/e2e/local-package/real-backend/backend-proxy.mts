import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

interface ProxyRule {
  readonly id: string;
  readonly method: string;
  readonly pathPattern: string;
  remainingFailures: number;
  readonly failureStatus: number;
  readonly delayBeforeForwardMs: number;
  matched: number;
  failures: number;
  forwarded: number;
  lastForwardStatus: number | null;
  lastOperationId: string | null;
}

const listenHost = '127.0.0.1';
const listenPort = Number.parseInt(
  process.env.CERT_PREP_E2E_PROXY_PORT ?? '8766',
  10,
);
const backendBaseUrl = new URL(
  process.env.CERT_PREP_E2E_BACKEND_URL ?? 'http://127.0.0.1:8765',
);

let rules: ProxyRule[] = [];

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(
      request.url ?? '/',
      `http://${request.headers.host ?? `${listenHost}:${listenPort}`}`,
    );
    if (requestUrl.pathname.startsWith('/__e2e/')) {
      await handleControlRequest(request, response, requestUrl);
      return;
    }

    const body = await readBody(request);
    const rule = matchingRule(request.method ?? 'GET', requestUrl.pathname);
    if (rule !== undefined) {
      rule.matched += 1;
      rule.lastOperationId = headerValue(
        request.headers['x-cert-prep-operation-id'],
      );
      if (rule.remainingFailures > 0) {
        rule.remainingFailures -= 1;
        rule.failures += 1;
        writeJson(
          response,
          rule.failureStatus,
          {
            code: 'e2e_transient_failure',
            message: 'Deterministic transient failure injected by the E2E harness.',
          },
          request.headers.origin,
        );
        return;
      }
      if (rule.delayBeforeForwardMs > 0) {
        await delay(rule.delayBeforeForwardMs);
      }
    }

    const targetUrl = new URL(
      `${requestUrl.pathname}${requestUrl.search}`,
      backendBaseUrl,
    );
    const upstream = await fetch(targetUrl, {
      method: request.method,
      headers: forwardedHeaders(request.headers),
      body: body.length === 0 ? undefined : Uint8Array.from(body),
      redirect: 'manual',
    });
    if (rule !== undefined) {
      rule.forwarded += 1;
      rule.lastForwardStatus = upstream.status;
    }
    const upstreamBody = Buffer.from(await upstream.arrayBuffer());
    if (response.destroyed) {
      return;
    }
    response.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
    response.end(upstreamBody);
  } catch (error) {
    if (response.destroyed) {
      return;
    }
    writeJson(response, 502, {
      code: 'e2e_proxy_failure',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(listenPort, listenHost);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

async function handleControlRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  if (request.method === 'GET' && requestUrl.pathname === '/__e2e/health') {
    writeJson(response, 200, { status: 'ok' });
    return;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/__e2e/stats') {
    writeJson(response, 200, { rules: rules.map(publicRule) });
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/__e2e/reset') {
    rules = [];
    writeJson(response, 200, { rules: [] });
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/__e2e/rules') {
    const input: unknown = JSON.parse(
      (await readBody(request)).toString('utf8'),
    );
    if (input === null || typeof input !== 'object') {
      throw new TypeError('request body must be an object');
    }
    rules = normalizeRules((input as Record<string, unknown>)['rules']);
    writeJson(response, 200, { rules: rules.map(publicRule) });
    return;
  }
  writeJson(response, 404, {
    code: 'not_found',
    message: 'Unknown E2E harness endpoint.',
  });
}

function normalizeRules(input: unknown): ProxyRule[] {
  if (!Array.isArray(input)) {
    throw new TypeError('rules must be an array');
  }
  return input.map((candidate, index) => {
    if (candidate === null || typeof candidate !== 'object') {
      throw new TypeError(`rule ${index} must be an object`);
    }
    const ruleInput = candidate as Record<string, unknown>;
    const id = String(ruleInput['id'] ?? `rule-${index + 1}`);
    const method = String(ruleInput['method'] ?? 'GET').toUpperCase();
    const pathPattern = String(ruleInput['pathPattern'] ?? '.*');
    // Compile eagerly so malformed test rules fail at configuration time.
    new RegExp(pathPattern);
    return {
      id,
      method,
      pathPattern,
      remainingFailures: positiveInteger(ruleInput['failCount'], 0),
      failureStatus: positiveInteger(ruleInput['failureStatus'], 503),
      delayBeforeForwardMs: positiveInteger(
        ruleInput['delayBeforeForwardMs'],
        0,
      ),
      matched: 0,
      failures: 0,
      forwarded: 0,
      lastForwardStatus: null,
      lastOperationId: null,
    };
  });
}

function matchingRule(method: string, pathname: string): ProxyRule | undefined {
  return rules.find(
    (rule) =>
      rule.method === method.toUpperCase() &&
      new RegExp(rule.pathPattern).test(pathname),
  );
}

function publicRule(rule: ProxyRule) {
  return {
    id: rule.id,
    method: rule.method,
    pathPattern: rule.pathPattern,
    remainingFailures: rule.remainingFailures,
    matched: rule.matched,
    failures: rule.failures,
    forwarded: rule.forwarded,
    lastForwardStatus: rule.lastForwardStatus,
    lastOperationId: rule.lastOperationId,
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

function forwardedHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (
      value === undefined ||
      ['connection', 'host', 'transfer-encoding'].includes(name.toLowerCase())
    ) {
      continue;
    }
    result[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return result;
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
  origin?: string,
): void {
  if (response.destroyed) {
    return;
  }
  const body = Buffer.from(JSON.stringify(value));
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(body.length),
  };
  if (origin !== undefined) {
    headers['access-control-allow-origin'] = origin;
    headers.vary = 'Origin';
  }
  response.writeHead(status, headers);
  response.end(body);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
