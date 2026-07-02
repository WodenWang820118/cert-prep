import { TestBed } from '@angular/core/testing';
import {
  CERT_PREP_API,
  type ProjectRead,
  type WrongAnswerExplanationRead,
  type WrongAnswerRead,
} from '../../cert-prep-api';
import { ProjectStore } from '../../stores/project.store';
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
    created_at: '2026-06-23T00:00:00Z',
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
    explainWrongAnswer: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    apiClient = {
      explainWrongAnswer: vi
        .fn()
        .mockRejectedValue(new Error('AI provider unavailable')),
    };
    await TestBed.configureTestingModule({
      imports: [WrongAnswerReviewComponent],
      providers: [{ provide: CERT_PREP_API, useValue: apiClient }],
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
    const review = TestBed.inject(WrongAnswerReviewStore);
    projects.projects.set([project]);
    projects.selectedProjectId.set(null);
    review.wrongAnswers.set([wrongAnswer]);

    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const refreshButton = element.querySelector<HTMLButtonElement>(
      '.review-refresh-button',
    );
    expect(element.textContent).toContain('1 recorded');
    expect(element.textContent).toContain('Page 3');
    expect(
      element.querySelector('[aria-label="Your answer"] p')?.textContent,
    ).toContain('B');
    expect(
      element.querySelector('[aria-label="Correct answer"] p')?.textContent,
    ).toContain('A');
    expect(element.textContent).toContain('The citation supports A.');
    expect(element.textContent).toContain('Relevant source excerpt.');
    expect(element.textContent).toContain('Answer correctly in a later session');
    expect(element.textContent).toContain('Discuss mistake with AI');
    expect(refreshButton?.disabled).toBe(true);
  });

  it('enables refresh when a project is selected and review is not busy', () => {
    const fixture = TestBed.createComponent(WrongAnswerReviewComponent);
    selectProject();

    fixture.detectChanges();

    expect(refreshButton(fixture.nativeElement as HTMLElement)?.disabled).toBe(
      false,
    );
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
});
