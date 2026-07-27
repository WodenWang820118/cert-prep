import { firstValueFrom } from 'rxjs';
import { DeterministicCaptureClient } from './deterministic-capture-client';

describe('DeterministicCaptureClient', () => {
  it('completes a PNG capture with the real file metadata and valid document schema', async () => {
    const client = new DeterministicCaptureClient();
    const file = new File(['png-demo'], 'practice.png', { type: 'image/png' });

    const job = await firstValueFrom(
      client.createCapture({
        clientRequestId: 'trial-request-1',
        file,
        sourceKind: 'image',
        structuringMode: 'runtime',
      }),
    );
    const document = await firstValueFrom(client.getResult(job.captureId));

    expect(job.status).toBe('completed');
    expect(job.stage).toBe('completed');
    expect(job.progress).toBe(1);
    expect(document).toMatchObject({
      schemaVersion: '1',
      source: {
        fileName: 'practice.png',
        mediaType: 'image/png',
        bytes: file.size,
      },
      blocks: [{ type: 'paragraph' }],
    });
    expect(document.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(document.sourceText).toContain('practice.png');
  });

  it('supports cancellation and deletion without a backend', async () => {
    const client = new DeterministicCaptureClient();
    const job = await firstValueFrom(
      client.createCapture({
        clientRequestId: 'trial-request-2',
        file: new File(['pdf-demo'], 'practice.pdf', {
          type: 'application/pdf',
        }),
        sourceKind: 'pdf',
        structuringMode: 'runtime',
      }),
    );

    const cancelled = await firstValueFrom(client.cancelCapture(job.captureId));
    expect(cancelled.status).toBe('cancelled');

    await firstValueFrom(client.deleteCapture(job.captureId));
    await expect(
      firstValueFrom(client.getCapture(job.captureId)),
    ).rejects.toThrow('Unknown trial capture');
  });
});
