import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import {
  CERT_PREP_API,
  type DocumentRead,
  type PracticeSessionRead,
  type ProjectRead,
  type WrongAnswerExplanationRead,
  type WrongAnswerRead,
} from '../../cert-prep-api';
import { ProjectStore } from '../../stores/project.store';
import { SourceImportStore } from '../../stores/source-import/source-import.store';
import { WrongAnswerReviewStore } from '../../stores/wrong-answer-review.store';
import { WrongAnswerReviewComponent } from './wrong-answer-review.component';

describe('WrongAnswerReviewComponent', () => {
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
  const document: DocumentRead = {
    id: wrongAnswer.document_id ?? 'document-1',
    project_id: project.id,
    filename: 'security.pdf',
    sha256: 'abc123',
    language_hint: 'en',
    page_count: 10,
    has_text: true,
    status: 'ready',
    extraction_method: 'text',
    ocr_device: null,
    ocr_fallback_reason: null,
    ocr_duration_ms: 0,
    processed_page_count: 10,
    parse_wall_duration_ms: 0,
    render_duration_ms: 0,
    ocr_engine_duration_ms: 0,
    ocr_worker_count: 1,
    first_chunk_ms: 0,
    exam_item_count: 1,
    content_profile: 'vocabulary_single_questions',
    classification_detail: '{"profile":"vocabulary_single_questions"}',
    chunks_count: 4,
    created_at: '2026-06-23T00:00:00Z',
    updated_at: '2026-06-23T00:00:00Z',
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
  const reviewSession: PracticeSessionRead = {
    id: 'session-review-1',
    project_id: project.id,
    question_ids: [wrongAnswer.question_id],
    questions: [
      {
        id: wrongAnswer.question_id,
        question: wrongAnswer.question,
        choices: ['A', 'B'],
        answer: wrongAnswer.correct_answer,
        rationale: wrongAnswer.rationale,
        citation_page: wrongAnswer.citation_page,
        source_excerpt: wrongAnswer.source_excerpt,
        document_id: wrongAnswer.document_id,
      },
    ],
    mode: 'review_retry',
    document_id: null,
    question_count: 1,
    random_seed: null,
    status: 'active',
    created_at: '2026-06-23T00:00:00Z',
    completed_at: null,
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
    createPracticeSession: ReturnType<typeof vi.fn>;
    getPracticeSession: ReturnType<typeof vi.fn>;
    explainWrongAnswer: ReturnType<typeof vi.fn>;
    listWrongAnswers: ReturnType<typeof vi.fn>;
    summarizeWrongAnswers: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    apiClient = {
      createPracticeSession: vi.fn().mockResolvedValue(reviewSession),
      getPracticeSession: vi.fn().mockResolvedValue(reviewSession),
      explainWrongAnswer: vi
        .fn()
        .mockRejectedValue(new Error('AI provider unavailable')),
      listWrongAnswers: vi.fn().mockResolvedValue({ items: [wrongAnswer] }),
      summarizeWrongAnswers: vi.fn().mockResolvedValue(summary),
    };
    await TestBed.configureTestingModule({
      imports: [WrongAnswerReviewComponent],
      providers: [
        provideRouter([]),
        { provide: CERT_PREP_API, useValue: apiClient },
      ],
    }).compileComponents();
  });

  it('renders the empty review state', () => {
    const fixture = TestBed.createComponent(WrongAnswerReviewComponent);

    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Wrong Answers');
    expect(fixture.nativeElement.textContent).toContain(
      'Wrong answers will appear here after a practice attempt needs review.',
    );
  });

  it('renders e2e-visible wrong-answer details and disabled refresh state', () => {
    const fixture = TestBed.createComponent(WrongAnswerReviewComponent);
    const projects = TestBed.inject(ProjectStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const review = TestBed.inject(WrongAnswerReviewStore);
    projects.projects.set([project]);
    projects.selectedProjectId.set(null);
    sourceImport.documents.set([document]);
    review.wrongAnswers.set([wrongAnswer]);

    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const refreshButton = element.querySelector<HTMLButtonElement>(
      '.review-refresh-button',
    );
    expect(element.textContent).toContain('1 recorded');
    expect(element.textContent).toContain('Page 3');
    expect(element.textContent).toContain('security.pdf');
    expect(
      element.querySelector('[aria-label="Your answer"] p')?.textContent,
    ).toContain('B');
    expect(
      element.querySelector('[aria-label="Correct answer"] p')?.textContent,
    ).toContain('A');
    expect(element.textContent).toContain('The citation supports A.');
    expect(element.textContent).toContain('Relevant source excerpt.');
    expect(element.textContent).toContain(
      'Answer correctly in a later session',
    );
    expect(element.textContent).toContain('Retry');
    expect(element.textContent).toContain('Discuss mistake with AI');
    expect(refreshButton?.disabled).toBe(true);
  });

  it('renders compact weak-area summary metrics', () => {
    const fixture = TestBed.createComponent(WrongAnswerReviewComponent);
    const review = TestBed.inject(WrongAnswerReviewStore);
    review.summary.set(summary);

    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(summaryMetric(element, 'Current')).toBe('1');
    expect(summaryMetric(element, 'Cleared')).toBe('2');
    expect(summaryMetric(element, 'Repeated')).toBe('1');
    expect(summaryMetric(element, 'Last Wrong')).toBe('2026-06-23');
    expect(summaryMetric(element, 'Weak Areas')).toBe('1');
  });

  it('enables refresh when a project is selected and review is not busy', () => {
    const fixture = TestBed.createComponent(WrongAnswerReviewComponent);
    selectProject();

    fixture.detectChanges();

    expect(refreshButton(fixture.nativeElement as HTMLElement)?.disabled).toBe(
      false,
    );
  });

  it('starts a review quiz for all current wrong answers', async () => {
    const fixture = TestBed.createComponent(WrongAnswerReviewComponent);
    selectProject();
    TestBed.inject(WrongAnswerReviewStore).wrongAnswers.set([wrongAnswer]);
    const router = TestBed.inject(Router);
    const navigateByUrl = vi
      .spyOn(router, 'navigateByUrl')
      .mockResolvedValue(true);
    fixture.detectChanges();

    buttonByText(fixture.nativeElement, 'Start review quiz')?.click();
    await fixture.whenStable();

    expect(apiClient.createPracticeSession).toHaveBeenCalledWith(project.id, {
      mode: 'review_retry',
      wrong_attempt_ids: [wrongAnswer.attempt_id],
      question_count: 1,
    });
    expect(navigateByUrl).toHaveBeenCalledWith('/random-quiz');
  });

  it('starts a retry session for one wrong answer card', async () => {
    const fixture = TestBed.createComponent(WrongAnswerReviewComponent);
    selectProject();
    TestBed.inject(WrongAnswerReviewStore).wrongAnswers.set([wrongAnswer]);
    const router = TestBed.inject(Router);
    vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    fixture.detectChanges();

    buttonByText(fixture.nativeElement, 'Retry')?.click();
    await fixture.whenStable();

    expect(apiClient.createPracticeSession).toHaveBeenCalledWith(project.id, {
      mode: 'review_retry',
      wrong_attempt_ids: [wrongAnswer.attempt_id],
      question_count: 1,
    });
  });

  it('shows deterministic fallback copy when AI is unavailable', async () => {
    const fixture = TestBed.createComponent(WrongAnswerReviewComponent);
    selectProject();
    TestBed.inject(WrongAnswerReviewStore).wrongAnswers.set([wrongAnswer]);
    fixture.detectChanges();

    clickAiButton(fixture.nativeElement as HTMLElement);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(
      'Grounded fallback explanation',
    );
    expect(fixture.nativeElement.textContent).toContain(
      'You chose B, but the recorded correct answer is A.',
    );
    expect(fixture.nativeElement.textContent).toContain(
      'AI provider unavailable',
    );
  });

  it('shows generated AI explanation results', async () => {
    apiClient.explainWrongAnswer = vi
      .fn()
      .mockResolvedValue(
        explanationResponse(
          'AI result grounded in the recorded source excerpt.',
          false,
        ),
      );
    const fixture = TestBed.createComponent(WrongAnswerReviewComponent);
    selectProject();
    TestBed.inject(WrongAnswerReviewStore).wrongAnswers.set([wrongAnswer]);
    fixture.detectChanges();

    clickAiButton(fixture.nativeElement as HTMLElement);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(apiClient.explainWrongAnswer).toHaveBeenCalledWith(
      project.id,
      wrongAnswer.attempt_id,
    );
    expect(fixture.nativeElement.textContent).toContain('AI explanation');
    expect(fixture.nativeElement.textContent).toContain(
      'AI result grounded in the recorded source excerpt.',
    );
  });

  it('labels backend fallback explanation results', async () => {
    apiClient.explainWrongAnswer = vi
      .fn()
      .mockResolvedValue(
        explanationResponse(
          'Backend fallback grounded in the recorded source excerpt.',
          true,
        ),
      );
    const fixture = TestBed.createComponent(WrongAnswerReviewComponent);
    selectProject();
    TestBed.inject(WrongAnswerReviewStore).wrongAnswers.set([wrongAnswer]);
    fixture.detectChanges();

    clickAiButton(fixture.nativeElement as HTMLElement);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(
      'Grounded fallback explanation',
    );
    expect(fixture.nativeElement.textContent).toContain(
      'Backend fallback grounded in the recorded source excerpt.',
    );
  });

  function selectProject(): void {
    const projects = TestBed.inject(ProjectStore);
    projects.projects.set([project]);
    projects.select(project.id);
  }

  function clickAiButton(element: HTMLElement): void {
    element.querySelector<HTMLButtonElement>('.ai-discuss-button')?.click();
  }

  function refreshButton(element: HTMLElement): HTMLButtonElement | null {
    return element.querySelector<HTMLButtonElement>('.review-refresh-button');
  }

  function summaryMetric(root: ParentNode, label: string): string | null {
    const metric = Array.from(
      root.querySelectorAll('.review-summary div'),
    ).find((item) => item.querySelector('dt')?.textContent?.trim() === label);
    return metric?.querySelector('dd')?.textContent?.trim() ?? null;
  }

  function buttonByText(
    root: ParentNode,
    text: string,
  ): HTMLButtonElement | null {
    return (
      Array.from(root.querySelectorAll('button')).find((button) =>
        button.textContent?.includes(text),
      ) ?? null
    );
  }
});
