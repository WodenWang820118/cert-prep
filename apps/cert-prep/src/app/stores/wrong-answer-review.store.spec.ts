import { TestBed } from '@angular/core/testing';
import {
  CERT_PREP_API,
  ProjectRead,
  WrongAnswerRead,
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
    created_at: '2026-06-23T00:00:00Z',
  };
  const apiClient = {
    listWrongAnswers: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(store.wrongAnswers()).toEqual([wrongAnswer]);
  });

  it('guards refresh until a project is selected', async () => {
    const projects = TestBed.inject(ProjectStore);
    projects.selectedProjectId.set(null);
    const operations = TestBed.inject(OperationStore);
    const store = TestBed.inject(WrongAnswerReviewStore);

    await store.refresh();

    expect(apiClient.listWrongAnswers).not.toHaveBeenCalled();
    expect(operations.error()).toBe('Select a project before refreshing review.');
  });

  it('refreshes review rows through the operation store', async () => {
    apiClient.listWrongAnswers.mockResolvedValue({ items: [wrongAnswer] });
    const operations = TestBed.inject(OperationStore);
    const store = TestBed.inject(WrongAnswerReviewStore);

    await store.refresh();

    expect(apiClient.listWrongAnswers).toHaveBeenCalledWith(project.id);
    expect(store.wrongAnswers()).toEqual([wrongAnswer]);
    expect(operations.status()).toBe('Review refreshed');
  });
});
