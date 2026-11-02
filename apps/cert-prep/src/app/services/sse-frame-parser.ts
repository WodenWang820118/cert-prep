export interface SseFrameLimits {
  readonly maxLineBytes: number;
  readonly maxFrameLines: number;
  readonly maxFrameBytes: number;
  readonly maxPayloadBytes: number;
}

/** A data-bearing block; consumers decide whether a missing id/event is valid. */
export interface RawSseFrame {
  readonly id: string | undefined;
  readonly event: string | undefined;
  readonly data: string;
}

/**
 * Incremental SSE field parser. Splits on CR, LF and CRLF (including a CRLF
 * cut across chunks), skips comments and retry hints, and enforces byte limits
 * while buffering so a hostile stream cannot grow memory without bound. Blocks
 * without `data:` are dropped. Payload validation, id/event rules and EOF
 * handling stay with each consumer.
 */
export class SseFrameParser {
  private line = '';
  private lineBytes = 0;
  private pendingHighSurrogate = false;
  private block: string[] = [];
  private blockBytes = 0;
  private pendingCarriageReturn = false;

  constructor(
    private readonly limits: SseFrameLimits,
    private readonly createError: () => Error,
  ) {}

  push(chunk: string): readonly RawSseFrame[] {
    const frames: RawSseFrame[] = [];
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

  /** Throws when the stream ended inside a line or an undispatched block. */
  finish(): void {
    if (
      this.pendingCarriageReturn ||
      this.line !== '' ||
      this.block.length > 0
    ) {
      throw this.createError();
    }
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
    if (this.lineBytes > this.limits.maxLineBytes) throw this.createError();
  }

  private emitLine(frames: RawSseFrame[]): void {
    if (this.line === '') {
      if (this.block.length > 0) {
        const frame = this.parseBlock(this.block);
        if (frame) frames.push(frame);
      }
      this.block = [];
      this.blockBytes = 0;
    } else {
      if (this.block.length >= this.limits.maxFrameLines) {
        throw this.createError();
      }
      this.block.push(this.line);
      this.blockBytes += this.lineBytes;
      if (this.blockBytes > this.limits.maxFrameBytes) {
        throw this.createError();
      }
    }
    this.line = '';
    this.lineBytes = 0;
    this.pendingHighSurrogate = false;
  }

  private parseBlock(lines: readonly string[]): RawSseFrame | undefined {
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
        if (payloadBytes > this.limits.maxPayloadBytes) {
          throw this.createError();
        }
      } else if (field === 'id') {
        id = value;
      } else if (field === 'event') {
        event = value;
      }
    }
    // Comment, retry and metadata-only blocks keep the transport alive but
    // dispatch nothing.
    if (data.length === 0) return undefined;
    return { id, event, data: data.join('\n') };
  }
}
