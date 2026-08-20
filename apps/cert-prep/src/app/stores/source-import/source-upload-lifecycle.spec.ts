import { TestBed } from '@angular/core/testing';
import { defer, of, Subject } from 'rxjs';
import type {
  DocumentOperationRead,
  DocumentRead,
} from '../../contracts/api.contracts';
import type { DocumentOperationEvent } from '../../contracts/operation-events.contracts';
import type {
  SourceUploadItem,
  SourceUploadLifecycleHooks,
} from './contracts/source-import.contracts';
import { SourceUploadLifecycle } from './source-upload-lifecycle';

describe('SourceUploadLifecycle', () => {
  let lifecycle: SourceUploadLifecycle;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    lifecycle = TestBed.inject(SourceUploadLifecycle);
  });

  it('accepts configured hooks before starting a transport run', () => {
    const current = vi.fn(() => true);
    lifecycle.configure(hooks(current));

    const run = lifecycle.begin('project-1', 1, [], 2);

    expect(run.projectId).toBe('project-1');
    expect(run.contextEpoch).toBe(1);
    expect(current).toHaveBeenCalledWith('project-1', 1);

    lifecycle.invalidate();
    expect(lifecycle.hasActiveRun()).toBe(false);
  });

  it('does not starve cancellation behind a long-lived recovery stream', () => {
    let item = uploadItem();
    const uploadSubject = new Subject<DocumentRead>();
    const progressSubject = new Subject<DocumentOperationEvent>();
    const cancelSubject = new Subject<DocumentOperationRead>();
    let progressSubscribed = false;
    let cancelSubscribed = false;
    const cancelOperation = vi.fn(() =>
      defer(() => {
        cancelSubscribed = true;
        return cancelSubject.asObservable();
      }),
    );

    lifecycle.configure({
      item: () => item,
      current: () => true,
      patch: (_itemId, patch) => {
        item = { ...item, ...patch };
        return true;
      },
      accept: () => undefined,
      upload: () => uploadSubject.asObservable(),
      getDocument: () => of(documentRead()),
      getOperation: () => of(operationRead({ status: 'queued', phase: 'uploading' })),
      streamOperation: () =>
        defer(() => {
          progressSubscribed = true;
          return progressSubject.asObservable();
        }),
      cancelOperation,
      newOperationId: () => 'operation-1',
      errorMessage: () => 'error',
    });

    lifecycle.begin('project-1', 1, ['item-1'], 1);
    uploadSubject.error(new Error('upload transport failed'));

    expect(progressSubscribed).toBe(true);

    lifecycle.cancel('item-1');

    expect(cancelOperation).toHaveBeenCalledWith('project-1', 'operation-1');
    expect(cancelSubscribed).toBe(true);
    expect(item.status).toBe('cancel_requested');

    cancelSubject.next(
      operationRead({ status: 'canceled', phase: 'canceled', cancellable: false }),
    );

    expect(item.status).toBe('canceled');
    expect(item.error).toBeNull();
  });
});

function uploadItem(): SourceUploadItem {
  return {
    id: 'item-1',
    file: {} as File,
    status: 'queued',
    document: null,
    error: null,
  };
}

function hooks(current: () => boolean): SourceUploadLifecycleHooks {
  return {
    item: () => undefined,
    current,
    patch: () => true,
    accept: () => undefined,
    upload: () => of(documentRead()),
    getDocument: () => of(documentRead()),
    getOperation: () => of(operationRead()),
    cancelOperation: () => of(operationRead()),
    streamOperation: () => of({ operation: operationRead(), document: null }),
    newOperationId: () => 'operation-1',
    errorMessage: () => 'error',
  };
}

function documentRead(): DocumentRead {
  return {
    id: 'document-1',
    project_id: 'project-1',
    filename: 'guide.pdf',
    source_kind: 'pdf',
    status: 'ready',
    has_text: true,
    page_count: 1,
    processed_page_count: 1,
    chunks_count: 1,
    created_at: '2026-07-23T00:00:00Z',
    updated_at: '2026-07-23T00:00:01Z',
  } as DocumentRead;
}

function operationRead(
  overrides: Partial<DocumentOperationRead> = {},
): DocumentOperationRead {
  return {
    id: 'operation-1',
    project_id: 'project-1',
    document_id: null,
    status: 'queued',
    phase: 'uploading',
    cancellable: true,
    error: null,
    created_at: '2026-07-23T00:00:00Z',
    updated_at: '2026-07-23T00:00:01Z',
    ...overrides,
  };
}
