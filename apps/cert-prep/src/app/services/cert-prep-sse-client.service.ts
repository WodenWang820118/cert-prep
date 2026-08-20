import { inject, Injectable } from '@angular/core';
import {
  EMPTY,
  concat,
  defer,
  expand,
  finalize,
  from,
  map,
  mergeMap,
  Observable,
  throwError,
} from 'rxjs';
import { CertPrepRuntimeConfig } from './cert-prep-api.service';

export interface CertPrepSseJsonEvent<T> {
  readonly id: string;
  readonly event: string;
  readonly data: T;
}

interface SseFrame {
  readonly id: string;
  readonly event: string;
  readonly data: string;
}

export interface CertPrepSseStreamOptions<T> {
  readonly lastEventId?: string | number;
  readonly signal?: AbortSignal;
  readonly isTerminal: (value: T) => boolean;
}

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_LINES = 1024;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

@Injectable({ providedIn: 'root' })
export class CertPrepSseClient {
  private readonly runtimeConfig = inject(CertPrepRuntimeConfig);

  streamJson<T>(
    path: string,
    eventName: string,
    options: CertPrepSseStreamOptions<T>,
  ): Observable<T> {
    return defer(() =>
      this.runtimeConfig.getBackendConfig().pipe(
        mergeMap((config) =>
          certPrepSseJsonStream<T>(
            globalThis.fetch,
            `${config.base_url.replace(/\/+$/, '')}${path}`,
            {
              eventName,
              headers: { Authorization: `Bearer ${config.token}` },
              lastEventId: options.lastEventId,
              isTerminal: options.isTerminal,
              signal: options.signal,
            },
          ),
        ),
      ),
    );
  }
}

export interface CertPrepSseJsonStreamInit<T> extends RequestInit {
  readonly eventName: string;
  readonly lastEventId?: string | number;
  readonly isTerminal: (value: T) => boolean;
}

export function certPrepSseJsonStream<T>(
  fetchImplementation: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: CertPrepSseJsonStreamInit<T>,
): Observable<T> {
  return defer((): Observable<T> => {
    const controller = new AbortController();
    const externalSignal = init.signal ?? null;
    const abort = (): void => controller.abort();
    if (externalSignal?.aborted) {
      return throwError(() => abortError(externalSignal));
    }
    externalSignal?.addEventListener('abort', abort, { once: true });

    const headers = new Headers(init.headers);
    headers.set('Accept', 'text/event-stream');
    if (init.lastEventId !== undefined) {
      headers.set('Last-Event-ID', String(init.lastEventId));
    }

    return from(
      fetchImplementation(input, {
        ...init,
        headers,
        signal: controller.signal,
      }),
    ).pipe(
      mergeMap((response): Observable<T> =>
        response.ok
          ? jsonEventsFromResponse(response, init.eventName, init.isTerminal)
          : throwError(() => invalidEventStream()),
      ),
      finalize(() => {
        externalSignal?.removeEventListener('abort', abort);
        controller.abort();
      }),
    );
  });
}

function jsonEventsFromResponse<T>(
  response: Response,
  expectedEventName: string,
  isTerminal: (value: T) => boolean,
): Observable<T> {
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.startsWith('text/event-stream') || !response.body) {
    return throwError(() => invalidEventStream());
  }
  const body = response.body;

  return defer(() => {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const parser = new SseParser();
    let terminalSeen = false;
    const readChunk = () =>
      from(reader.read()).pipe(map(({ done, value }) => ({ done, value })));
    const decodeText = (value?: Uint8Array, streaming = false): string => {
      try {
        return decoder.decode(value, streaming ? { stream: true } : undefined);
      } catch {
        throw invalidEventStream();
      }
    };
    const decode = (frame: SseFrame): T => {
      if (frame.event !== expectedEventName) {
        throw invalidEventStream();
      }
      try {
        const value = JSON.parse(frame.data) as T;
        if (isTerminal(value)) terminalSeen = true;
        return value;
      } catch {
        throw invalidEventStream();
      }
    };

    return readChunk().pipe(
      expand(({ done }) => (done ? EMPTY : readChunk())),
      mergeMap(({ done, value }) => {
        const frames = parser.push(
          done ? decodeText() : decodeText(value, true),
        );
        const events = frames.map(decode);
        if (!done) return from(events);

        const finalEvents = parser.finish().map(decode);
        const emitted = from([...events, ...finalEvents]);
        return terminalSeen
          ? emitted
          : concat(emitted, throwError(() => nonTerminalEventStreamEof()));
      }),
      finalize(() => {
        void reader.cancel().catch(() => undefined);
      }),
    );
  });
}

class SseParser {
  private line = '';
  private lineBytes = 0;
  private pendingHighSurrogate = false;
  private block: string[] = [];
  private blockBytes = 0;
  private pendingCarriageReturn = false;

  push(chunk: string): readonly SseFrame[] {
    const frames: SseFrame[] = [];
    let index = 0;
    if (this.pendingCarriageReturn) {
      this.pendingCarriageReturn = false;
      if (chunk[index] === '\n') index += 1;
      this.emitLine(frames);
    }
    while (index < chunk.length) {
      const character = chunk[index++];
      if (character === '\r') {
        if (index === chunk.length) {
          this.pendingCarriageReturn = true;
        } else {
          if (chunk[index] === '\n') index += 1;
          this.emitLine(frames);
        }
      } else if (character === '\n') {
        this.emitLine(frames);
      } else {
        this.appendLineCharacter(character);
      }
    }
    return frames;
  }

  finish(): readonly SseFrame[] {
    if (
      this.pendingCarriageReturn ||
      this.line !== '' ||
      this.block.length > 0
    ) {
      throw invalidEventStream();
    }
    return [];
  }

  private appendLineCharacter(character: string): void {
    this.line += character;
    const code = character.charCodeAt(0);
    if (this.pendingHighSurrogate) {
      this.pendingHighSurrogate = false;
      this.lineBytes += 1;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      this.pendingHighSurrogate = true;
      this.lineBytes += 3;
    } else {
      this.lineBytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
    }
    if (this.lineBytes > MAX_LINE_BYTES) throw invalidEventStream();
  }

  private emitLine(frames: SseFrame[]): void {
    if (this.line === '') {
      if (this.block.length > 0) {
        const frame = parseSseBlock(this.block);
        if (frame) frames.push(frame);
      }
      this.block = [];
      this.blockBytes = 0;
    } else {
      if (this.block.length >= MAX_FRAME_LINES) throw invalidEventStream();
      this.block.push(this.line);
      this.blockBytes += this.lineBytes;
      if (this.blockBytes > MAX_FRAME_BYTES) throw invalidEventStream();
    }
    this.line = '';
    this.lineBytes = 0;
    this.pendingHighSurrogate = false;
  }
}

function parseSseBlock(lines: readonly string[]): SseFrame | undefined {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  let payloadBytes = 0;
  for (const rawLine of lines) {
    if (rawLine.startsWith(':')) continue;
    const colon = rawLine.indexOf(':');
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    const value = colon === -1 ? '' : rawLine.slice(colon + 1).replace(/^ /u, '');
    if (field === 'data') {
      data.push(value);
      payloadBytes += new TextEncoder().encode(value).byteLength;
      if (payloadBytes > MAX_PAYLOAD_BYTES) throw invalidEventStream();
    } else if (field === 'id') {
      id = value;
    } else if (field === 'event') {
      event = value;
    }
  }
  if (data.length === 0) return undefined;
  if (id === undefined || id.length === 0 || event === undefined || event.length === 0) {
    throw invalidEventStream();
  }
  return { id, event, data: data.join('\n') };
}

function invalidEventStream(): Error {
  return new Error('The server returned an invalid operation event stream.');
}

function nonTerminalEventStreamEof(): Error {
  return new Error(
    'The operation event stream ended before a terminal event was received.',
  );
}

function abortError(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
  );
}
