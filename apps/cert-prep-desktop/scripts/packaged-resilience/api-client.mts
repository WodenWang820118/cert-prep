import type { APIRequestContext } from 'playwright';

import { isRecord } from '../packaged-flow-smoke/text-utils.mts';

export interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface JsonRequestOptions {
  readonly data?: unknown;
  readonly multipart?: Readonly<Record<string, string | FilePayload>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface FilePayload {
  readonly name: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
}

export interface JsonTransport {
  request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    options?: JsonRequestOptions,
  ): Promise<JsonResponse>;
}

export interface PackagedApiContext {
  readonly apiBaseUrl: string;
  readonly authorization: string;
}

export function playwrightJsonTransport(
  request: APIRequestContext,
  context: PackagedApiContext,
): JsonTransport {
  const apiBaseUrl = context.apiBaseUrl.replace(/\/+$/, '');
  const authorization = context.authorization.trim();
  if (!/^https?:\/\/127\.0\.0\.1:\d+$/.test(apiBaseUrl)) {
    throw new Error('Packaged resilience API base URL must be loopback HTTP.');
  }
  if (!authorization) {
    throw new Error('Packaged resilience API requires captured authorization.');
  }
  return {
    async request(method, path, options = {}) {
      if (!path.startsWith('/') || path.startsWith('//')) {
        throw new Error(`Packaged resilience API path is not absolute: ${path}`);
      }
      const response = await request.fetch(`${apiBaseUrl}${path}`, {
        method,
        headers: {
          Authorization: authorization,
          ...options.headers,
        },
        ...(options.data === undefined ? {} : { data: options.data }),
        ...(options.multipart === undefined
          ? {}
          : { multipart: options.multipart }),
        timeout: options.timeoutMs ?? 120_000,
        maxRedirects: 0,
      });
      const text = await response.text();
      let body: unknown = null;
      if (text.trim()) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { invalid_json: true, response_length: text.length };
        }
      }
      return { status: response.status(), body };
    },
  };
}

export function requireJsonObject(
  response: JsonResponse,
  expectedStatuses: readonly number[],
  label: string,
): Record<string, unknown> {
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(`${label} returned HTTP ${response.status}.`);
  }
  if (!isRecord(response.body)) {
    throw new Error(`${label} did not return a JSON object.`);
  }
  return response.body;
}

export function requireApiErrorCode(
  response: JsonResponse,
  expectedStatus: number,
  expectedCode: string,
  label: string,
): void {
  const body = requireJsonObject(response, [expectedStatus], label);
  const detail = isRecord(body.detail) ? body.detail : body;
  const code = detail.code ?? body.code;
  if (code !== expectedCode) {
    throw new Error(`${label} did not return ${expectedCode}.`);
  }
}
