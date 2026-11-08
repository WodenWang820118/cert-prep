import {
  EMPTY,
  defer,
  expand,
  finalize,
  from,
  map,
  mergeMap,
  throwError,
  type Observable,
} from 'rxjs';
import type {
  CaptureEvent,
  RawCaptureSegment,
} from '@gx-capture/capture-workbench-ui';
import {
  MAX_SSE_FRAME_BYTES,
  MAX_SSE_FRAME_LINES,
  MAX_SSE_LINE_BYTES,
  MAX_SSE_PAYLOAD_BYTES,
  MAX_SSE_SEGMENTS,
  STREAMING_EVENT_TYPES,
} from './constants/capture-workbench-trial.constants';
import {
  SseFrameParser,
  type RawSseFrame,
  type SseFrameLimits,
} from '../../core/data';
import type {
  CertPrepCaptureEventStreamInit,
  SseEventFrame,
} from './contracts/capture-workbench-trial.contracts';

export type { CertPrepCaptureEventStreamInit } from './contracts/capture-workbench-trial.contracts';

/** Cold authenticated SSE: every subscription fetches; teardown aborts fetch. */
export function certPrepCaptureEventStream(
  fetchImplementation: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: CertPrepCaptureEventStreamInit,
): Observable<CaptureEvent> {
  return defer(() => {
    const controller = new AbortController();
    const externalSignal = init.signal ?? null;
    const abort = (): void => controller.abort();
    if (externalSignal?.aborted)
      return throwError(() => abortError(externalSignal));
    externalSignal?.addEventListener('abort', abort, { once: true });
    const headers = new Headers(init.headers);
    if (init.lastEventId !== undefined) {
      headers.set('Last-Event-ID', String(init.lastEventId));
    }
    const initialSequence = parseEventCursor(init.lastEventId);
    return from(
      fetchImplementation(input, {
        ...init,
        headers,
        signal: controller.signal,
      }),
    ).pipe(
      mergeMap((response) =>
        response.ok
          ? eventStreamFromResponse(
              response,
              init.expectedCaptureId,
              initialSequence,
            )
          : throwError(() => invalidEventStream()),
      ),
      finalize(() => {
        externalSignal?.removeEventListener('abort', abort);
        controller.abort();
      }),
    );
  });
}

function eventStreamFromResponse(
  response: Response,
  expectedCaptureId: string,
  initialSequence: number | undefined,
): Observable<CaptureEvent> {
  const contentType = (
    response.headers.get('content-type') ?? ''
  ).toLowerCase();
  if (!contentType.startsWith('text/event-stream') || !response.body) {
    return throwError(() => invalidEventStream());
  }
  return eventStreamFromBody(response.body, expectedCaptureId, initialSequence);
}

function eventStreamFromBody(
  body: ReadableStream<Uint8Array>,
  expectedCaptureId: string,
  initialSequence: number | undefined,
): Observable<CaptureEvent> {
  return defer(() => {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const parser = new SseFrameParser(CAPTURE_SSE_LIMITS, invalidEventStream);
    let previousSequence = initialSequence;
    const decodeText = (value?: Uint8Array, streaming = false): string => {
      try {
        return decoder.decode(value, streaming ? { stream: true } : undefined);
      } catch {
        throw invalidEventStream();
      }
    };
    const decode = (frame: SseEventFrame): CaptureEvent => {
      const event = decodeCaptureEventFrame(frame, expectedCaptureId);
      if (
        previousSequence !== undefined &&
        event.sequence <= previousSequence
      ) {
        throw invalidEventStream();
      }
      previousSequence = event.sequence;
      return event;
    };
    const readChunk = () =>
      from(reader.read()).pipe(map(({ done, value }) => ({ done, value })));
    return readChunk().pipe(
      expand(({ done }) => (done ? EMPTY : readChunk())),
      mergeMap(({ done, value }) => {
        const frames = parser
          .push(done ? decodeText() : decodeText(value, true))
          .map(toSseEventFrame);
        const events = frames.map(decode);
        if (!done) return from(events);
        parser.finish();
        return from(events);
      }),
      finalize(() => {
        void reader.cancel().catch(() => undefined);
      }),
    );
  });
}

const CAPTURE_SSE_LIMITS: SseFrameLimits = {
  maxLineBytes: MAX_SSE_LINE_BYTES,
  maxFrameLines: MAX_SSE_FRAME_LINES,
  maxFrameBytes: MAX_SSE_FRAME_BYTES,
  maxPayloadBytes: MAX_SSE_PAYLOAD_BYTES,
};

function toSseEventFrame(frame: RawSseFrame): SseEventFrame {
  const { id, event } = frame;
  if (
    id === undefined ||
    !id ||
    id.includes('\0') ||
    event === undefined ||
    !event
  ) {
    throw invalidEventStream();
  }
  return { id, event, data: frame.data };
}

function decodeCaptureEventFrame(
  frame: SseEventFrame,
  expectedCaptureId: string,
): CaptureEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.data);
  } catch {
    throw invalidEventStream();
  }
  const event = normalizeCaptureEvent(parsed, expectedCaptureId);
  if (frame.id !== String(event.sequence) || frame.event !== event.eventType) {
    throw invalidEventStream();
  }
  return event;
}

function normalizeCaptureEvent(
  value: unknown,
  expectedCaptureId: string,
): CaptureEvent {
  if (!isRecord(value)) throw invalidEventStream();
  const allowedFields = new Set([
    'protocolVersion',
    'eventId',
    'sequence',
    'captureId',
    'kind',
    'eventType',
    'stage',
    'progress',
    'partialRevision',
    'coveredUntilMs',
    'segments',
    'error',
    'createdAt',
  ]);
  const sequence = value['sequence'];
  const captureId = value['captureId'];
  const eventType = value['eventType'];
  if (
    Object.keys(value).some((key) => !allowedFields.has(key)) ||
    value['protocolVersion'] !== '2' ||
    !safeNonNegativeInteger(sequence) ||
    captureId !== expectedCaptureId ||
    value['eventId'] !== `${captureId}/${sequence}` ||
    !['pdf', 'image', 'audio'].includes(String(value['kind'])) ||
    typeof eventType !== 'string' ||
    !STREAMING_EVENT_TYPES.has(eventType) ||
    !nonEmptyString(value['stage']) ||
    !validRfc3339Timestamp(value['createdAt'])
  ) {
    throw invalidEventStream();
  }
  const progress = value['progress'];
  if (
    progress !== undefined &&
    progress !== null &&
    (typeof progress !== 'number' ||
      !Number.isFinite(progress) ||
      progress < 0 ||
      progress > 1)
  ) {
    throw invalidEventStream();
  }
  for (const field of ['partialRevision', 'coveredUntilMs'] as const) {
    const candidate = value[field];
    if (
      candidate !== undefined &&
      candidate !== null &&
      !safeNonNegativeInteger(candidate)
    ) {
      throw invalidEventStream();
    }
  }
  const segments = value['segments'];
  if (
    segments !== undefined &&
    (!Array.isArray(segments) || segments.length > MAX_SSE_SEGMENTS)
  ) {
    throw invalidEventStream();
  }
  if (
    eventType === 'segment' &&
    (!Array.isArray(segments) || segments.length === 0)
  ) {
    throw invalidEventStream();
  }
  if (Array.isArray(segments)) segments.forEach(validateSegment);
  const failure = value['error'];
  if (eventType === 'failed') {
    validateFailure(failure);
  } else if (failure !== undefined && failure !== null) {
    throw invalidEventStream();
  }
  return value as unknown as CaptureEvent;
}

function validateSegment(value: unknown): asserts value is RawCaptureSegment {
  if (!isRecord(value)) throw invalidEventStream();
  if (
    Object.keys(value).some(
      (key) => !['segmentId', 'order', 'locator', 'text'].includes(key),
    ) ||
    !nonEmptyString(value['segmentId']) ||
    !safeNonNegativeInteger(value['order']) ||
    !nonEmptyString(value['text']) ||
    [...value['text']].length > 2_000_000 ||
    !isRecord(value['locator'])
  ) {
    throw invalidEventStream();
  }
  const locator = value['locator'];
  if (locator['kind'] === 'page') {
    const box = locator['boundingBox'];
    if (
      Object.keys(locator).some(
        (key) => !['kind', 'page', 'boundingBox'].includes(key),
      ) ||
      !safePositiveInteger(locator['page']) ||
      (box !== undefined &&
        box !== null &&
        (!Array.isArray(box) ||
          box.length !== 4 ||
          box.some(
            (item) => typeof item !== 'number' || !Number.isFinite(item),
          )))
    ) {
      throw invalidEventStream();
    }
    return;
  }
  if (
    locator['kind'] !== 'time' ||
    Object.keys(locator).some(
      (key) => !['kind', 'startMs', 'endMs'].includes(key),
    ) ||
    !safeNonNegativeInteger(locator['startMs']) ||
    !safePositiveInteger(locator['endMs']) ||
    locator['endMs'] <= locator['startMs']
  ) {
    throw invalidEventStream();
  }
}

function validateFailure(value: unknown): void {
  if (!isRecord(value)) throw invalidEventStream();
  if (
    Object.keys(value).some(
      (key) => !['code', 'message', 'stage', 'retryable'].includes(key),
    ) ||
    typeof value['code'] !== 'string' ||
    !/^[a-z][a-z0-9_]{1,63}$/u.test(value['code']) ||
    !nonEmptyString(value['message']) ||
    [...value['message']].length > 500 ||
    (value['stage'] !== undefined &&
      value['stage'] !== null &&
      !nonEmptyString(value['stage'])) ||
    (value['retryable'] !== undefined &&
      typeof value['retryable'] !== 'boolean')
  ) {
    throw invalidEventStream();
  }
}

function parseEventCursor(
  value: string | number | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const text = String(value);
  if (!/^-?\d+$/u.test(text)) throw invalidEventCursor();
  const cursor = Number(text);
  if (!Number.isSafeInteger(cursor) || cursor < -1) throw invalidEventCursor();
  return cursor;
}

function validRfc3339Timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match =
    /^(?<date>\d{4}-\d{2}-\d{2})T(?<clock>\d{2}:\d{2}:\d{2}(?:\.\d+)?)(?<zone>Z|[+-]\d{2}:\d{2})$/u.exec(
      value,
    );
  if (!match?.groups) return false;
  const [year, month, day] = match.groups['date'].split('-').map(Number);
  const [hours, minutes, seconds] = match.groups['clock']
    .split(':')
    .map(Number);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hours > 23 ||
    minutes > 59 ||
    seconds > 60
  ) {
    return false;
  }
  if (match.groups['zone'] !== 'Z') {
    const [offsetHours, offsetMinutes] = match.groups['zone']
      .slice(1)
      .split(':')
      .map(Number);
    if (offsetHours > 23 || offsetMinutes > 59) return false;
  }
  return true;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function safeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function safePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function abortError(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException('The operation was aborted.', 'AbortError')
  );
}

function invalidEventStream(): Error {
  return new Error('Cert Prep capture event stream is invalid.');
}

function invalidEventCursor(): Error {
  return new Error('Cert Prep capture event cursor is invalid.');
}
