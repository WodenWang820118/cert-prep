import { firstValueFrom, toArray } from 'rxjs';
import { certPrepSseJsonStream } from './cert-prep-sse-client.service';

describe('certPrepSseJsonStream', () => {
  it('decodes frames split across UTF-8 chunks and sends the cursor', async () => {
    const payload =
      'id: 8\nevent: document-operation\ndata: {"detail":"翻譯中"}\n\n' +
      ': heartbeat\n\n' +
      'id: 9\nevent: document-operation\ndata: {"detail":"完成"}\n\n';
    const bytes = new TextEncoder().encode(payload);
    const split =
      new TextEncoder().encode(payload.slice(0, payload.indexOf('翻'))).byteLength +
      1;
    const fetchImplementation = vi.fn(async (_input, init) => {
      expect(new Headers(init?.headers).get('Last-Event-ID')).toBe('7');
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.slice(0, split));
            controller.enqueue(bytes.slice(split));
            controller.close();
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    });

    const values = await firstValueFrom(
      certPrepSseJsonStream<{ detail: string }>(
        fetchImplementation,
        'https://cert-prep.test/events',
        {
          eventName: 'document-operation',
          lastEventId: 7,
          isTerminal: () => true,
          headers: { Authorization: 'Bearer test-token' },
        },
      ).pipe(toArray()),
    );

    expect(values).toEqual([
      { detail: '翻譯中' },
      { detail: '完成' },
    ]);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('rejects a response that is not the requested event stream', async () => {
    const fetchImplementation = vi.fn(async () =>
      new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
    );

    await expect(
      firstValueFrom(
        certPrepSseJsonStream(
          fetchImplementation,
          'https://cert-prep.test/events',
          { eventName: 'document-operation', isTerminal: () => true },
        ),
      ),
    ).rejects.toThrow('invalid operation event stream');
  });

  it('aborts the fetch when the subscriber is disposed', async () => {
    let fetchSignal: AbortSignal | undefined;
    const fetchImplementation = vi.fn(async (_input, init) => {
      fetchSignal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array());
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    });

    const subscription = certPrepSseJsonStream(
      fetchImplementation,
      'https://cert-prep.test/events',
      { eventName: 'document-operation', isTerminal: () => true },
    ).subscribe();
    await Promise.resolve();
    subscription.unsubscribe();

    expect(fetchSignal?.aborted).toBe(true);
  });

  it('errors when EOF arrives before a terminal event', async () => {
    const fetchImplementation = vi.fn(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'id: 1\nevent: document-operation\ndata: {"status":"running"}\n\n',
              ),
            );
            controller.close();
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );

    await expect(
      firstValueFrom(
        certPrepSseJsonStream<{ status: string }>(
          fetchImplementation,
          'https://cert-prep.test/events',
          {
            eventName: 'document-operation',
            isTerminal: (value) => value.status === 'succeeded',
          },
        ).pipe(toArray()),
      ),
    ).rejects.toThrow('ended before a terminal event');
  });
});
