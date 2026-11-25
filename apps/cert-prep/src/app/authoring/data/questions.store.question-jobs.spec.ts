import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { CERT_PREP_API } from '../../core/data';
import { CertPrepSseClient } from '../../core/data';
import { QuestionsStore } from './questions.store';
import { provideCertPrepHttpResourceClientFake } from '../../core/testing';
import { ProjectStore } from '../../projects/data';
import { SourceImportStore } from '../../source-library/data';
import {
  sourceRead,
  questionJob,
  questionFixture,
} from './questions.store.spec-helpers';

describe('QuestionsStore question jobs', () => {
  const apiClient = {
    cancelSourceQuestionJob: vi.fn(),
    generateSourceQuestions: vi.fn(),
    getSource: vi.fn(),
    listSourceChunks: vi.fn(),
    listSourceQuestionJobs: vi.fn(),
    listQuestions: vi.fn(),
    retrySourceQuestionJobs: vi.fn(),
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

    apiClient.getSource.mockReturnValue(of(sourceRead()));
    apiClient.listSourceChunks.mockReturnValue(of({ items: [] }));
    apiClient.listSourceQuestionJobs.mockReturnValue(of({ items: [] }));
  });

  it('refreshes questions while a processing source has completed chunks', () => {
    const store = TestBed.inject(QuestionsStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const question = questionFixture();
    apiClient.listQuestions.mockReturnValue(of({ items: [question] }));
    apiClient.listSourceQuestionJobs.mockReturnValue(of({
      items: [
        questionJob({ status: 'running' }),
        questionJob({ id: 'job-2', status: 'succeeded', generated_count: 1 }),
      ],
    }));

    activateSource(
      sourceImport,
      sourceRead({ status: 'processing', chunks_count: 1 }),
    );
    TestBed.tick();

    expect(apiClient.listQuestions).toHaveBeenCalledWith('project-1');
    expect(apiClient.listSourceQuestionJobs).toHaveBeenCalledWith(
      'project-1',
      'source-1',
    );
    expect(sseClient.streamJson).toHaveBeenCalledWith(
      '/projects/project-1/sources/source-1/question-jobs/events',
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

    activateSource(sourceImport, sourceRead({ status: 'ready' }));
    TestBed.tick();
  });

  it('keeps refreshing questions when job status is temporarily unavailable', () => {
    const store = TestBed.inject(QuestionsStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const question = questionFixture();
    apiClient.listQuestions.mockReturnValue(of({ items: [question] }));
    apiClient.listSourceQuestionJobs.mockReturnValue(
      throwError(() => new Error('jobs offline')),
    );

    activateSource(
      sourceImport,
      sourceRead({ status: 'processing', chunks_count: 1 }),
    );
    TestBed.tick();

    expect(store.questions()).toEqual([question]);
    expect(store.questionJobs()).toEqual([]);
  });

  it('surfaces an event-stream error and reconnects only on explicit retry', () => {
    const store = TestBed.inject(QuestionsStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    apiClient.listQuestions.mockReturnValue(of({ items: [] }));
    apiClient.listSourceQuestionJobs.mockReturnValue(of({ items: [] }));

    activateSource(
      sourceImport,
      sourceRead({ status: 'processing', chunks_count: 1 }),
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
    apiClient.listSourceQuestionJobs.mockReturnValue(of({
      items: [
        questionJob({
          status: 'skipped_missing_model',
          last_error: 'qwen3.5:4b is not installed',
        }),
      ],
    }));

    activateSource(
      sourceImport,
      sourceRead({ status: 'processing', chunks_count: 1 }),
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

  it('ignores stale question job responses after the active source changes', () => {
    const store = TestBed.inject(QuestionsStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const firstSource = sourceRead({
      id: 'source-1',
      status: 'processing',
      chunks_count: 1,
    });
    const secondSource = sourceRead({
      id: 'source-2',
      filename: 'second.pdf',
      status: 'ready',
    });
    const questionJobs = deferred<{
      items: ReturnType<typeof questionJob>[];
    }>();
    apiClient.listQuestions.mockReturnValue(of({ items: [] }));
    apiClient.listSourceQuestionJobs.mockReturnValueOnce(questionJobs.observable);

    activateSource(sourceImport, firstSource, [firstSource, secondSource]);
    TestBed.tick();

    activateSource(sourceImport, secondSource, [firstSource, secondSource]);
    TestBed.tick();
    questionJobs.resolve({
      items: [questionJob({ source_id: firstSource.id, status: 'running' })],
    });
    TestBed.tick();

    expect(store.questionJobs()).toEqual([]);
  });

  it('retries skipped question jobs for the current source', () => {
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
    activateSource(sourceImport, sourceRead());
    store.questionJobs.set([skippedJob]);
    apiClient.retrySourceQuestionJobs.mockReturnValue(of({ items: [succeededJob] }));
    apiClient.listQuestions.mockReturnValue(of({ items: [question] }));

    store.retryQuestionJobs();
    TestBed.tick();

    expect(apiClient.retrySourceQuestionJobs).toHaveBeenCalledWith(
      'project-1',
      'source-1',
      { signal: expect.any(AbortSignal) },
    );
    expect(store.questionJobs()).toEqual([succeededJob]);
    expect(store.questions()).toEqual([question]);
    expect(apiClient.getSource).toHaveBeenCalledWith('project-1', 'source-1');
  });

  it('cancels every cancellable background generation job for the active source', () => {
    const store = TestBed.inject(QuestionsStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const runningJob = questionJob({ status: 'running', phase: 'generating' });
    const canceledJob = questionJob({
      status: 'cancel_requested',
      phase: 'canceling',
    });
    activateSource(sourceImport, sourceRead());
    store.questionJobs.set([runningJob]);
    apiClient.cancelSourceQuestionJob.mockReturnValue(of(canceledJob));

    store.cancelActiveQuestionJobs();
    TestBed.tick();

    expect(apiClient.cancelSourceQuestionJob).toHaveBeenCalledWith(
      'project-1',
      'source-1',
      'job-1',
    );
    expect(store.questionJobs()).toEqual([canceledJob]);
  });
});

function activateSource(
  sourceImport: SourceImportStore,
  source: ReturnType<typeof sourceRead>,
  sources: ReturnType<typeof sourceRead>[] = [source],
): void {
  sourceImport.sources.set(sources);
  sourceImport.setActiveSourceId(source.id);
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
