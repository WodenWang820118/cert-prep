import {
  EMPTY,
  concat,
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
  CaptureEventV2,
  RawCaptureSegmentV1,
} from '@gx-capture/capture-workbench';

interface SseEventFrame {
  readonly id: string;
  readonly event: string;
  readonly data: string;
}

export interface CertPrepCaptureEventStreamInit extends RequestInit {
  readonly lastEventId?: string | number;
  readonly expectedCaptureId: string;
}

const STREAMING_EVENT_TYPES = new Set([
  'accepted',
  'input_checkpoint',
  'heartbeat',
  'segment',
  'checkpoint',
  'resync_required',
  'completed',
  'failed',
  'cancelled',
]);
const MAX_SSE_LINE_BYTES = 64 * 1024;
const MAX_SSE_FRAME_LINES = 1024;
const MAX_SSE_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_SSE_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_SSE_SEGMENTS = 10_000;

/** Cold authenticated SSE: every subscription fetches; teardown aborts fetch. */
export function certPrepCaptureEventStream(
  fetchImplementation: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: CertPrepCaptureEventStreamInit,
): Observable<CaptureEventV2> {
  return defer(() => {
    const controller = new AbortController();
    const externalSignal = init.signal ?? null;
    const abort = (): void => controller.abort();
    if (externalSignal?.aborted) return throwError(() => abortError(externalSignal));
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
): Observable<CaptureEventV2> {
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.startsWith('text/event-stream') || !response.body) {
    return throwError(() => invalidEventStream());
  }
  return eventStreamFromBody(
    response.body,
    expectedCaptureId,
    initialSequence,
  );
}

function eventStreamFromBody(
  body: ReadableStream<Uint8Array>,
  expectedCaptureId: string,
  initialSequence: number | undefined,
): Observable<CaptureEventV2> {
  return defer(() => {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const parser = new SseCaptureEventParser();
    let previousSequence = initialSequence;
    const decodeText = (value?: Uint8Array, streaming = false): string => {
      try {
        return decoder.decode(value, streaming ? { stream: true } : undefined);
      } catch {
        throw invalidEventStream();
      }
    };
    const decode = (frame: SseEventFrame): CaptureEventV2 => {
      const event = decodeCaptureEventFrame(frame, expectedCaptureId);
      if (previousSequence !== undefined && event.sequence <= previousSequence) {
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
        const frames = parser.push(
          done ? decodeText() : decodeText(value, true),
        );
        const events = frames.map(decode);
        return done
          ? concat(from(events), from(parser.finish().map(decode)))
          : from(events);
      }),
      finalize(() => {
        void reader.cancel().catch(() => undefined);
      }),
    );
  });
}

class SseCaptureEventParser {
  private line = '';
  private lineBytes = 0;
  private pendingHighSurrogate = false;
  private block: string[] = [];
  private blockBytes = 0;
  private pendingCarriageReturn = false;

  push(chunk: string): readonly SseEventFrame[] {
    const frames: SseEventFrame[] = [];
    let index = 0;
    if (this.pendingCarriageReturn) {
      this.pendingCarriageReturn = false;
      if (chunk[index] === '\n') index += 1;
      this.emitLine(frames);
    }
    while (index < chunk.length) {
      const character = chunk[index];
      index += 1;
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

  finish(): readonly SseEventFrame[] {
    const pending =
      this.pendingCarriageReturn || this.line !== '' || this.block.length > 0;
    this.line = '';
    this.lineBytes = 0;
    this.pendingHighSurrogate = false;
    this.block = [];
    this.blockBytes = 0;
    this.pendingCarriageReturn = false;
    if (pending) throw invalidEventStream();
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
      this.lineBytes += utf8BytesForCodeUnit(code);
    }
    if (this.lineBytes > MAX_SSE_LINE_BYTES) throw invalidEventStream();
  }

  private emitLine(frames: SseEventFrame[]): void {
    if (this.line === '') {
      if (this.block.length > 0) {
        const frame = parseSseBlock(this.block);
        if (frame) frames.push(frame);
      }
      this.block = [];
      this.blockBytes = 0;
    } else {
      if (this.block.length >= MAX_SSE_FRAME_LINES) throw invalidEventStream();
      this.block.push(this.line);
      this.blockBytes += this.lineBytes;
      if (this.blockBytes > MAX_SSE_FRAME_BYTES) throw invalidEventStream();
    }
    this.line = '';
    this.lineBytes = 0;
    this.pendingHighSurrogate = false;
  }
}

function parseSseBlock(lines: readonly string[]): SseEventFrame | undefined {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  let payloadBytes = 0;
  for (const rawLine of lines) {
    if (rawLine.startsWith(':')) continue;
    const colon = rawLine.indexOf(':');
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    const value =
      colon === -1 ? '' : rawLine.slice(colon + 1).replace(/^ /u, '');
    if (field === 'data') {
      data.push(value);
      payloadBytes += new TextEncoder().encode(value).byteLength;
      if (payloadBytes > MAX_SSE_PAYLOAD_BYTES) throw invalidEventStream();
    } else if (field === 'id') {
      id = value;
    } else if (field === 'event') {
      event = value;
    }
  }
  if (data.length === 0) {
    // Comments, retry hints, and metadata-only blocks keep the transport alive
    // but do not dispatch a CaptureEventV2.
    return undefined;
  }
  if (
    id === undefined ||
    !id ||
    id.includes('\0') ||
    event === undefined ||
    !event
  ) {
    throw invalidEventStream();
  }
  return { id, event, data: data.join('\n') };
}

function decodeCaptureEventFrame(
  frame: SseEventFrame,
  expectedCaptureId: string,
): CaptureEventV2 {
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
): CaptureEventV2 {
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
  if (eventType === 'segment' && (!Array.isArray(segments) || segments.length === 0)) {
    throw invalidEventStream();
  }
  if (Array.isArray(segments)) segments.forEach(validateSegment);
  const failure = value['error'];
  if (eventType === 'failed') {
    validateFailure(failure);
  } else if (failure !== undefined && failure !== null) {
    throw invalidEventStream();
  }
  return value as unknown as CaptureEventV2;
}

function validateSegment(value: unknown): asserts value is RawCaptureSegmentV1 {
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
          box.some((item) => typeof item !== 'number' || !Number.isFinite(item))))
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
    (value['retryable'] !== undefined && typeof value['retryable'] !== 'boolean')
  ) {
    throw invalidEventStream();
  }
}

function parseEventCursor(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const text = String(value);
  if (!/^-?\d+$/u.test(text)) throw invalidEventCursor();
  const cursor = Number(text);
  if (!Number.isSafeInteger(cursor) || cursor < -1) throw invalidEventCursor();
  return cursor;
}

function validRfc3339Timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(?<date>\d{4}-\d{2}-\d{2})T(?<clock>\d{2}:\d{2}:\d{2}(?:\.\d+)?)(?<zone>Z|[+-]\d{2}:\d{2})$/u.exec(
    value,
  );
  if (!match?.groups) return false;
  const [year, month, day] = match.groups['date'].split('-').map(Number);
  const [hours, minutes, seconds] = match.groups['clock'].split(':').map(Number);
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

function utf8BytesForCodeUnit(code: number): number {
  if (code <= 0x7f) return 1;
  if (code <= 0x7ff) return 2;
  return 3;
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
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function invalidEventStream(): Error {
  return new Error('Cert Prep capture event stream is invalid.');
}

function invalidEventCursor(): Error {
  return new Error('Cert Prep capture event cursor is invalid.');
}
