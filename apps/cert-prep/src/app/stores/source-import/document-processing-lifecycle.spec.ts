import type { DocumentOperationRead, DocumentRead } from '../../cert-prep-api';
import {
  DocumentProcessingLifecycle,
  type DocumentProcessingActionView,
  type DocumentProcessingLifecycleHooks,
} from './document-processing-lifecycle';

describe('DocumentProcessingLifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('cancels a restart-loaded processing document and follows the operation to canceled', async () => {
    const harness = createHarness();
    const cancelRequested = operationRead({
      id: operationId(1),
      document_id: 'document-1',
      status: 'cancel_requested',
      phase: 'canceling',
      cancellable: false,
    });
    harness.cancelDocument.mockResolvedValue(cancelRequested);
    harness.getDocument
      .mockResolvedValueOnce(
        documentRead({ status: 'cancel_requested', has_text: false }),
      )
      .mockResolvedValueOnce(
        documentRead({ status: 'canceled', has_text: false, chunks_count: 0 }),
      );
    harness.getOperation.mockResolvedValue(
      operationRead({
        ...cancelRequested,
        status: 'canceled',
        phase: 'canceled',
      }),
    );

    await harness.lifecycle.cancel('project-1', 0, 'document-1');

    expect(harness.cancelDocument).toHaveBeenCalledWith(
      'project-1',
      'document-1',
    );
    expect(harness.views.get('document-1')).toEqual(
      expect.objectContaining({ status: 'cancel_requested' }),
    );

    await vi.advanceTimersByTimeAsync(1000);

    expect(harness.getOperation).toHaveBeenCalledWith(
      'project-1',
      operationId(1),
    );
    expect(harness.accepted[harness.accepted.length - 1]?.status).toBe(
      'canceled',
    );
    expect(harness.views.has('document-1')).toBe(false);
    expect(harness.lifecycle.hasActiveAttempt('document-1')).toBe(false);
  });

  it.each([
    ['succeeded response', false],
    ['commit conflict', true],
  ])('preserves publish-wins after a cancel: %s', async (_label, conflict) => {
    const harness = createHarness();
    harness.getDocument.mockResolvedValue(documentRead({ status: 'ready' }));
    if (conflict) {
      harness.cancelDocument.mockRejectedValue({
        status: 409,
        error: { message: 'The document is already committing.' },
      });
    } else {
      harness.cancelDocument.mockResolvedValue(
        operationRead({
          id: operationId(2),
          document_id: 'document-1',
          status: 'succeeded',
          phase: 'completed',
          cancellable: false,
        }),
      );
    }

    await harness.lifecycle.cancel('project-1', 0, 'document-1');

    expect(harness.accepted).toEqual([
      expect.objectContaining({ id: 'document-1', status: 'ready' }),
    ]);
    expect(harness.views.has('document-1')).toBe(false);
    expect(harness.lifecycle.hasActiveAttempt('document-1')).toBe(false);
  });

  it('keeps watching a committing publish winner until the document is terminal', async () => {
    const harness = createHarness();
    harness.cancelDocument.mockRejectedValue({
      status: 409,
      error: { message: 'The document is already committing.' },
    });
    harness.getDocument
      .mockResolvedValueOnce(documentRead({ status: 'processing' }))
      .mockResolvedValueOnce(documentRead({ status: 'ready' }));

    await harness.lifecycle.cancel('project-1', 0, 'document-1');

    expect(harness.views.get('document-1')).toEqual(
      expect.objectContaining({ status: 'running', cancellable: false }),
    );
    await vi.advanceTimersByTimeAsync(1000);

    expect(harness.getDocument).toHaveBeenCalledTimes(2);
    expect(harness.accepted.map((document) => document.status)).toEqual([
      'processing',
      'ready',
    ]);
    expect(harness.views.has('document-1')).toBe(false);
  });

  it('retains one retry operation id through ambiguous POST, 404, and manual resume', async () => {
    const fixedOperationId = operationId(3);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(fixedOperationId);
    const harness = createHarness();
    harness.retryDocument.mockRejectedValue(new Error('response disconnected'));
    harness.getOperation.mockRejectedValue({ status: 404 });

    await harness.lifecycle.retry('project-1', 0, 'document-1');
    expect(harness.getOperation).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(harness.views.get('document-1')?.status).not.toBe(
      'status_unavailable',
    );
    await vi.advanceTimersByTimeAsync(4000);

    expect(harness.getOperation).toHaveBeenCalledTimes(4);
    expect(harness.views.get('document-1')).toEqual(
      expect.objectContaining({
        kind: 'retry',
        status: 'status_unavailable',
      }),
    );

    harness.getOperation.mockResolvedValue(
      operationRead({
        id: fixedOperationId,
        document_id: 'document-1',
        status: 'succeeded',
        phase: 'completed',
        cancellable: false,
      }),
    );
    harness.getDocument.mockResolvedValue(documentRead({ status: 'ready' }));
    await harness.lifecycle.resume('document-1');

    expect(harness.retryDocument).toHaveBeenCalledTimes(1);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
    expect(harness.retryDocument).toHaveBeenCalledWith(
      'project-1',
      'document-1',
      fixedOperationId,
      expect.any(AbortSignal),
    );
    expect(harness.getOperation).toHaveBeenLastCalledWith(
      'project-1',
      fixedOperationId,
    );
    expect(harness.views.has('document-1')).toBe(false);
  });

  it('keeps independent retry budgets for operation and document reads', async () => {
    const fixedOperationId = operationId(31);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(fixedOperationId);
    const harness = createHarness();
    harness.retryDocument.mockRejectedValue(new Error('POST disconnected'));
    harness.getOperation
      .mockRejectedValueOnce(new Error('operation unavailable 1'))
      .mockRejectedValueOnce(new Error('operation unavailable 2'))
      .mockResolvedValue(
        operationRead({
          id: fixedOperationId,
          document_id: 'document-1',
          status: 'succeeded',
          phase: 'completed',
          cancellable: false,
        }),
      );
    harness.getDocument.mockRejectedValue(new Error('document unavailable'));

    await harness.lifecycle.retry('project-1', 0, 'document-1');
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(harness.getOperation).toHaveBeenCalledTimes(3);
    expect(harness.getDocument).toHaveBeenCalledTimes(1);
    expect(harness.views.get('document-1')?.status).toBe('running');

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(harness.getDocument).toHaveBeenCalledTimes(3);
    expect(harness.views.get('document-1')?.status).toBe('running');

    await vi.advanceTimersByTimeAsync(4000);
    expect(harness.getDocument).toHaveBeenCalledTimes(4);
    expect(harness.views.get('document-1')?.status).toBe(
      'status_unavailable',
    );
  });

  it('issues an exact-operation tombstone before aborting an in-flight retry', async () => {
    const fixedOperationId = operationId(4);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(fixedOperationId);
    const harness = createHarness();
    const events: string[] = [];
    harness.retryDocument.mockImplementation(
      (_projectId, _documentId, _operationId, signal) =>
        new Promise<DocumentOperationRead>((_resolve, reject) => {
          events.push('post-start');
          signal.addEventListener('abort', () => {
            events.push('post-abort');
            reject(new DOMException('Canceled.', 'AbortError'));
          });
        }),
    );
    harness.cancelOperation.mockImplementation(async () => {
      events.push('delete-start');
      return operationRead({
        id: fixedOperationId,
        document_id: null,
        status: 'canceled',
        phase: 'canceled',
        cancellable: false,
      });
    });

    const retry = harness.lifecycle.retry('project-1', 0, 'document-1');
    await Promise.resolve();
    const cancel = harness.lifecycle.cancel('project-1', 0, 'document-1');
    await Promise.all([retry, cancel]);

    expect(events).toEqual(['post-start', 'delete-start', 'post-abort']);
    expect(harness.cancelOperation).toHaveBeenCalledWith(
      'project-1',
      fixedOperationId,
    );
    expect(harness.views.has('document-1')).toBe(false);
    expect(harness.getOperation).not.toHaveBeenCalled();
  });

  it('rejects a foreign document snapshot and reconciles only the expected operation', async () => {
    const fixedOperationId = operationId(5);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(fixedOperationId);
    const harness = createHarness();
    harness.retryDocument.mockResolvedValue(
      operationRead({
        id: fixedOperationId,
        document_id: 'foreign-document',
      }),
    );
    harness.getOperation.mockResolvedValue(
      operationRead({
        id: fixedOperationId,
        document_id: 'document-1',
        status: 'succeeded',
        phase: 'completed',
        cancellable: false,
      }),
    );
    harness.getDocument.mockResolvedValue(documentRead({ status: 'ready' }));

    await harness.lifecycle.retry('project-1', 0, 'document-1');
    expect(harness.accepted).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);

    expect(harness.getOperation).toHaveBeenCalledWith(
      'project-1',
      fixedOperationId,
    );
    expect(harness.accepted).toEqual([
      expect.objectContaining({ id: 'document-1' }),
    ]);
  });

  it('ignores late retry results and removes timers after invalidation', async () => {
    const harness = createHarness();
    const response = deferred<DocumentOperationRead>();
    harness.retryDocument.mockReturnValue(response.promise);

    const retry = harness.lifecycle.retry('project-1', 0, 'document-1');
    harness.lifecycle.invalidate();
    response.resolve(
      operationRead({
        id: operationId(6),
        document_id: 'document-1',
      }),
    );
    await retry;
    await vi.advanceTimersByTimeAsync(8000);

    expect(harness.views.size).toBe(0);
    expect(harness.accepted).toEqual([]);
    expect(harness.getOperation).not.toHaveBeenCalled();
  });

  it('fails a terminal retry request and reports a missing OCR runtime', async () => {
    const harness = createHarness();
    harness.retryDocument.mockRejectedValue({
      status: 503,
      error: {
        code: 'windowsml_runtime_missing',
        message: 'WindowsML runtime is missing.',
      },
    });

    await harness.lifecycle.retry('project-1', 0, 'document-1');

    expect(harness.views.get('document-1')).toEqual({
      kind: 'retry',
      status: 'failed',
      cancellable: false,
      error: 'WindowsML runtime is missing.',
    });
    expect(harness.runtimeMissing).toHaveBeenCalledTimes(1);
    expect(harness.getOperation).not.toHaveBeenCalled();
  });
});

function createHarness(): {
  readonly lifecycle: DocumentProcessingLifecycle;
  readonly views: Map<string, DocumentProcessingActionView>;
  readonly accepted: DocumentRead[];
  readonly retryDocument: ReturnType<typeof vi.fn>;
  readonly cancelDocument: ReturnType<typeof vi.fn>;
  readonly getDocument: ReturnType<typeof vi.fn>;
  readonly getOperation: ReturnType<typeof vi.fn>;
  readonly cancelOperation: ReturnType<typeof vi.fn>;
  readonly runtimeMissing: ReturnType<typeof vi.fn>;
} {
  const views = new Map<string, DocumentProcessingActionView>();
  const accepted: DocumentRead[] = [];
  const retryDocument = vi.fn();
  const cancelDocument = vi.fn();
  const getDocument = vi.fn();
  const getOperation = vi.fn();
  const cancelOperation = vi.fn();
  const runtimeMissing = vi.fn();
  const hooks: DocumentProcessingLifecycleHooks = {
    current: (projectId, contextEpoch) =>
      projectId === 'project-1' && contextEpoch === 0,
    setView: (documentId, view) => {
      if (view === null) {
        views.delete(documentId);
      } else {
        views.set(documentId, view);
      }
    },
    acceptDocument: (document) => accepted.push(document),
    retryDocument,
    cancelDocument,
    getDocument,
    getOperation,
    cancelOperation,
    errorMessage: (error) =>
      ((error as { error?: { message?: string } }).error?.message ??
        (error as { message?: string }).message ??
        'Document processing failed.'),
    errorCode: (error) =>
      (error as { error?: { code?: string } }).error?.code ?? null,
    runtimeMissing,
  };
  return {
    lifecycle: new DocumentProcessingLifecycle(hooks),
    views,
    accepted,
    retryDocument,
    cancelDocument,
    getDocument,
    getOperation,
    cancelOperation,
    runtimeMissing,
  };
}

function documentRead(overrides: Partial<DocumentRead> = {}): DocumentRead {
  return {
    id: 'document-1',
    project_id: 'project-1',
    filename: 'runtime.pdf',
    sha256: 'document-sha',
    language_hint: 'en',
    page_count: 8,
    has_text: true,
    status: 'ready',
    extraction_method: 'windowsml_ocr',
    ocr_device: 'igpu',
    ocr_fallback_reason: null,
    ocr_duration_ms: 222,
    processed_page_count: 8,
    parse_wall_duration_ms: 0,
    render_duration_ms: 0,
    ocr_engine_duration_ms: 222,
    ocr_worker_count: 1,
    first_chunk_ms: 0,
    exam_item_count: 0,
    content_profile: 'unknown',
    classification_detail: '',
    chunks_count: 8,
    created_at: '2026-06-18T00:00:00Z',
    updated_at: '2026-06-18T00:00:01Z',
    ...overrides,
  };
}

function operationRead(
  overrides: Partial<DocumentOperationRead> = {},
): DocumentOperationRead {
  return {
    id: operationId(9),
    project_id: 'project-1',
    document_id: 'document-1',
    status: 'running',
    phase: 'processing',
    cancellable: true,
    error: null,
    created_at: '2026-06-18T00:00:00Z',
    updated_at: '2026-06-18T00:00:01Z',
    ...overrides,
  };
}

function operationId(
  suffix: number,
): `${string}-${string}-${string}-${string}-${string}` {
  return `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}
