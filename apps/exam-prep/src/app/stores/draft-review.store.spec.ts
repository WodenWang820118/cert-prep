import { TestBed } from '@angular/core/testing';
import { EXAM_PREP_API, QuestionDraftRead } from '../exam-prep-api';
import { DraftReviewStore } from './draft-review.store';
import { OperationStore } from './operation.store';
import { ProjectStore } from './project.store';

describe('DraftReviewStore', () => {
  const apiClient = {
    approveQuestionDraft: vi.fn(),
    generateDocumentDrafts: vi.fn(),
    listQuestionDrafts: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [{ provide: EXAM_PREP_API, useValue: apiClient }],
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
  });

  it('blocks approval when citation evidence is incomplete', async () => {
    const store = TestBed.inject(DraftReviewStore);
    const operations = TestBed.inject(OperationStore);
    const incompleteDraft = questionDraft({
      source_excerpt: null,
    });

    expect(store.canApprove(incompleteDraft)).toBe(false);

    await store.approveDraft(incompleteDraft);

    expect(apiClient.approveQuestionDraft).not.toHaveBeenCalled();
    expect(operations.error()).toContain('Draft needs a citation');
  });

  it('blocks approval when the answer key is not one of the choices', async () => {
    const store = TestBed.inject(DraftReviewStore);
    const invalidDraft = questionDraft({
      answer: 'Z',
    });

    expect(store.canApprove(invalidDraft)).toBe(false);

    await store.approveDraft(invalidDraft);

    expect(apiClient.approveQuestionDraft).not.toHaveBeenCalled();
  });

  it('blocks approval when the citation page is invalid', async () => {
    const store = TestBed.inject(DraftReviewStore);
    const invalidDraft = questionDraft({
      citation_page: 0,
    });

    expect(store.canApprove(invalidDraft)).toBe(false);

    await store.approveDraft(invalidDraft);

    expect(apiClient.approveQuestionDraft).not.toHaveBeenCalled();
  });

  it('approves and upserts a fully cited draft', async () => {
    const store = TestBed.inject(DraftReviewStore);
    const draft = questionDraft({ status: 'draft' });
    const approved = questionDraft({ status: 'approved' });
    apiClient.approveQuestionDraft.mockResolvedValue(approved);
    store.drafts.set([draft]);

    await store.approveDraft(draft);

    expect(apiClient.approveQuestionDraft).toHaveBeenCalledWith(
      'project-1',
      draft.id,
    );
    expect(store.drafts()).toEqual([approved]);
  });
});

function questionDraft(
  overrides: Partial<QuestionDraftRead> = {},
): QuestionDraftRead {
  return {
    id: 'draft-1',
    project_id: 'project-1',
    document_id: 'document-1',
    chunk_id: 'chunk-1',
    question: 'Which answer is supported by the cited source?',
    choices: ['A', 'B', 'C', 'D'],
    answer: 'A',
    answer_key_source: 'ai_inferred',
    rationale: 'The source supports A.',
    citation_page: 1,
    source_excerpt: 'The cited source supports answer A.',
    status: 'draft',
    rejection_reason: null,
    created_at: '2026-06-09T00:00:00Z',
    updated_at: '2026-06-09T00:00:00Z',
    ...overrides,
  };
}
