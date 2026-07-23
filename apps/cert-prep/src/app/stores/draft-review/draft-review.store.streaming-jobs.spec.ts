import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { CERT_PREP_API } from '../../constants/cert-prep-api.constants';
import { DraftReviewStore } from './draft-review.store';
import { provideCertPrepHttpResourceClientFake } from '../../testing/cert-prep-http-resource-client.fake';
import { ProjectStore } from '../project.store';
import { SourceImportStore } from '../source-import/source-import.store';
import {
  documentRead,
  draftJob,
  questionDraft,
} from './draft-review.store.spec-helpers';

describe('DraftReviewStore streaming jobs', () => {
  const apiClient = {
    cancelDocumentDraftJob: vi.fn(),
    generateDocumentDrafts: vi.fn(),
    getDocument: vi.fn(),
    listDocumentChunks: vi.fn(),
    listDocumentDraftJobs: vi.fn(),
    listQuestionDrafts: vi.fn(),
    retryDocumentDraftJobs: vi.fn(),
    updateQuestionDraft: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        { provide: CERT_PREP_API, useValue: apiClient },
        provideCertPrepHttpResourceClientFake(apiClient),
      ],
    });

    const projects = TestBed.inject(ProjectStore);
    projects.projects.set([
      {
        id: 'project-1',
        name: 'JLPT N1',
        description: '',
        created_at: '2026-06-09T00:00:00Z',
        updated_at: '2026-06-09T00:00:00Z',
      },
    ]);
    projects.select('project-1');

    apiClient.getDocument.mockReturnValue(of(documentRead()));
    apiClient.listDocumentChunks.mockReturnValue(of({ items: [] }));
    apiClient.listDocumentDraftJobs.mockReturnValue(of({ items: [] }));
  });

  it('refreshes questions while a processing document has completed chunks', () => {
    const store = TestBed.inject(DraftReviewStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const draft = questionDraft();
    apiClient.listQuestionDrafts.mockReturnValue(of({ items: [draft] }));
    apiClient.listDocumentDraftJobs.mockReturnValue(of({
      items: [
        draftJob({ status: 'running' }),
        draftJob({ id: 'job-2', status: 'succeeded', generated_count: 1 }),
      ],
    }));

    activateDocument(
      sourceImport,
      documentRead({ status: 'processing', chunks_count: 1 }),
    );
    TestBed.tick();

    expect(apiClient.listQuestionDrafts).toHaveBeenCalledWith('project-1');
    expect(apiClient.listDocumentDraftJobs).toHaveBeenCalledWith(
      'project-1',
      'document-1',
    );
    expect(store.drafts()).toEqual([draft]);
    expect(store.draftJobSummary()).toEqual(
      expect.objectContaining({
        active: 1,
        generatedCount: 1,
        label: 'Generating 1/2',
        severity: 'info',
      }),
    );

    activateDocument(sourceImport, documentRead({ status: 'ready' }));
    TestBed.tick();
  });

  it('keeps streaming question refresh when job status is temporarily unavailable', () => {
    const store = TestBed.inject(DraftReviewStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const draft = questionDraft();
    apiClient.listQuestionDrafts.mockReturnValue(of({ items: [draft] }));
    apiClient.listDocumentDraftJobs.mockReturnValue(
      throwError(() => new Error('jobs offline')),
    );

    activateDocument(
      sourceImport,
      documentRead({ status: 'processing', chunks_count: 1 }),
    );
    TestBed.tick();

    expect(store.drafts()).toEqual([draft]);
    expect(store.draftJobs()).toEqual([]);
  });

  it('stops after bounded polling retries and lets the user retry explicitly', () => {
    vi.useFakeTimers();
    try {
      const store = TestBed.inject(DraftReviewStore);
      const sourceImport = TestBed.inject(SourceImportStore);
      apiClient.listQuestionDrafts.mockReturnValue(of({ items: [] }));
      apiClient.listDocumentDraftJobs.mockReturnValue(
        throwError(() => new Error('jobs offline')),
      );

      activateDocument(
        sourceImport,
        documentRead({ status: 'processing', chunks_count: 1 }),
      );
      TestBed.tick();

      vi.advanceTimersByTime(1000);
      vi.advanceTimersByTime(2000);
      vi.advanceTimersByTime(4000);
      TestBed.tick();

      expect(apiClient.listDocumentDraftJobs).toHaveBeenCalledTimes(4);
      expect(store.pollingError()).toContain('could not be refreshed');

      apiClient.listDocumentDraftJobs.mockReturnValue(of({ items: [] }));
      store.retryDraftPolling();
      TestBed.tick();

      expect(store.pollingError()).toBeNull();
      expect(apiClient.listDocumentDraftJobs).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces skipped streaming question jobs when the reasoning model is missing', () => {
    const store = TestBed.inject(DraftReviewStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    apiClient.listQuestionDrafts.mockReturnValue(of({ items: [] }));
    apiClient.listDocumentDraftJobs.mockReturnValue(of({
      items: [
        draftJob({
          status: 'skipped_missing_model',
          last_error: 'qwen3.5:4b is not installed',
        }),
      ],
    }));

    activateDocument(
      sourceImport,
      documentRead({ status: 'processing', chunks_count: 1 }),
    );
    TestBed.tick();

    expect(store.draftJobSummary()).toEqual(
      expect.objectContaining({
        label: 'Model missing',
        skipped: 1,
        severity: 'warn',
      }),
    );
  });

  it('ignores stale draft job responses after the active document changes', () => {
    const store = TestBed.inject(DraftReviewStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const firstDocument = documentRead({
      id: 'document-1',
      status: 'processing',
      chunks_count: 1,
    });
    const secondDocument = documentRead({
      id: 'document-2',
      filename: 'second.pdf',
      status: 'ready',
    });
    const draftJobs = deferred<{
      items: ReturnType<typeof draftJob>[];
    }>();
    apiClient.listQuestionDrafts.mockReturnValue(of({ items: [] }));
    apiClient.listDocumentDraftJobs.mockReturnValueOnce(draftJobs.observable);

    activateDocument(sourceImport, firstDocument, [firstDocument, secondDocument]);
    TestBed.tick();

    activateDocument(sourceImport, secondDocument, [firstDocument, secondDocument]);
    TestBed.tick();
    draftJobs.resolve({
      items: [draftJob({ document_id: firstDocument.id, status: 'running' })],
    });
    TestBed.tick();

    expect(store.draftJobs()).toEqual([]);
  });

  it('retries skipped streaming question jobs for the current document', () => {
    const store = TestBed.inject(DraftReviewStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const draft = questionDraft();
    const skippedJob = draftJob({
      status: 'skipped_missing_model',
      last_error: 'qwen3.5:4b is not installed',
    });
    const succeededJob = draftJob({
      status: 'succeeded',
      generated_count: 1,
      retry_count: 1,
    });
    activateDocument(sourceImport, documentRead());
    store.draftJobs.set([skippedJob]);
    apiClient.retryDocumentDraftJobs.mockReturnValue(of({ items: [succeededJob] }));
    apiClient.listQuestionDrafts.mockReturnValue(of({ items: [draft] }));

    store.retryDraftJobs();
    TestBed.tick();

    expect(apiClient.retryDocumentDraftJobs).toHaveBeenCalledWith(
      'project-1',
      'document-1',
      { signal: expect.any(AbortSignal) },
    );
    expect(store.draftJobs()).toEqual([succeededJob]);
    expect(store.drafts()).toEqual([draft]);
    expect(apiClient.getDocument).toHaveBeenCalledWith('project-1', 'document-1');
  });

  it('cancels every cancellable background generation job for the active document', () => {
    const store = TestBed.inject(DraftReviewStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const runningJob = draftJob({ status: 'running', phase: 'generating' });
    const canceledJob = draftJob({
      status: 'cancel_requested',
      phase: 'canceling',
    });
    activateDocument(sourceImport, documentRead());
    store.draftJobs.set([runningJob]);
    apiClient.cancelDocumentDraftJob.mockReturnValue(of(canceledJob));

    store.cancelActiveDraftJobs();
    TestBed.tick();

    expect(apiClient.cancelDocumentDraftJob).toHaveBeenCalledWith(
      'project-1',
      'document-1',
      'job-1',
    );
    expect(store.draftJobs()).toEqual([canceledJob]);
  });
});

function activateDocument(
  sourceImport: SourceImportStore,
  document: ReturnType<typeof documentRead>,
  documents: ReturnType<typeof documentRead>[] = [document],
): void {
  sourceImport.documents.set(documents);
  sourceImport.setActiveDocumentId(document.id);
}

function deferred<T>(): {
  readonly observable: Subject<T>;
  readonly resolve: (value: T) => void;
} {
  const observable = new Subject<T>();
  return {
    observable,
    resolve: (value) => {
      observable.next(value);
      observable.complete();
    },
  };
}
