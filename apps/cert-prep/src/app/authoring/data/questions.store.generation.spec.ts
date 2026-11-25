import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { CERT_PREP_API } from '../../core/data';
import { CertPrepSseClient } from '../../core/data';
import { OperationStore } from '../../core/data';
import { QuestionsStore } from './questions.store';
import { provideCertPrepHttpResourceClientFake } from '../../core/testing';
import { ProjectStore } from '../../projects/data';
import { SourceImportStore } from '../../source-library/data';
import {
  sourceRead,
  manualQuestionGeneration,
  questionFixture,
} from './questions.store.spec-helpers';

describe('QuestionsStore generation', () => {
  const apiClient = {
    startManualQuestionGeneration: vi.fn(),
    getManualQuestionGeneration: vi.fn(),
    cancelManualQuestionGeneration: vi.fn(),
    getSource: vi.fn(),
    listSourceChunks: vi.fn(),
    listSourceQuestionJobs: vi.fn(),
    listQuestions: vi.fn(),
    retrySourceQuestionJobs: vi.fn(),
    updateQuestion: vi.fn(),
  };
  let manualStream: Subject<ReturnType<typeof manualQuestionGeneration>>;
  const sseClient = { streamJson: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    manualStream = new Subject();
    sseClient.streamJson.mockReturnValue(manualStream.asObservable());
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

  it('uses source-file guidance when generation has no active source', () => {
    const store = TestBed.inject(QuestionsStore);
    const operations = TestBed.inject(OperationStore);

    store.generateQuestions();
    TestBed.tick();

    expect(operations.error()).toBe(
      'Upload a source file with extractable text before generating questions.',
    );
    expect(apiClient.startManualQuestionGeneration).not.toHaveBeenCalled();
  });

  it('sends deterministic strategy when generating deterministic questions', () => {
    const store = TestBed.inject(QuestionsStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const question = questionFixture();
    activateSource(sourceImport, sourceRead());
    apiClient.startManualQuestionGeneration.mockReturnValue(of(
      manualQuestionGeneration({ strategy: 'deterministic_only' }),
    ));
    apiClient.listQuestions.mockReturnValue(of({ items: [question] }));

    store.generateQuestions('deterministic_only');
    TestBed.tick();

    expect(apiClient.startManualQuestionGeneration).toHaveBeenCalledWith(
      'project-1',
      'source-1',
      { limit: 3, strategy: 'deterministic_only' },
      { signal: expect.any(AbortSignal) },
    );
    expect(sseClient.streamJson).toHaveBeenCalledWith(
      '/projects/project-1/sources/source-1/question-generations/manual-operation-1/events',
      'question-generation',
      { isTerminal: expect.any(Function) },
    );
    manualStream.next(manualQuestionGeneration({
      strategy: 'deterministic_only',
      status: 'succeeded',
      phase: 'succeeded',
      cancellable: false,
      generated_count: 1,
    }));
    TestBed.tick();
    expect(apiClient.listSourceQuestionJobs).toHaveBeenCalledWith(
      'project-1',
      'source-1',
    );
  });

  it('sends hybrid reasoning strategy when generating questions', () => {
    const store = TestBed.inject(QuestionsStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const question = questionFixture();
    store.setQuestionLimit(8);
    activateSource(sourceImport, sourceRead());
    apiClient.startManualQuestionGeneration.mockReturnValue(of(
      manualQuestionGeneration({ limit: 8 }),
    ));
    apiClient.listQuestions.mockReturnValue(of({ items: [question] }));

    store.generateQuestions('hybrid_reasoning');
    TestBed.tick();

    expect(apiClient.startManualQuestionGeneration).toHaveBeenCalledWith(
      'project-1',
      'source-1',
      { limit: 8, strategy: 'hybrid_reasoning' },
      { signal: expect.any(AbortSignal) },
    );
    manualStream.next(manualQuestionGeneration({
      limit: 8,
      status: 'succeeded',
      phase: 'succeeded',
      cancellable: false,
      generated_count: 1,
    }));
    TestBed.tick();
    expect(apiClient.listSourceQuestionJobs).toHaveBeenCalledWith(
      'project-1',
      'source-1',
    );
  });

  it('requests cancellation and applies the terminal manual operation event', () => {
    const store = TestBed.inject(QuestionsStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    activateSource(sourceImport, sourceRead());
    apiClient.startManualQuestionGeneration.mockReturnValue(of(
      manualQuestionGeneration(),
    ));
    apiClient.cancelManualQuestionGeneration.mockReturnValue(of(
      manualQuestionGeneration({
        status: 'cancel_requested',
        phase: 'canceling',
      }),
    ));

    store.generateQuestions();
    TestBed.tick();
    store.cancelManualQuestionGeneration();
    TestBed.tick();

    expect(apiClient.cancelManualQuestionGeneration).toHaveBeenCalledWith(
      'project-1',
      'source-1',
      'manual-operation-1',
    );
    expect(store.manualQuestionGeneration()?.status).toBe('cancel_requested');

    manualStream.next(manualQuestionGeneration({
      status: 'canceled',
      phase: 'canceled',
      cancellable: false,
    }));
    TestBed.tick();
    expect(store.manualQuestionGeneration()?.status).toBe('canceled');
  });
});

function activateSource(
  sourceImport: SourceImportStore,
  source: ReturnType<typeof sourceRead>,
): void {
  sourceImport.sources.set([source]);
  sourceImport.setActiveSourceId(source.id);
}
