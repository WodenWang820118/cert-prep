import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import type {
  DocumentOperationRead,
  DocumentRead,
} from '../../contracts/api.contracts';
import type {
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
});

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

function operationRead(): DocumentOperationRead {
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
  };
}
