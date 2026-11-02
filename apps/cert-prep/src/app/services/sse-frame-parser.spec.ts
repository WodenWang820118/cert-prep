import { SseFrameParser, type SseFrameLimits } from './sse-frame-parser';

const LIMITS: SseFrameLimits = {
  maxLineBytes: 64,
  maxFrameLines: 6,
  maxFrameBytes: 128,
  maxPayloadBytes: 32,
};

function createParser(limits: SseFrameLimits = LIMITS): SseFrameParser {
  return new SseFrameParser(limits, () => new Error('invalid stream'));
}

describe('SseFrameParser', () => {
  it('assembles a frame split across chunks', () => {
    const parser = createParser();

    expect(parser.push('id: 1\nev')).toEqual([]);
    expect(parser.push('ent: tick\ndata: {"a"')).toEqual([]);
    expect(parser.push(':1}\n\n')).toEqual([
      { id: '1', event: 'tick', data: '{"a":1}' },
    ]);
    expect(() => parser.finish()).not.toThrow();
  });

  it('treats CRLF, lone CR and a CRLF split between chunks as line ends', () => {
    const crlf = createParser();
    expect(crlf.push('id: 1\r\nevent: a\r\ndata: x\r\n\r\n')).toHaveLength(1);

    const lone = createParser();
    expect(lone.push('id: 2\revent: a\rdata: y\r\r')).toHaveLength(0);
    expect(lone.push('')).toHaveLength(1);

    const split = createParser();
    expect(split.push('id: 3\nevent: a\ndata: z\r')).toEqual([]);
    expect(split.push('\n\r')).toEqual([]);
    expect(split.push('\n')).toEqual([{ id: '3', event: 'a', data: 'z' }]);
    expect(() => split.finish()).not.toThrow();
  });

  it('skips comments and retry hints and drops blocks without data', () => {
    const parser = createParser();

    expect(parser.push(': keep-alive\n\nretry: 3000\n\n')).toEqual([]);
    expect(
      parser.push(': hi\nretry: 10\nid: 7\nevent: e\ndata: d\n\n'),
    ).toEqual([{ id: '7', event: 'e', data: 'd' }]);
  });

  it('joins multiple data lines and strips one leading space only', () => {
    expect(
      createParser().push('id: 1\nevent: e\ndata:  a\ndata\ndata: b\n\n'),
    ).toEqual([{ id: '1', event: 'e', data: ' a\n\nb' }]);
  });

  it('reports missing id and event as undefined for the consumer to judge', () => {
    expect(createParser().push('data: x\n\n')).toEqual([
      { id: undefined, event: undefined, data: 'x' },
    ]);
  });

  it('keeps the last id and event when repeated', () => {
    expect(
      createParser().push('id: 1\nid: 2\nevent: a\nevent: b\ndata: x\n\n'),
    ).toEqual([{ id: '2', event: 'b', data: 'x' }]);
  });

  it('fails when the stream ends mid-line, mid-block or after a bare CR', () => {
    const midLine = createParser();
    midLine.push('data: x');
    expect(() => midLine.finish()).toThrow('invalid stream');

    const midBlock = createParser();
    midBlock.push('data: x\n');
    expect(() => midBlock.finish()).toThrow('invalid stream');

    const danglingCr = createParser();
    danglingCr.push('data: x\n\r');
    expect(() => danglingCr.finish()).toThrow('invalid stream');
  });

  it('enforces the line, frame and payload limits with the injected error', () => {
    expect(() => createParser().push(`data: ${'a'.repeat(70)}`)).toThrow(
      'invalid stream',
    );
    expect(() =>
      createParser().push('a: 1\nb: 1\nc: 1\nd: 1\ne: 1\nf: 1\ng: 1\n'),
    ).toThrow('invalid stream');
    expect(() =>
      createParser({ ...LIMITS, maxFrameBytes: 20 }).push(
        `data: ${'a'.repeat(15)}\ndata: ${'b'.repeat(15)}\n`,
      ),
    ).toThrow('invalid stream');
    expect(() =>
      createParser().push(
        `data: ${'a'.repeat(20)}\ndata: ${'b'.repeat(20)}\n\n`,
      ),
    ).toThrow('invalid stream');
  });

  it('counts UTF-8 bytes, not UTF-16 units, against the line limit', () => {
    const limits = { ...LIMITS, maxLineBytes: 8 };

    expect(() => createParser(limits).push('data: €€\n')).toThrow(
      'invalid stream',
    );
    expect(() => createParser(limits).push('data: \u{1f600}\n')).toThrow(
      'invalid stream',
    );
    expect(createParser(limits).push('data: é\n\n')).toHaveLength(1);
  });
});
