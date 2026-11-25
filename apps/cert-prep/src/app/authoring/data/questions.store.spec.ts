import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { CERT_PREP_API } from '../../core/data';
import { CertPrepSseClient } from '../../core/data';
import type { QuestionRead } from '../../core/domain';
import { QuestionsStore } from './questions.store';
import { ProjectStore } from '../../projects/data';
import { SourceImportStore } from '../../source-library/data';
import {
  sourceRead,
  manualQuestionGeneration,
  questionFixture,
} from './questions.store.spec-helpers';
import { provideCertPrepHttpResourceClientFake } from '../../core/testing';

describe('QuestionsStore editable questions', () => {
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
    apiClient.listQuestions.mockReset();
    apiClient.listQuestions.mockReturnValue(of({ items: [] }));
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

  it('exposes complete questions as playable and editable', () => {
    const store = TestBed.inject(QuestionsStore);
    const question = questionFixture();

    store.questions.set([question]);

    expect(store.playableQuestions()).toEqual([question]);
    expect(store.isPlayableQuestion(question)).toBe(true);
  });

  it('excludes questions that are missing playable question fields', () => {
    const store = TestBed.inject(QuestionsStore);
    const playable = questionFixture({ id: 'playable-question' });
    const incompleteCases: ReadonlyArray<{
      readonly overrides: Partial<QuestionRead>;
    }> = [
      { overrides: { question: '   ' } },
      { overrides: { choices: ['A', '   '] } },
      { overrides: { choices: ['A', 'B'], answer: '   ' } },
      { overrides: { choices: ['A', 'B'], answer: 'C' } },
      { overrides: { rationale: '   ' } },
      { overrides: { citation_page: null, source_excerpt: null } },
      { overrides: { citation_page: null, source_excerpt: '   ' } },
      { overrides: { source_question_number: null } },
      { overrides: { source_question_number: '   ' } },
    ];
    const incompleteQuestions = incompleteCases.map((testCase, index) =>
      questionFixture({
        id: `incomplete-question-${index + 1}`,
        ...testCase.overrides,
      }),
    );

    store.questions.set([playable, ...incompleteQuestions]);

    expect(store.playableQuestions()).toEqual([playable]);
    for (const question of incompleteQuestions) {
      expect(store.isPlayableQuestion(question)).toBe(false);
    }
  });

  it('keeps project playable questions while scoping the Questions panel to the active source', () => {
    const store = TestBed.inject(QuestionsStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const firstSource = sourceRead({ id: 'source-1', filename: 'first.pdf' });
    const secondSource = sourceRead({
      id: 'source-2',
      filename: 'second.pdf',
    });
    const firstQuestion = questionFixture({
      id: 'first-question',
      source_id: firstSource.id,
    });
    const secondQuestion = questionFixture({
      id: 'second-question',
      source_id: secondSource.id,
    });
    sourceImport.sources.set([firstSource, secondSource]);
    sourceImport.setActiveSourceId(secondSource.id);

    store.questions.set([firstQuestion, secondQuestion]);

    expect(store.playableQuestions()).toEqual([firstQuestion, secondQuestion]);
    expect(store.activeSourceQuestions()).toEqual([secondQuestion]);
    expect(store.activeSourcePlayableQuestions()).toEqual([secondQuestion]);
  });

  it('ignores stale question loads after the selected project changes', () => {
    const store = TestBed.inject(QuestionsStore);
    const projects = TestBed.inject(ProjectStore);
    const currentProjectQuestion = questionFixture({
      id: 'current-project-question',
      project_id: 'project-2',
    });
    const staleProjectQuestion = questionFixture({
      id: 'stale-project-question',
      project_id: 'project-1',
    });
    const staleQuestions = deferred<{ items: QuestionRead[] }>();
    apiClient.listQuestions.mockReturnValueOnce(staleQuestions.observable);
    store.questions.set([currentProjectQuestion]);

    store.load('project-1');
    projects.select('project-2');
    staleQuestions.resolve({ items: [staleProjectQuestion] });
    TestBed.tick();

    expect(store.questions()).toEqual([currentProjectQuestion]);
  });

  it('saves edited question text without a promotion request', () => {
    const store = TestBed.inject(QuestionsStore);
    const question = questionFixture({
      answer: null,
      rationale: null,
      answer_key_source: 'ai_inferred',
    });
    const saved = questionFixture({
      question: 'Updated question',
      answer: 'B',
      answer_key_source: 'manual',
      rationale: 'Manual rationale',
    });
    apiClient.updateQuestion.mockReturnValue(of(saved));
    store.questions.set([question]);
    store.startEdit(question);
    store.setEditQuestion(question.id, 'Updated question');
    store.setEditAnswer(question.id, 'B');
    store.setEditRationale(question.id, 'Manual rationale');

    store.saveQuestion(question);
    TestBed.tick();

    expect(apiClient.updateQuestion).toHaveBeenCalledWith(
      'project-1',
      question.id,
      expect.objectContaining({
        question: 'Updated question',
        answer: 'B',
        answer_key_source: 'manual',
        rationale: 'Manual rationale',
      }),
      { signal: expect.any(AbortSignal) },
    );
    expect(store.questions()).toEqual([saved]);
    expect(store.isEditing(saved)).toBe(false);
  });

  it('refreshes source metadata after generated questions are returned', () => {
    const store = TestBed.inject(QuestionsStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const question = questionFixture();
    const refreshedSource = sourceRead({ question_count: 1 });
    activateSource(sourceImport, sourceRead());
    apiClient.startManualQuestionGeneration.mockReturnValue(of(
      manualQuestionGeneration(),
    ));
    apiClient.getSource.mockReturnValue(of(refreshedSource));
    apiClient.listQuestions.mockReturnValue(of({ items: [question] }));

    store.generateQuestions('hybrid_reasoning');
    TestBed.tick();
    manualStream.next(manualQuestionGeneration({
      status: 'succeeded',
      phase: 'succeeded',
      cancellable: false,
      generated_count: 1,
    }));
    TestBed.tick();

    expect(store.questions()).toEqual([question]);
    expect(apiClient.listSourceQuestionJobs).toHaveBeenCalledWith(
      'project-1',
      'source-1',
    );
    expect(sourceImport.sources()).toEqual([refreshedSource]);
  });
});

function activateSource(
  sourceImport: SourceImportStore,
  source: ReturnType<typeof sourceRead>,
): void {
  sourceImport.sources.set([source]);
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
