import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { CERT_PREP_API } from '../../core/data';
import { CertPrepSseClient } from '../../core/data';
import { QuestionsStore } from './questions.store';
import { provideCertPrepHttpResourceClientFake } from '../../core/testing';
import { ProjectStore } from '../../projects/data';
import { SourceImportStore } from '../../source-library/data';
import {
  documentRead,
  questionJob,
  questionFixture,
} from './questions.store.spec-helpers';

describe('QuestionsStore question jobs', () => {
  const apiClient = {
    cancelDocumentQuestionJob: vi.fn(),
    generateDocumentQuestions: vi.fn(),
    getDocument: vi.fn(),
    listDocumentChunks: vi.fn(),
    listDocumentQuestionJobs: vi.fn(),
    listQuestions: vi.fn(),
    retryDocumentQuestionJobs: vi.fn(),
    updateQuestion: vi.fn(),
  };
  let questionJobsStream: Subject<{ items: ReturnType<typeof questionJob>[] }>;
  const sseClient = { streamJson: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    questionJobsStream = new Subject();
    sseClient.streamJson.mockReturnValue(questionJobsStream.asObservable());
    TestBed.configureTestingModule({
      providers: [
        { provide: CERT_PREP_API, useValue: apiClient },
        { provide: CertPrepSseClient, useValue: sseClient },
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
    apiClient.listDocumentQuestionJobs.mockReturnValue(of({ items: [] }));
  });

  it('refreshes questions while a processing document has completed chunks', () => {
    const store = TestBed.inject(QuestionsStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const question = questionFixture();
    apiClient.listQuestions.mockReturnValue(of({ items: [question] }));
    apiClient.listDocumentQuestionJobs.mockReturnValue(of({
      items: [
        questionJob({ status: 'running' }),
        questionJob({ id: 'job-2', status: 'succeeded', generated_count: 1 }),
      ],
    }));

    activateDocument(
      sourceImport,
      documentRead({ status: 'processing', chunks_count: 1 }),
    );
    TestBed.tick();

    expect(apiClient.listQuestions).toHaveBeenCalledWith('project-1');
    expect(apiClient.listDocumentQuestionJobs).toHaveBeenCalledWith(
      'project-1',
      'document-1',
    );
    expect(sseClient.streamJson).toHaveBeenCalledWith(
      '/projects/project-1/documents/document-1/question-jobs/events',
      'question-jobs',
      { isTerminal: expect.any(Function) },
    );
    expect(store.questions()).toEqual([question]);
    expect(store.questionJobSummary()).toEqual(
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

  it('keeps refreshing questions when job status is temporarily unavailable', () => {
    const store = TestBed.inject(QuestionsStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const question = questionFixture();
    apiClient.listQuestions.mockReturnValue(of({ items: [question] }));
    apiClient.listDocumentQuestionJobs.mockReturnValue(
      throwError(() => new Error('jobs offline')),
    );

    activateDocument(
      sourceImport,
      documentRead({ status: 'processing', chunks_count: 1 }),
    );
    TestBed.tick();

    expect(store.questions()).toEqual([question]);
    expect(store.questionJobs()).toEqual([]);
  });

  it('surfaces an event-stream error and reconnects only on explicit retry', () => {
    const store = TestBed.inject(QuestionsStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    apiClient.listQuestions.mockReturnValue(of({ items: [] }));
    apiClient.listDocumentQuestionJobs.mockReturnValue(of({ items: [] }));

    activateDocument(
      sourceImport,
      documentRead({ status: 'processing', chunks_count: 1 }),
    );
    TestBed.tick();
    questionJobsStream.error(new Error('jobs offline'));
    TestBed.tick();

    expect(store.streamError()).toContain('could not be refreshed');

    const retryStream = new Subject<{ items: ReturnType<typeof questionJob>[] }>();
    sseClient.streamJson.mockReturnValueOnce(retryStream.asObservable());
    store.retryQuestionStream();
    TestBed.tick();

    expect(store.streamError()).toBeNull();
    expect(sseClient.streamJson).toHaveBeenCalledTimes(2);
  });

  it('surfaces skipped question jobs when the reasoning model is missing', () => {
    const store = TestBed.inject(QuestionsStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    apiClient.listQuestions.mockReturnValue(of({ items: [] }));
    apiClient.listDocumentQuestionJobs.mockReturnValue(of({
      items: [
        questionJob({
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

    expect(store.questionJobSummary()).toEqual(
      expect.objectContaining({
        label: 'Model missing',
        skipped: 1,
        severity: 'warn',
      }),
    );
  });

  it('ignores stale question job responses after the active document changes', () => {
    const store = TestBed.inject(QuestionsStore);
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
    const questionJobs = deferred<{
      items: ReturnType<typeof questionJob>[];
    }>();
    apiClient.listQuestions.mockReturnValue(of({ items: [] }));
    apiClient.listDocumentQuestionJobs.mockReturnValueOnce(questionJobs.observable);

    activateDocument(sourceImport, firstDocument, [firstDocument, secondDocument]);
    TestBed.tick();

    activateDocument(sourceImport, secondDocument, [firstDocument, secondDocument]);
    TestBed.tick();
    questionJobs.resolve({
      items: [questionJob({ document_id: firstDocument.id, status: 'running' })],
    });
    TestBed.tick();

    expect(store.questionJobs()).toEqual([]);
  });

  it('retries skipped question jobs for the current document', () => {
    const store = TestBed.inject(QuestionsStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const question = questionFixture();
    const skippedJob = questionJob({
      status: 'skipped_missing_model',
      last_error: 'qwen3.5:4b is not installed',
    });
    const succeededJob = questionJob({
      status: 'succeeded',
      generated_count: 1,
      retry_count: 1,
    });
    activateDocument(sourceImport, documentRead());
    store.questionJobs.set([skippedJob]);
    apiClient.retryDocumentQuestionJobs.mockReturnValue(of({ items: [succeededJob] }));
    apiClient.listQuestions.mockReturnValue(of({ items: [question] }));

    store.retryQuestionJobs();
    TestBed.tick();

    expect(apiClient.retryDocumentQuestionJobs).toHaveBeenCalledWith(
      'project-1',
      'document-1',
      { signal: expect.any(AbortSignal) },
    );
    expect(store.questionJobs()).toEqual([succeededJob]);
    expect(store.questions()).toEqual([question]);
    expect(apiClient.getDocument).toHaveBeenCalledWith('project-1', 'document-1');
  });

  it('cancels every cancellable background generation job for the active document', () => {
    const store = TestBed.inject(QuestionsStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const runningJob = questionJob({ status: 'running', phase: 'generating' });
    const canceledJob = questionJob({
      status: 'cancel_requested',
      phase: 'canceling',
    });
    activateDocument(sourceImport, documentRead());
    store.questionJobs.set([runningJob]);
    apiClient.cancelDocumentQuestionJob.mockReturnValue(of(canceledJob));

    store.cancelActiveQuestionJobs();
    TestBed.tick();

    expect(apiClient.cancelDocumentQuestionJob).toHaveBeenCalledWith(
      'project-1',
      'document-1',
      'job-1',
    );
    expect(store.questionJobs()).toEqual([canceledJob]);
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
