import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import {
  appDocument,
  appProject,
  editableAppQuestion,
} from '../../testing/app.spec-helpers';
import { CERT_PREP_API } from '../../constants/cert-prep-api.constants';
import type {
  PracticeSessionRead,
  QuestionDraftRead,
} from '../../contracts/api.contracts';
import { DraftReviewStore } from '../../stores/draft-review/draft-review.store';
import { OperationStore } from '../../stores/operation.store';
import { PracticeStore } from '../../stores/practice/practice.store';
import { ProjectStore } from '../../stores/project.store';
import { PracticePanelComponent } from './practice-panel.component';
import { provideCertPrepHttpResourceClientFake } from '../../testing/cert-prep-http-resource-client.fake';

describe('PracticePanelComponent', () => {
  let apiClient: ReturnType<typeof createApiClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    apiClient = createApiClient();

    TestBed.configureTestingModule({
      imports: [PracticePanelComponent],
      providers: [
        { provide: CERT_PREP_API, useValue: apiClient },
        provideCertPrepHttpResourceClientFake(apiClient),
      ],
    });
  });

  it('renders the random quiz empty state', () => {
    const fixture = TestBed.createComponent(PracticePanelComponent);
    fixture.componentRef.setInput('sessionMode', 'random_draw');

    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Random Quiz');
    expect(fixture.nativeElement.textContent).toContain(
      'Select a project before starting practice.',
    );
    expect(sessionDetail(fixture.nativeElement, 'Session ID')?.textContent?.trim()).toBe('Not started');
    expect(sessionDetail(fixture.nativeElement, 'Session ID')?.hasAttribute('title')).toBe(false);
    expect(sessionDetail(fixture.nativeElement, 'Status')?.textContent?.trim()).toBe('Ready');
    expect(sessionDetail(fixture.nativeElement, 'Answered')?.textContent?.trim()).toBe('0 of 0');
  });

  describe.each(['random_draw', 'full_document'] as const)('%s session details and choices', (mode) => {
    it.each(['active', 'completed', 'abandoned'] as const)('shows the shortened id, %s status, and unique answered count', (status) => {
      const questions = Array.from({ length: 5 }, (_, index) => editableQuestion(`draft-${index + 1}`));
      const store = arrangeActiveSession(questions);
      const id = '12345678-1234-1234-1234-123456789abc';
      store.practiceSession.set({
        ...practiceSession(questions.map((question) => question.id)),
        id, mode, status,
        attempts: [questions[0], questions[1], questions[0]].map((question, index) => ({
          id: `attempt-${index}`, session_id: id, project_id: appProject.id,
          question_id: question.id, selected_answer: question.choices[0],
          is_correct: false, created_at: '2026-10-28T00:00:00Z',
        })),
      });
      // The first answered id is also tracked locally after submission.
      store.answeredQuestionIds.set(new Set([questions[0].id]));
      const fixture = TestBed.createComponent(PracticePanelComponent);
      fixture.componentRef.setInput('sessionMode', mode);
      fixture.detectChanges();

      expect(sessionDetail(fixture.nativeElement, 'Session ID')?.textContent?.trim()).toBe('12345678');
      expect(sessionDetail(fixture.nativeElement, 'Session ID')?.getAttribute('title')).toBe(id);
      expect(sessionDetail(fixture.nativeElement, 'Status')?.textContent?.trim()).toBe({
        active: 'Active', completed: 'Completed', abandoned: 'Abandoned',
      }[status]);
      expect(sessionDetail(fixture.nativeElement, 'Answered')?.textContent?.trim()).toBe('2 of 5');
    });

    it('shows completion when every answer is recorded locally', () => {
      const store = arrangeActiveSession([editableAppQuestion]);
      store.answeredQuestionIds.set(new Set([editableAppQuestion.id]));
      const fixture = TestBed.createComponent(PracticePanelComponent);
      fixture.componentRef.setInput('sessionMode', mode);
      fixture.detectChanges();
      expect(sessionDetail(fixture.nativeElement, 'Status')?.textContent?.trim()).toBe('Completed');
      expect(sessionDetail(fixture.nativeElement, 'Answered')?.textContent?.trim()).toBe('1 of 1');
    });

    it('hides source ordinals but submits the exact original answer', () => {
      const question = editableQuestion('draft-1', {
        choices: ['１ からかって', '２ ためらって'], answer: '１ からかって',
      });
      const store = arrangeActiveSession([question]);
      apiClient.recordPracticeAttempt.mockReturnValue(of(null));
      const fixture = TestBed.createComponent(PracticePanelComponent);
      fixture.componentRef.setInput('sessionMode', mode);
      fixture.detectChanges();

      const root = fixture.nativeElement as HTMLElement;
      const firstChoice = root.querySelector<HTMLInputElement>('#practice-choice-0');
      expect(firstChoice?.closest('label')?.textContent?.trim().replace(/\s+/g, ' ')).toBe('A. からかって');
      expect(root.textContent).not.toContain('１ からかって');
      firstChoice?.click();
      fixture.detectChanges();
      TestBed.tick();
      expect(store.selectedAnswer()).toBe('１ からかって');
      buttonByText(root, 'Submit answer')?.click();
      TestBed.tick();
      expect(apiClient.recordPracticeAttempt).toHaveBeenCalledWith(appProject.id, 'session-1', {
        question_id: question.id, selected_answer: '１ からかって',
      }, { signal: expect.any(AbortSignal) });
    });
  });

  it('shows the effective random draw total before a session starts', () => {
    const projects = TestBed.inject(ProjectStore);
    const drafts = TestBed.inject(DraftReviewStore);
    projects.projects.set([appProject]);
    projects.select(appProject.id);
    drafts.drafts.set([editableAppQuestion]);
    apiClient.listQuestionDrafts.mockReturnValue(
      of({ items: [editableAppQuestion] }),
    );

    const fixture = TestBed.createComponent(PracticePanelComponent);
    fixture.componentRef.setInput('sessionMode', 'random_draw');
    fixture.detectChanges();

    expect(metricValue(fixture.nativeElement, 'Draw Size')).toBe('1');
    expect(fixture.nativeElement.textContent).toContain('Question 1 of 1');
  });

  it('loads project documents and drafts before rendering full exam readiness', () => {
    const projects = TestBed.inject(ProjectStore);
    projects.projects.set([appProject]);
    projects.select(appProject.id);
    apiClient.listDocuments.mockReturnValue(of({ items: [appDocument] }));
    apiClient.getDocument.mockReturnValue(of(appDocument));
    apiClient.listQuestionDrafts.mockReturnValue(
      of({ items: [editableAppQuestion] }),
    );

    const fixture = TestBed.createComponent(PracticePanelComponent);
    fixture.componentRef.setInput('sessionMode', 'full_document');
    fixture.detectChanges();
    TestBed.tick();
    fixture.detectChanges();

    expect(apiClient.listDocuments).toHaveBeenCalledWith(appProject.id);
    expect(apiClient.listQuestionDrafts).toHaveBeenCalledWith(appProject.id);
    expect(metricValue(fixture.nativeElement, 'Documents')).toBe('1');
    expect(metricValue(fixture.nativeElement, 'Questions')).toBe('1');
    expect(buttonByText(fixture.nativeElement, 'Start full exam')?.disabled).toBe(
      false,
    );
  });

  it('reports practice input load failures instead of leaking an unhandled rejection', () => {
    const projects = TestBed.inject(ProjectStore);
    const operations = TestBed.inject(OperationStore);
    const unhandledRejection = vi.fn();
    projects.projects.set([appProject]);
    projects.select(appProject.id);
    apiClient.listQuestionDrafts.mockReturnValue(
      throwError(() => new Error('offline')),
    );
    window.addEventListener('unhandledrejection', unhandledRejection);

    try {
      const fixture = TestBed.createComponent(PracticePanelComponent);
      fixture.componentRef.setInput('sessionMode', 'random_draw');
      fixture.detectChanges();

      vi.waitFor(() =>
        expect(operations.error()).toBe(
          'Practice data could not be loaded. Try refreshing the project.',
        ),
      );
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('unhandledrejection', unhandledRejection);
    }
  });

  it('selects an answer in an active practice session', () => {
    const store = arrangeActiveSession([editableAppQuestion]);
    apiClient.listQuestionDrafts.mockReturnValue(
      of({ items: [editableAppQuestion] }),
    );
    const fixture = TestBed.createComponent(PracticePanelComponent);
    fixture.componentRef.setInput('sessionMode', 'random_draw');
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    vi.waitFor(() =>
      expect(compiled.querySelector<HTMLInputElement>('#practice-choice-1')).not.toBeNull(),
    );
    const secondChoice =
      compiled.querySelector<HTMLInputElement>('#practice-choice-1');
    secondChoice?.click();
    fixture.detectChanges();
    TestBed.tick();

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

  it('clears an active answer selection', () => {
    const store = arrangeActiveSession([editableAppQuestion]);
    store.selectAnswer('Least privilege');

    const fixture = TestBed.createComponent(PracticePanelComponent);
    fixture.componentRef.setInput('sessionMode', 'random_draw');
    fixture.detectChanges();

    const clearButton = buttonByText(fixture.nativeElement, 'Clear selection');
    expect(clearButton?.disabled).toBe(false);

    clearButton?.click();
    fixture.detectChanges();
    TestBed.tick();

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
    const icon = submitButton?.querySelector('app-icon');

    expect(submitButton?.disabled).toBe(true);
    expect(icon?.getAttribute('data-icon')).toBe('lucideLoaderCircle');
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

function sessionDetail(root: ParentNode, label: string): HTMLElement | null {
  const row = Array.from(root.querySelectorAll('.practice-session-rail dl div'))
    .find((item) => item.querySelector('dt')?.textContent?.trim() === label);
  return row?.querySelector('dd') ?? null;
}

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
  apiClientForCurrentTest().listQuestionDrafts.mockReturnValue(
    of({ items: [...questions] }),
  );
  drafts.drafts.set([...questions]);
  store.practiceSession.set(
    practiceSession(questions.map((question) => question.id)),
  );
  return store;
}

function apiClientForCurrentTest(): ReturnType<typeof createApiClient> {
  return TestBed.inject(CERT_PREP_API) as unknown as ReturnType<
    typeof createApiClient
  >;
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
    abandoned_at: null,
    attempts: [],
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
    listWrongAnswers: vi.fn().mockReturnValue(of({ items: [] })),
    listQuestionDrafts: vi.fn().mockReturnValue(of({ items: [] })),
    listDocuments: vi.fn().mockReturnValue(of({ items: [] })),
    getDocument: vi.fn().mockReturnValue(of(appDocument)),
    listDocumentChunks: vi.fn().mockReturnValue(of({ items: [] })),
  };
}
