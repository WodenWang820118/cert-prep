import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../cert-prep-api';
import { DraftReviewStore } from './draft-review.store';
import { ProjectStore } from '../project.store';
import { SourceImportStore } from '../source-import/source-import.store';
import { documentRead, questionDraft } from './draft-review.store.spec-helpers';

describe('DraftReviewStore editable questions', () => {
  const apiClient = {
    generateDocumentDrafts: vi.fn(),
    getDocument: vi.fn(),
    listDocumentChunks: vi.fn(),
    listDocumentDraftJobs: vi.fn(),
    listQuestionDrafts: vi.fn(),
    retryDocumentDraftJobs: vi.fn(),
    updateQuestionDraft: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [{ provide: CERT_PREP_API, useValue: apiClient }],
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

    apiClient.getDocument.mockResolvedValue(documentRead());
    apiClient.listDocumentChunks.mockResolvedValue({ items: [] });
    apiClient.listDocumentDraftJobs.mockResolvedValue({ items: [] });
  });

  it('exposes generated rows as playable editable questions', () => {
    const store = TestBed.inject(DraftReviewStore);
    const question = questionDraft();

    store.drafts.set([question]);

    expect(store.playableQuestions()).toEqual([question]);
  });

  it('saves edited question text without a promotion request', async () => {
    const store = TestBed.inject(DraftReviewStore);
    const question = questionDraft({
      answer: null,
      rationale: null,
      answer_key_source: 'ai_inferred',
    });
    const saved = questionDraft({
      question: 'Updated question',
      answer: 'B',
      answer_key_source: 'manual',
      rationale: 'Manual rationale',
    });
    apiClient.updateQuestionDraft.mockResolvedValue(saved);
    store.drafts.set([question]);
    store.startEdit(question);
    store.setEditQuestion(question.id, 'Updated question');
    store.setEditAnswer(question.id, 'B');
    store.setEditRationale(question.id, 'Manual rationale');

    await store.saveDraft(question);

    expect(apiClient.updateQuestionDraft).toHaveBeenCalledWith(
      'project-1',
      question.id,
      expect.objectContaining({
        question: 'Updated question',
        answer: 'B',
        answer_key_source: 'manual',
        rationale: 'Manual rationale',
      }),
    );
    expect(store.drafts()).toEqual([saved]);
    expect(store.isEditing(saved)).toBe(false);
  });

  it('refreshes document metadata after generated questions are returned', async () => {
    const store = TestBed.inject(DraftReviewStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const question = questionDraft();
    const refreshedDocument = documentRead({ exam_item_count: 1 });
    sourceImport.uploadedDocument.set(documentRead());
    apiClient.generateDocumentDrafts.mockResolvedValue({ items: [question] });
    apiClient.getDocument.mockResolvedValue(refreshedDocument);
    apiClient.listQuestionDrafts.mockResolvedValue({ items: [question] });

    await store.generateDrafts('hybrid_reasoning');

    expect(store.drafts()).toEqual([question]);
    expect(apiClient.listDocumentDraftJobs).toHaveBeenCalledWith(
      'project-1',
      'document-1',
    );
    expect(sourceImport.documents()).toEqual([refreshedDocument]);
  });
});
