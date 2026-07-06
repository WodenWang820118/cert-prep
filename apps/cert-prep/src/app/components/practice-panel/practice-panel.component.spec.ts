import { TestBed } from '@angular/core/testing';
import {
  appDocument,
  appProject,
  editableAppQuestion,
} from '../../app.spec-helpers';
import {
  CERT_PREP_API,
  type PracticeSessionRead,
  type QuestionDraftRead,
} from '../../cert-prep-api';
import { DraftReviewStore } from '../../stores/draft-review/draft-review.store';
import { OperationStore } from '../../stores/operation.store';
import { PracticeStore } from '../../stores/practice/practice.store';
import { ProjectStore } from '../../stores/project.store';
import { PracticePanelComponent } from './practice-panel.component';

describe('PracticePanelComponent', () => {
  let apiClient: ReturnType<typeof createApiClient>;

  beforeEach(async () => {
    vi.clearAllMocks();
    apiClient = createApiClient();

    await TestBed.configureTestingModule({
      imports: [PracticePanelComponent],
      providers: [{ provide: CERT_PREP_API, useValue: apiClient }],
    }).compileComponents();
  });

  it('renders the random quiz empty state', () => {
    const fixture = TestBed.createComponent(PracticePanelComponent);
    fixture.componentRef.setInput('sessionMode', 'random_draw');

    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Random Quiz');
    expect(fixture.nativeElement.textContent).toContain(
      'Select a project before starting practice.',
    );
  });

  it('shows the effective random draw total before a session starts', () => {
    const projects = TestBed.inject(ProjectStore);
    const drafts = TestBed.inject(DraftReviewStore);
    projects.projects.set([appProject]);
    projects.select(appProject.id);
    drafts.drafts.set([editableAppQuestion]);

    const fixture = TestBed.createComponent(PracticePanelComponent);
    fixture.componentRef.setInput('sessionMode', 'random_draw');
    fixture.detectChanges();

    expect(metricValue(fixture.nativeElement, 'Draw Size')).toBe('1');
    expect(fixture.nativeElement.textContent).toContain('Question 1 of 1');
  });

  it('loads project documents and drafts before rendering full exam readiness', async () => {
    const projects = TestBed.inject(ProjectStore);
    projects.projects.set([appProject]);
    projects.select(appProject.id);
    apiClient.listDocuments.mockResolvedValue({ items: [appDocument] });
    apiClient.getDocument.mockResolvedValue(appDocument);
    apiClient.listQuestionDrafts.mockResolvedValue({
      items: [editableAppQuestion],
    });

    const fixture = TestBed.createComponent(PracticePanelComponent);
    fixture.componentRef.setInput('sessionMode', 'full_document');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(apiClient.listDocuments).toHaveBeenCalledWith(appProject.id);
    expect(apiClient.listQuestionDrafts).toHaveBeenCalledWith(appProject.id);
    expect(metricValue(fixture.nativeElement, 'Documents')).toBe('1');
    expect(metricValue(fixture.nativeElement, 'Questions')).toBe('1');
    expect(buttonByText(fixture.nativeElement, 'Start full exam')?.disabled).toBe(
      false,
    );
  });

  it('reports practice input load failures instead of leaking an unhandled rejection', async () => {
    const projects = TestBed.inject(ProjectStore);
    const operations = TestBed.inject(OperationStore);
    const unhandledRejection = vi.fn();
    projects.projects.set([appProject]);
    projects.select(appProject.id);
    apiClient.listQuestionDrafts.mockRejectedValue(new Error('offline'));
    window.addEventListener('unhandledrejection', unhandledRejection);

    try {
      const fixture = TestBed.createComponent(PracticePanelComponent);
      fixture.componentRef.setInput('sessionMode', 'random_draw');
      fixture.detectChanges();

      await vi.waitFor(() =>
        expect(operations.error()).toBe(
          'Practice data could not be loaded. Try refreshing the project.',
        ),
      );
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('unhandledrejection', unhandledRejection);
    }
  });

  it('selects an answer in an active practice session', async () => {
    const store = arrangeActiveSession([editableAppQuestion]);
    const fixture = TestBed.createComponent(PracticePanelComponent);
    fixture.componentRef.setInput('sessionMode', 'random_draw');
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    const secondChoice =
      compiled.querySelector<HTMLInputElement>('#practice-choice-1');
    secondChoice?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    const selectedChoice =
      compiled.querySelector<HTMLInputElement>('#practice-choice-1');
    expect(store.selectedAnswer()).toBe('Privilege sprawl');
    expect(
      selectedChoice?.closest('.practice-choice-row')?.classList,
    ).toContain('is-selected');
    expect(buttonByText(compiled, 'Submit answer')?.disabled).toBe(false);
  });

  it('renders review retry snapshot questions from an active practice session', () => {
    const store = arrangeActiveSession([editableAppQuestion]);
    store.practiceSession.set({
      ...practiceSession([editableAppQuestion.id]),
      mode: 'review_retry',
      questions: [
        {
          id: editableAppQuestion.id,
          question: 'Snapshot retry question?',
          choices: ['Snapshot answer', 'Other answer'],
          answer: 'Snapshot answer',
          rationale: 'Snapshot rationale.',
          citation_page: 9,
          source_excerpt: 'Snapshot excerpt.',
          document_id: editableAppQuestion.document_id,
        },
      ],
    });

    const fixture = TestBed.createComponent(PracticePanelComponent);
    fixture.componentRef.setInput('sessionMode', 'random_draw');
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(
      'Snapshot retry question?',
    );
    expect(fixture.nativeElement.textContent).toContain('Snapshot answer');
    expect(fixture.nativeElement.textContent).not.toContain(
      editableAppQuestion.question,
    );
  });

  it('clears an active answer selection', async () => {
    const store = arrangeActiveSession([editableAppQuestion]);
    store.selectAnswer('Least privilege');

    const fixture = TestBed.createComponent(PracticePanelComponent);
    fixture.componentRef.setInput('sessionMode', 'random_draw');
    fixture.detectChanges();

    const clearButton = buttonByText(fixture.nativeElement, 'Clear selection');
    expect(clearButton?.disabled).toBe(false);

    clearButton?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(store.selectedAnswer()).toBe('');
    expect(clearButton?.disabled).toBe(true);
  });

  it('disables submit until an answer is selected', () => {
    arrangeActiveSession([editableAppQuestion]);
    const fixture = TestBed.createComponent(PracticePanelComponent);
    fixture.componentRef.setInput('sessionMode', 'random_draw');
    fixture.detectChanges();

    const submitButton = buttonByText(fixture.nativeElement, 'Submit answer');

    expect(submitButton?.disabled).toBe(true);
  });

  it('disables submit and shows the spinner while an answer submit is busy', () => {
    const store = arrangeActiveSession([editableAppQuestion]);
    store.selectAnswer('Least privilege');
    TestBed.inject(OperationStore).busy.set('attempt');

    const fixture = TestBed.createComponent(PracticePanelComponent);
    fixture.componentRef.setInput('sessionMode', 'random_draw');
    fixture.detectChanges();

    const submitButton = buttonByText(fixture.nativeElement, 'Submit answer');
    const icon = submitButton?.querySelector('i');

    expect(submitButton?.disabled).toBe(true);
    expect(icon?.classList).toContain('pi-spinner');
    expect(icon?.classList).toContain('pi-spin');
    expect(icon?.classList).not.toContain('pi-send');
  });

  it('renders answered, current, and pending question navigator states', () => {
    const firstQuestion = editableQuestion('draft-1', {
      question: 'First question?',
    });
    const secondQuestion = editableQuestion('draft-2', {
      question: 'Second question?',
    });
    const thirdQuestion = editableQuestion('draft-3', {
      question: 'Third question?',
    });
    const store = arrangeActiveSession([
      firstQuestion,
      secondQuestion,
      thirdQuestion,
    ]);
    store.answeredQuestionIds.set(new Set([firstQuestion.id]));

    const fixture = TestBed.createComponent(PracticePanelComponent);
    fixture.componentRef.setInput('sessionMode', 'random_draw');
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    const items = Array.from(
      compiled.querySelectorAll<HTMLElement>('.practice-question-nav span'),
    );

    expect(items.map((item) => item.textContent?.trim())).toEqual([
      '1',
      '2',
      '3',
    ]);
    expect(items[0]?.classList).toContain('is-answered');
    expect(items[1]?.classList).toContain('is-current');
    expect(items[2]?.classList).not.toContain('is-answered');
    expect(items[2]?.classList).not.toContain('is-current');
  });

  it('does not render the placeholder Mark for review action', () => {
    arrangeActiveSession([editableAppQuestion]);
    const fixture = TestBed.createComponent(PracticePanelComponent);
    fixture.componentRef.setInput('sessionMode', 'random_draw');
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).not.toContain('Mark for review');
    expect(
      fixture.nativeElement.querySelector('.practice-flag-button'),
    ).toBeNull();
  });
});

function metricValue(root: ParentNode, label: string): string | null {
  const metric = Array.from(
    root.querySelectorAll('.practice-metrics div'),
  ).find((item) => item.querySelector('dt')?.textContent?.trim() === label);
  return metric?.querySelector('dd')?.textContent?.trim() ?? null;
}

function arrangeActiveSession(
  questions: readonly QuestionDraftRead[],
): PracticeStore {
  const projects = TestBed.inject(ProjectStore);
  const drafts = TestBed.inject(DraftReviewStore);
  const store = TestBed.inject(PracticeStore);
  projects.projects.set([appProject]);
  projects.select(appProject.id);
  drafts.drafts.set([...questions]);
  store.practiceSession.set(
    practiceSession(questions.map((question) => question.id)),
  );
  return store;
}

function practiceSession(questionIds: readonly string[]): PracticeSessionRead {
  return {
    id: 'session-1',
    project_id: appProject.id,
    question_ids: [...questionIds],
    questions: [],
    mode: 'random_draw',
    document_id: null,
    question_count: questionIds.length,
    random_seed: 1234,
    status: 'active',
    created_at: '2026-06-17T00:00:00Z',
    completed_at: null,
  };
}

function editableQuestion(
  id: string,
  overrides: Partial<QuestionDraftRead> = {},
): QuestionDraftRead {
  return {
    ...editableAppQuestion,
    id,
    chunk_id: `${id}-chunk`,
    question: `Question ${id}`,
    source_order: 10000 + Number(id.replace(/\D/g, '')),
    ...overrides,
  };
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

function createApiClient() {
  return {
    recordPracticeAttempt: vi.fn(),
    listWrongAnswers: vi.fn().mockResolvedValue({ items: [] }),
    listQuestionDrafts: vi.fn().mockResolvedValue({ items: [] }),
    listDocuments: vi.fn().mockResolvedValue({ items: [] }),
    getDocument: vi.fn().mockResolvedValue(appDocument),
    listDocumentChunks: vi.fn().mockResolvedValue({ items: [] }),
  };
}
