import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import {
  CERT_PREP_API,
  type DocumentRead,
  type PracticeSessionRead,
  type ProjectRead,
  type WrongAnswerRead,
  type WrongAnswerSummaryRead,
} from '../../cert-prep-api';
import { ProjectStore } from '../../stores/project.store';
import { OperationStore } from '../../stores/operation.store';
import { SourceImportStore } from '../../stores/source-import/source-import.store';
import { WrongAnswerReviewStore } from '../../stores/wrong-answer-review.store';
import { WrongAnswerDashboardComponent } from './wrong-answer-dashboard.component';

describe('WrongAnswerDashboardComponent', () => {
  const project: ProjectRead = {
    id: 'project-1',
    name: 'Security Study',
    description: 'Practice set',
    created_at: '2026-06-23T00:00:00Z',
    updated_at: '2026-06-23T00:00:00Z',
  };
  const document: DocumentRead = {
    id: 'document-1',
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
    document_id: document.id,
    created_at: '2026-06-23T00:00:00Z',
  };
  const fallbackDocumentWrongAnswer: WrongAnswerRead = {
    ...wrongAnswer,
    attempt_id: 'attempt-2',
    question_id: 'question-2',
    question: 'Which source should be checked?',
    selected_answer: 'Only the model name',
    correct_answer: 'The cited page and excerpt',
    citation_page: 7,
    document_id: 'missing-document',
  };
  const summary: WrongAnswerSummaryRead = {
    current_wrong_count: 2,
    cleared_count: 1,
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
      {
        question_id: 'cleared-question',
        question: 'Which cleared item should stay visible?',
        document_id: document.id,
        citation_page: 4,
        source_excerpt: 'Cleared source excerpt.',
        miss_count: 2,
        last_wrong_at: '2026-06-20T00:00:00Z',
      },
    ],
    clusters: [
      {
        document_id: wrongAnswer.document_id,
        citation_page: wrongAnswer.citation_page,
        current_wrong_count: 1,
        cleared_count: 0,
        last_wrong_at: wrongAnswer.created_at,
      },
      {
        document_id: fallbackDocumentWrongAnswer.document_id,
        citation_page: fallbackDocumentWrongAnswer.citation_page,
        current_wrong_count: 1,
        cleared_count: 0,
        last_wrong_at: fallbackDocumentWrongAnswer.created_at,
      },
      {
        document_id: document.id,
        citation_page: 4,
        current_wrong_count: 0,
        cleared_count: 1,
        last_wrong_at: '2026-06-20T00:00:00Z',
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
    abandoned_at: null,
    attempts: [],
  };
  let apiClient: {
    createPracticeSession: ReturnType<typeof vi.fn>;
    getPracticeSession: ReturnType<typeof vi.fn>;
    listQuestionDrafts: ReturnType<typeof vi.fn>;
    listWrongAnswers: ReturnType<typeof vi.fn>;
    summarizeWrongAnswers: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    apiClient = {
      createPracticeSession: vi.fn().mockResolvedValue(reviewSession),
      getPracticeSession: vi.fn().mockResolvedValue(reviewSession),
      listQuestionDrafts: vi.fn().mockResolvedValue({ items: [] }),
      listWrongAnswers: vi
        .fn()
        .mockResolvedValue({ items: [wrongAnswer, fallbackDocumentWrongAnswer] }),
      summarizeWrongAnswers: vi.fn().mockResolvedValue(summary),
    };
    await TestBed.configureTestingModule({
      imports: [WrongAnswerDashboardComponent],
      providers: [
        provideRouter([]),
        { provide: CERT_PREP_API, useValue: apiClient },
      ],
    }).compileComponents();
  });

  it('renders the empty dashboard state', () => {
    const fixture = TestBed.createComponent(WrongAnswerDashboardComponent);

    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('Dashboard');
    expect(element.textContent).toContain('No weakness data yet.');
    expect(element.textContent).toContain('Practice questions in this project');
  });

  it('renders KPIs, weak areas, repeated misses, and answer patterns', () => {
    seedDashboardState();
    const fixture = TestBed.createComponent(WrongAnswerDashboardComponent);

    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(metricValue(element, 'Current Wrong')).toBe('2');
    expect(metricValue(element, 'Cleared')).toBe('1');
    expect(metricValue(element, 'Repeated Misses')).toBe('2');
    expect(metricValue(element, 'Weak Areas')).toBe('3');
    expect(metricValue(element, 'Last Wrong')).toBe('2026-06-23');
    expect(element.textContent).toContain(
      'grouped by source document and page',
    );
    expect(element.textContent).toContain('security.pdf');
    expect(element.textContent).toContain('Page 3');
    expect(element.textContent).toContain('missing-document');
    expect(element.textContent).toContain('Which control applies?');
    expect(element.textContent).toContain('Relevant source excerpt.');
    expect(element.textContent).toContain('B');
    expect(element.textContent).toContain('A');
    expect(element.textContent).toContain('Only the model name');
    expect(element.textContent).toContain('The cited page and excerpt');
  });

  it('starts a cluster retry with only current wrong answers in that source area', async () => {
    seedDashboardState();
    const fixture = TestBed.createComponent(WrongAnswerDashboardComponent);
    const router = TestBed.inject(Router);
    const navigateByUrl = vi
      .spyOn(router, 'navigateByUrl')
      .mockResolvedValue(true);
    fixture.detectChanges();

    buttonInRow(
      fixture.nativeElement,
      '.weak-area-row',
      'security.pdf',
      'Retry 1 question',
    )?.click();
    await fixture.whenStable();

    expect(apiClient.createPracticeSession).toHaveBeenCalledWith(project.id, {
      mode: 'review_retry',
      wrong_attempt_ids: [wrongAnswer.attempt_id],
      question_count: 1,
    });
    expect(navigateByUrl).toHaveBeenCalledWith('/random-quiz');
  });

  it('does not offer retry for cleared-only repeated misses', () => {
    seedDashboardState();
    const fixture = TestBed.createComponent(WrongAnswerDashboardComponent);

    fixture.detectChanges();

    const clearedMissRow = rowByText(
      fixture.nativeElement,
      '.repeated-row',
      'Which cleared item should stay visible?',
    );
    expect(clearedMissRow?.classList.contains('repeated-row')).toBe(true);
    expect(clearedMissRow?.textContent).toContain('Cleared');
    expect(buttonByText(clearedMissRow, 'Cleared')?.disabled).toBe(true);
  });

  it('renders repeated answer-pattern samples with identical question text', () => {
    seedDashboardState();
    const review = TestBed.inject(WrongAnswerReviewStore);
    review.wrongAnswers.set([
      wrongAnswer,
      {
        ...wrongAnswer,
        attempt_id: 'attempt-duplicate',
        question_id: 'question-duplicate',
      },
    ]);
    review.summary.set({
      ...summary,
      current_wrong_count: 2,
      clusters: [],
      repeated_misses: [],
    });
    const fixture = TestBed.createComponent(WrongAnswerDashboardComponent);

    fixture.detectChanges();

    const samples = fixture.nativeElement.querySelectorAll(
      '.answer-pattern-row li',
    );
    expect(samples.length).toBe(2);
    expect(fixture.nativeElement.textContent).toContain(
      'Which control applies?',
    );
  });

  it('disables refresh and retry actions while review or session work is running', () => {
    seedDashboardState();
    const operations = TestBed.inject(OperationStore);
    const fixture = TestBed.createComponent(WrongAnswerDashboardComponent);

    operations.busy.set('session');
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(refreshButton(element)?.disabled).toBe(true);

    operations.busy.set('review');
    fixture.detectChanges();

    const weakAreaRetry = buttonInRow(
      element,
      '.weak-area-row',
      'security.pdf',
      'Retry 1 question',
    );
    expect(weakAreaRetry?.disabled).toBe(true);
  });

  function seedDashboardState(): void {
    const projects = TestBed.inject(ProjectStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const review = TestBed.inject(WrongAnswerReviewStore);
    projects.projects.set([project]);
    projects.select(project.id);
    sourceImport.documents.set([document]);
    review.wrongAnswers.set([wrongAnswer, fallbackDocumentWrongAnswer]);
    review.summary.set(summary);
  }

  function metricValue(root: ParentNode, label: string): string | null {
    const metric = Array.from(root.querySelectorAll('.dashboard-kpis div')).find(
      (item) => item.querySelector('dt')?.textContent?.trim() === label,
    );
    return metric?.querySelector('dd')?.textContent?.trim() ?? null;
  }

  function rowByText(
    root: ParentNode | null,
    selector: string,
    text: string,
  ): HTMLElement | null {
    if (root === null) {
      return null;
    }
    return (
      Array.from(root.querySelectorAll<HTMLElement>(selector)).find((row) =>
        row.textContent?.includes(text),
      ) ?? null
    );
  }

  function buttonInRow(
    root: ParentNode,
    selector: string,
    rowText: string,
    buttonText: string,
  ): HTMLButtonElement | null {
    return buttonByText(rowByText(root, selector, rowText), buttonText);
  }

  function refreshButton(element: HTMLElement): HTMLButtonElement | null {
    return element.querySelector<HTMLButtonElement>('.dashboard-refresh-button');
  }

  function buttonByText(
    root: ParentNode | null,
    text: string,
  ): HTMLButtonElement | null {
    if (root === null) {
      return null;
    }
    return (
      Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.includes(text),
      ) ?? null
    );
  }
});
