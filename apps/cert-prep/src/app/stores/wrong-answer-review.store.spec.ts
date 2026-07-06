import { TestBed } from '@angular/core/testing';
import {
  CERT_PREP_API,
  type ProjectRead,
  type WrongAnswerExplanationRead,
  type WrongAnswerRead,
} from '../cert-prep-api';
import { OperationStore } from './operation.store';
import { ProjectStore } from './project.store';
import { WrongAnswerReviewStore } from './wrong-answer-review.store';

describe('WrongAnswerReviewStore', () => {
  const project: ProjectRead = {
    id: 'project-1',
    name: 'Security Study',
    description: 'Practice set',
    created_at: '2026-06-23T00:00:00Z',
    updated_at: '2026-06-23T00:00:00Z',
  };
  const wrongAnswer: WrongAnswerRead = {
    attempt_id: 'attempt-1',
    session_id: 'session-1',
    question_id: 'question-1',
    question: 'Which control applies?',
    selected_answer: 'B',
    correct_answer: 'A',
    rationale: 'The citation supports A.',
    citation_page: 3,
    source_excerpt: 'Relevant source excerpt.',
    document_id: 'document-1',
    created_at: '2026-06-23T00:00:00Z',
  };
  const summary = {
    current_wrong_count: 1,
    cleared_count: 2,
    last_wrong_date: wrongAnswer.created_at,
    repeated_misses: [
      {
        question_id: wrongAnswer.question_id,
        question: wrongAnswer.question,
        document_id: wrongAnswer.document_id,
        citation_page: wrongAnswer.citation_page,
        source_excerpt: wrongAnswer.source_excerpt,
        miss_count: 2,
        last_wrong_at: wrongAnswer.created_at,
      },
    ],
    clusters: [
      {
        document_id: wrongAnswer.document_id,
        citation_page: wrongAnswer.citation_page,
        current_wrong_count: 1,
        cleared_count: 2,
        last_wrong_at: wrongAnswer.created_at,
      },
    ],
  };
  const explanationResponse = (
    explanation: string,
    fallback: boolean,
  ): WrongAnswerExplanationRead => ({
    attempt_id: wrongAnswer.attempt_id,
    explanation,
    provider: 'ollama',
    model: 'qwen3.5:4b',
    fallback,
    grounded_fields: {
      question: wrongAnswer.question,
      selected_answer: wrongAnswer.selected_answer,
      correct_answer: wrongAnswer.correct_answer,
      rationale: wrongAnswer.rationale,
      citation_page: wrongAnswer.citation_page,
      source_excerpt: wrongAnswer.source_excerpt,
    },
  });
  let apiClient: {
    listWrongAnswers: ReturnType<typeof vi.fn>;
    summarizeWrongAnswers: ReturnType<typeof vi.fn>;
    explainWrongAnswer: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    apiClient = {
      listWrongAnswers: vi.fn(),
      summarizeWrongAnswers: vi.fn().mockResolvedValue(summary),
      explainWrongAnswer: vi
        .fn()
        .mockRejectedValue(new Error('AI provider unavailable')),
    };
    TestBed.configureTestingModule({
      providers: [{ provide: CERT_PREP_API, useValue: apiClient }],
    });

    const projects = TestBed.inject(ProjectStore);
    projects.projects.set([project]);
    projects.select(project.id);
  });

  it('loads wrong answers directly for a project', async () => {
    apiClient.listWrongAnswers.mockResolvedValue({ items: [wrongAnswer] });
    const store = TestBed.inject(WrongAnswerReviewStore);

    await store.load(project.id);

    expect(apiClient.listWrongAnswers).toHaveBeenCalledWith(project.id);
    expect(apiClient.summarizeWrongAnswers).toHaveBeenCalledWith(project.id);
    expect(store.wrongAnswers()).toEqual([wrongAnswer]);
    expect(store.summary()).toEqual(summary);
  });

  it('guards refresh until a project is selected', async () => {
    const projects = TestBed.inject(ProjectStore);
    projects.selectedProjectId.set(null);
    const operations = TestBed.inject(OperationStore);
    const store = TestBed.inject(WrongAnswerReviewStore);

    await store.refresh();

    expect(apiClient.listWrongAnswers).not.toHaveBeenCalled();
    expect(apiClient.summarizeWrongAnswers).not.toHaveBeenCalled();
    expect(operations.error()).toBe(
      'Select a project before refreshing review.',
    );
  });

  it('refreshes review rows through the operation store', async () => {
    apiClient.listWrongAnswers.mockResolvedValue({ items: [wrongAnswer] });
    const operations = TestBed.inject(OperationStore);
    const store = TestBed.inject(WrongAnswerReviewStore);

    await store.refresh();

    expect(apiClient.listWrongAnswers).toHaveBeenCalledWith(project.id);
    expect(apiClient.summarizeWrongAnswers).toHaveBeenCalledWith(project.id);
    expect(store.wrongAnswers()).toEqual([wrongAnswer]);
    expect(store.summary()).toEqual(summary);
    expect(operations.status()).toBe('Review refreshed');
  });

  it('tracks per-attempt loading and AI explanation results', async () => {
    let resolveExplanation:
      | ((value: WrongAnswerExplanationRead) => void)
      | undefined;
    apiClient.explainWrongAnswer = vi.fn(
      () =>
        new Promise<WrongAnswerExplanationRead>((resolve) => {
          resolveExplanation = resolve;
        }),
    );
    const store = TestBed.inject(WrongAnswerReviewStore);

    const request = store.discussMistake(wrongAnswer);

    expect(apiClient.explainWrongAnswer).toHaveBeenCalledWith(
      project.id,
      wrongAnswer.attempt_id,
    );
    expect(store.explanationFor(wrongAnswer.attempt_id)).toEqual({
      loading: true,
      result: null,
      error: null,
      fallback: false,
    });

    resolveExplanation?.(
      explanationResponse('AI explanation grounded in the source.', false),
    );
    await request;

    expect(store.explanationFor(wrongAnswer.attempt_id)).toEqual({
      loading: false,
      result: 'AI explanation grounded in the source.',
      error: null,
      fallback: false,
    });
  });

  it('preserves backend fallback flags on successful explanations', async () => {
    apiClient.explainWrongAnswer.mockResolvedValue(
      explanationResponse('Backend fallback grounded in the source.', true),
    );
    const store = TestBed.inject(WrongAnswerReviewStore);

    await store.discussMistake(wrongAnswer);

    expect(store.explanationFor(wrongAnswer.attempt_id)).toEqual({
      loading: false,
      result: 'Backend fallback grounded in the source.',
      error: null,
      fallback: true,
    });
  });

  it('uses grounded fallback copy when the AI explanation request is rejected', async () => {
    const store = TestBed.inject(WrongAnswerReviewStore);

    await store.discussMistake(wrongAnswer);

    expect(store.explanationFor(wrongAnswer.attempt_id)).toEqual({
      loading: false,
      result:
        'You chose B, but the recorded correct answer is A. The rationale says: The citation supports A. The source on page 3 says: Relevant source excerpt.',
      error: 'AI provider unavailable',
      fallback: true,
    });
  });

  it('keeps refresh and clearing available after AI explanation failure', async () => {
    apiClient.explainWrongAnswer = vi
      .fn()
      .mockRejectedValue(new Error('AI provider unavailable'));
    apiClient.listWrongAnswers.mockResolvedValue({ items: [wrongAnswer] });
    const store = TestBed.inject(WrongAnswerReviewStore);

    await store.discussMistake(wrongAnswer);
    await store.refresh();

    expect(apiClient.listWrongAnswers).toHaveBeenCalledWith(project.id);
    expect(store.wrongAnswers()).toEqual([wrongAnswer]);

    store.reset();

    expect(store.wrongAnswers()).toEqual([]);
    expect(store.summary()).toBeNull();
    expect(store.explanations()).toEqual({});
  });
});
