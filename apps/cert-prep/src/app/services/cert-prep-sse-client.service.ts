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
import {
  MAX_FRAME_BYTES,
  MAX_FRAME_LINES,
  MAX_LINE_BYTES,
  MAX_PAYLOAD_BYTES,
} from '../constants/sse.constants';
import type {
  CertPrepSseJsonStreamInit,
  CertPrepSseStreamOptions,
  SseFrame,
} from '../contracts/sse.contracts';
import { CertPrepRuntimeConfig } from './cert-prep-api.service';
import {
  SseFrameParser,
  type RawSseFrame,
  type SseFrameLimits,
} from './sse-frame-parser';

export type {
  CertPrepSseJsonStreamInit,
  CertPrepSseStreamOptions,
} from '../contracts/sse.contracts';

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
      mergeMap(
        (response): Observable<T> =>
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
  const contentType = (
    response.headers.get('content-type') ?? ''
  ).toLowerCase();
  if (!contentType.startsWith('text/event-stream') || !response.body) {
    return throwError(() => invalidEventStream());
  }
  const body = response.body;

  return defer(() => {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const parser = new SseFrameParser(SSE_LIMITS, invalidEventStream);
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
        const frames = parser
          .push(done ? decodeText() : decodeText(value, true))
          .map(toSseFrame);
        const events = frames.map(decode);
        if (!done) return from(events);

        parser.finish();
        const emitted = from(events);
        return terminalSeen
          ? emitted
          : concat(
              emitted,
              throwError(() => nonTerminalEventStreamEof()),
            );
      }),
      finalize(() => {
        void reader.cancel().catch(() => undefined);
      }),
    );
  });
}

const SSE_LIMITS: SseFrameLimits = {
  maxLineBytes: MAX_LINE_BYTES,
  maxFrameLines: MAX_FRAME_LINES,
  maxFrameBytes: MAX_FRAME_BYTES,
  maxPayloadBytes: MAX_PAYLOAD_BYTES,
};

function toSseFrame(frame: RawSseFrame): SseFrame {
  const { id, event } = frame;
  if (
    id === undefined ||
    id.length === 0 ||
    event === undefined ||
    event.length === 0
  ) {
    throw invalidEventStream();
  }
  return { id, event, data: frame.data };
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
    signal.reason ??
    new DOMException('The operation was aborted.', 'AbortError')
  );
}
