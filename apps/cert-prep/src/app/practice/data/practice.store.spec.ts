import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { CERT_PREP_API } from '../../core/data';
import type {
  SourceRead,
  PracticeSessionRead,
  ProjectRead,
  QuestionRead,
} from '../../core/domain';
import { QuestionsStore } from '../../authoring/data';
import { PracticeStore } from './practice.store';
import { ProjectStore } from '../../projects/data';
import { SourceImportStore } from '../../source-library/data';
import { provideCertPrepHttpResourceClientFake } from '../../core/testing';

describe('PracticeStore session modes', () => {
  const project: ProjectRead = {
    id: 'project-1',
    name: 'Security Study',
    description: 'Local prep',
    created_at: '2026-06-17T00:00:00Z',
    updated_at: '2026-06-17T00:00:00Z',
  };
  const sources: SourceRead[] = [
    sourceRead('source-1', 'domain-a.pdf'),
    sourceRead('source-2', 'domain-b.pdf'),
  ];
  const questions: QuestionRead[] = [
    editableQuestion('question-1', sources[0].id),
    editableQuestion('question-2', sources[1].id),
    editableQuestion('question-3', sources[1].id),
    editableQuestion('question-4', sources[1].id),
    editableQuestion('question-5', sources[0].id, { question: '   ' }),
    editableQuestion('question-6', sources[1].id, { answer: 'C' }),
    editableQuestion('question-7', sources[1].id, {
      citation_page: null,
      source_excerpt: null,
    }),
  ];
  const session: PracticeSessionRead = {
    id: 'session-1',
    project_id: project.id,
    question_ids: ['question-1'],
    questions: [],
    mode: 'random_draw',
    source_id: null,
    question_count: 1,
    random_seed: 1234,
    status: 'active',
    created_at: '2026-06-17T00:00:00Z',
    completed_at: null,
    abandoned_at: null,
    attempts: [],
  };
  const apiClient = {
    createPracticeSession: vi.fn().mockReturnValue(of(session)),
    getPracticeSession: vi.fn().mockReturnValue(of(session)),
    listQuestions: vi.fn().mockReturnValue(of({ items: questions })),
    listActivePracticeSessions: vi.fn().mockReturnValue(of({ items: [] })),
    abandonPracticeSession: vi.fn().mockReturnValue(of(session)),
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
    projects.projects.set([project]);
    projects.select(project.id);

    TestBed.inject(SourceImportStore).sources.set(sources);
    TestBed.inject(QuestionsStore).questions.set(questions);
  });

  it('sends a full-source payload for the selected parsed source', () => {
    const store = TestBed.inject(PracticeStore);
    store.setSelectedSourceId(sources[1].id);

    expect(store.selectedSourceQuestionCount()).toBe(3);

    store.createPracticeSession('full_source');
    TestBed.tick();

    expect(apiClient.createPracticeSession).toHaveBeenCalledWith(project.id, {
      mode: 'full_source',
      source_id: sources[1].id,
      question_count: 3,
    }, { signal: expect.any(AbortSignal) });
    expect(apiClient.getPracticeSession).toHaveBeenCalledWith(
      project.id,
      session.id,
      { signal: expect.any(AbortSignal) },
    );
  });

  it('defaults full-source sessions to the active source when playable', () => {
    const store = TestBed.inject(PracticeStore);
    TestBed.inject(SourceImportStore).setActiveSourceId(sources[1].id);

    store.createPracticeSession('full_source');
    TestBed.tick();

    expect(apiClient.createPracticeSession).toHaveBeenCalledWith(project.id, {
      mode: 'full_source',
      source_id: sources[1].id,
      question_count: 3,
    }, { signal: expect.any(AbortSignal) });
  });

  it('sends a random-draw payload capped to playable question count', () => {
    const store = TestBed.inject(PracticeStore);
    store.setSessionQuestionCount(10);

    expect(store.questionCount()).toBe(4);
    expect(store.effectiveRandomQuestionCount()).toBe(4);

    store.createPracticeSession('random_draw');
    TestBed.tick();

    expect(apiClient.createPracticeSession).toHaveBeenCalledWith(project.id, {
      mode: 'random_draw',
      question_count: 4,
    }, { signal: expect.any(AbortSignal) });
  });

  it('excludes non-playable questions from practice availability', () => {
    const store = TestBed.inject(PracticeStore);
    store.setSelectedSourceId(sources[1].id);

    expect(store.questionCount()).toBe(4);
    expect(store.selectedSourceQuestionCount()).toBe(3);

    store.createPracticeSession('full_source');
    TestBed.tick();

    expect(apiClient.createPracticeSession).toHaveBeenCalledWith(project.id, {
      mode: 'full_source',
      source_id: sources[1].id,
      question_count: 3,
    }, { signal: expect.any(AbortSignal) });
  });

  it('surfaces a complete in-session question from the live question list', () => {
    const store = TestBed.inject(PracticeStore);
    store.practiceSession.set({
      ...session,
      question_ids: ['question-4'],
      question_count: 1,
    });

    expect(store.activeQuestion()).toEqual(questions.find((question) => question.id === 'question-4'));
    expect(store.sessionComplete()).toBe(false);
  });

  it('does not surface an incomplete in-session question as active', () => {
    const store = TestBed.inject(PracticeStore);
    store.practiceSession.set({
      ...session,
      id: 'session-incomplete',
      question_ids: ['question-5'],
      question_count: 1,
    });

    expect(store.activeQuestion()).toBeNull();
    expect(store.sessionComplete()).toBe(false);
  });

  it('surfaces session snapshot questions before live question rows', () => {
    const store = TestBed.inject(PracticeStore);
    store.practiceSession.set({
      ...session,
      question_ids: ['question-1'],
      questions: [
        {
          id: 'question-1',
          question: 'Snapshot question text?',
          choices: ['Snapshot A', 'Snapshot B'],
          answer: 'Snapshot A',
          rationale: 'Snapshot rationale.',
          citation_page: 7,
          source_excerpt: 'Snapshot source excerpt.',
          source_id: sources[0].id,
          answer_key_source: null,
        },
      ],
    });

    expect(store.activeQuestion()).toEqual({
      id: 'question-1',
      question: 'Snapshot question text?',
      choices: ['Snapshot A', 'Snapshot B'],
      answer: 'Snapshot A',
      rationale: 'Snapshot rationale.',
      citation_page: 7,
      source_excerpt: 'Snapshot source excerpt.',
      source_id: sources[0].id,
      answer_key_source: null,
    });
  });

  it('creates review retry sessions for wrong attempts', () => {
    const store = TestBed.inject(PracticeStore);
    let created = false;

    store.createReviewRetrySession(['attempt-1']).subscribe((result) => {
      created = result;
    });
    TestBed.tick();
    expect(created).toBe(true);

    expect(apiClient.createPracticeSession).toHaveBeenCalledWith(project.id, {
      mode: 'review_retry',
      wrong_attempt_ids: ['attempt-1'],
      question_count: 1,
    }, { signal: expect.any(AbortSignal) });
    expect(store.practiceSession()).toEqual(session);
  });

  it('blocks a new random session while review retry is still active', () => {
    const store = TestBed.inject(PracticeStore);
    store.practiceSession.set({
      ...session,
      mode: 'review_retry',
      questions: [
        {
          id: 'question-1',
          question: 'Retry the missed question?',
          choices: ['A', 'B'],
          answer: 'A',
          rationale: 'Because A is cited.',
          citation_page: 1,
          source_excerpt: 'Source excerpt.',
          source_id: sources[0].id,
          answer_key_source: null,
        },
      ],
    });

    expect(store.canCreatePracticeSession('random_draw')).toBe(false);
    expect(store.sessionStartBlocker('random_draw')).toBe(
      'Finish the active review retry before starting a new practice session.',
    );

    store.createPracticeSession('random_draw');
    TestBed.tick();

    expect(apiClient.createPracticeSession).not.toHaveBeenCalled();
  });

  it('requires an explicit resume and rebuilds progress from ordered attempts', () => {
    const store = TestBed.inject(PracticeStore);
    const resumable = {
      id: 'session-resume',
      project_id: project.id,
      mode: 'random_draw' as const,
      source_id: null,
      status: 'active' as const,
      created_at: '2026-07-11T00:00:00Z',
    };
    const firstAttempt = {
      id: 'attempt-1',
      session_id: resumable.id,
      project_id: project.id,
      question_id: 'question-1',
      selected_answer: 'A',
      is_correct: true,
      created_at: '2026-07-11T00:01:00Z',
    };
    apiClient.listActivePracticeSessions.mockReturnValue(of({
      items: [resumable],
    }));
    apiClient.getPracticeSession.mockReturnValue(of({
      ...session,
      id: resumable.id,
      question_ids: ['question-1', 'question-2'],
      questions: [
        sessionQuestion('question-1', 'First?'),
        sessionQuestion('question-2', 'Second?'),
      ],
      question_count: 2,
      attempts: [firstAttempt],
    }));

    store.loadActiveSession(project.id);
    TestBed.tick();

    expect(store.resumableSession()).toEqual(resumable);
    expect(store.practiceSession()).toBeNull();
    expect(store.canCreatePracticeSession('random_draw')).toBe(false);

    store.resumeActiveSession();
    TestBed.tick();
    TestBed.tick();
    TestBed.flushEffects();

    expect(store.practiceSession()?.id).toBe(resumable.id);
    expect(store.resumableSession()).toBeNull();
    expect(store.answeredQuestionIds()).toEqual(new Set(['question-1']));
    expect(store.lastAttempt()).toEqual(firstAttempt);
    expect(store.activeQuestion()?.id).toBe('question-2');
  });

  it('requires two steps before abandoning a resumable session', () => {
    const store = TestBed.inject(PracticeStore);
    const resumable = {
      id: 'session-abandon',
      project_id: project.id,
      mode: 'full_source' as const,
      source_id: sources[0].id,
      status: 'active' as const,
      created_at: '2026-07-11T00:00:00Z',
    };
    store.resumableSession.set(resumable);
    apiClient.abandonPracticeSession.mockReturnValue(of({
      ...session,
      id: resumable.id,
      status: 'abandoned',
      abandoned_at: '2026-07-11T00:02:00Z',
    }));

    store.confirmAbandonActiveSession();
    expect(apiClient.abandonPracticeSession).not.toHaveBeenCalled();

    store.requestAbandonActiveSession();
    expect(store.abandonConfirmationPending()).toBe(true);
    store.confirmAbandonActiveSession();
    TestBed.tick();

    expect(apiClient.abandonPracticeSession).toHaveBeenCalledWith(
      project.id,
      resumable.id,
      { signal: expect.any(AbortSignal) },
    );
    expect(store.resumableSession()).toBeNull();
  });
});

function sessionQuestion(id: string, question: string) {
  return {
    id,
    question,
    choices: ['A', 'B'],
    answer: 'A',
    rationale: 'Grounded.',
    citation_page: 1,
    source_excerpt: 'Source.',
    source_id: 'source-1',
    answer_key_source: null,
  };
}

function sourceRead(id: string, filename: string): SourceRead {
  return {
    id,
    project_id: 'project-1',
    filename,
    source_kind: 'pdf',
    sha256: id,
    language_hint: 'en',
    page_count: 10,
    has_text: true,
    status: 'ready',
    extraction_method: 'text',
    ocr_device: null,
    extraction_warnings: null,
    failure_message: null,
    processed_page_count: 10,
    question_count: 3,
    content_profile: 'vocabulary_single_questions',
    classification_detail: '{"profile":"vocabulary_single_questions"}',
    chunks_count: 8,
    created_at: '2026-06-17T00:00:00Z',
    updated_at: '2026-06-17T00:00:00Z',
  };
}

function editableQuestion(
  id: string,
  sourceId: string,
  overrides: Partial<QuestionRead> = {},
): QuestionRead {
  return {
    id,
    project_id: 'project-1',
    source_id: sourceId,
    chunk_id: `${id}-chunk`,
    question: `Question ${id}`,
    choices: ['A', 'B'],
    answer: 'A',
    answer_key_source: 'manual',
    rationale: 'Because A is cited.',
    citation_page: 1,
    source_excerpt: 'Source excerpt.',
    confidence: null,
    source_order: 10001,
    source_question_number: '1',
    item_kind: 'vocabulary_single',
    group_key: null,
    group_prompt: null,
    created_at: '2026-06-17T00:00:00Z',
    updated_at: '2026-06-17T00:00:00Z',
    ...overrides,
  };
}
