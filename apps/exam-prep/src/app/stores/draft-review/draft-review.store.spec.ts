import { TestBed } from '@angular/core/testing';
import { DocumentRead, EXAM_PREP_API, QuestionDraftRead } from '../../exam-prep-api';
import { DraftReviewStore } from './draft-review.store';
import { OperationStore } from '../operation.store';
import { ProjectStore } from '../project.store';
import { SourceImportStore } from '../source-import/source-import.store';

describe('DraftReviewStore', () => {
  const apiClient = {
    approveQuestionDraft: vi.fn(),
    generateDocumentDrafts: vi.fn(),
    getDocument: vi.fn(),
    listDocumentChunks: vi.fn(),
    listQuestionDrafts: vi.fn(),
    updateQuestionDraft: vi.fn(),
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

    apiClient.getDocument.mockResolvedValue(documentRead());
    apiClient.listDocumentChunks.mockResolvedValue({ items: [] });
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
    expect(operations.error()).toContain('missing source excerpt');
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
    const sourceImport = TestBed.inject(SourceImportStore);
    const draft = questionDraft({ status: 'draft' });
    const approved = questionDraft({ status: 'approved' });
    const refreshedDocument = documentRead({ exam_item_count: 1 });
    apiClient.approveQuestionDraft.mockResolvedValue(approved);
    apiClient.getDocument.mockResolvedValue(refreshedDocument);
    sourceImport.documents.set([documentRead({ status: 'processing' })]);
    store.drafts.set([draft]);

    await store.approveDraft(draft);

    expect(apiClient.approveQuestionDraft).toHaveBeenCalledWith(
      'project-1',
      draft.id,
    );
    expect(store.drafts()).toEqual([approved]);
    expect(apiClient.getDocument).toHaveBeenCalledWith('project-1', 'document-1');
    expect(apiClient.listDocumentChunks).toHaveBeenCalledWith(
      'project-1',
      'document-1',
    );
    expect(sourceImport.documents()).toEqual([refreshedDocument]);
  });

  it('saves manual edits before approving a draft', async () => {
    const store = TestBed.inject(DraftReviewStore);
    const draft = questionDraft({
      answer: null,
      rationale: null,
      answer_key_source: 'ai_inferred',
    });
    const saved = questionDraft({
      answer: 'B',
      answer_key_source: 'manual',
      rationale: 'Manual rationale',
    });
    const approved = questionDraft({
      ...saved,
      status: 'approved',
    });
    apiClient.updateQuestionDraft.mockResolvedValue(saved);
    apiClient.approveQuestionDraft.mockResolvedValue(approved);
    store.drafts.set([draft]);
    store.startEdit(draft);
    store.setEditAnswer(draft.id, 'B');
    store.setEditRationale(draft.id, 'Manual rationale');

    await store.saveAndApproveDraft(draft);

    expect(apiClient.updateQuestionDraft).toHaveBeenCalledWith(
      'project-1',
      draft.id,
      expect.objectContaining({
        answer: 'B',
        answer_key_source: 'manual',
        rationale: 'Manual rationale',
      }),
    );
    expect(apiClient.approveQuestionDraft).toHaveBeenCalledWith(
      'project-1',
      draft.id,
    );
    expect(store.drafts()).toEqual([approved]);
  });

  it('sends deterministic strategy when generating deterministic drafts', async () => {
    const store = TestBed.inject(DraftReviewStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const draft = questionDraft();
    sourceImport.uploadedDocument.set(documentRead());
    apiClient.generateDocumentDrafts.mockResolvedValue({ items: [draft] });
    apiClient.listQuestionDrafts.mockResolvedValue({ items: [draft] });

    await store.generateDrafts('deterministic_only');

    expect(apiClient.generateDocumentDrafts).toHaveBeenCalledWith(
      'project-1',
      'document-1',
      { limit: 3, strategy: 'deterministic_only' },
    );
  });

  it('sends hybrid reasoning strategy when enriching drafts', async () => {
    const store = TestBed.inject(DraftReviewStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const draft = questionDraft();
    store.setDraftLimit(8);
    sourceImport.uploadedDocument.set(documentRead());
    apiClient.generateDocumentDrafts.mockResolvedValue({ items: [draft] });
    apiClient.listQuestionDrafts.mockResolvedValue({ items: [draft] });

    await store.generateDrafts('hybrid_reasoning');

    expect(apiClient.generateDocumentDrafts).toHaveBeenCalledWith(
      'project-1',
      'document-1',
      { limit: 8, strategy: 'hybrid_reasoning' },
    );
  });

  it('refreshes drafts while a processing document has completed chunks', async () => {
    const store = TestBed.inject(DraftReviewStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const draft = questionDraft();
    apiClient.listQuestionDrafts.mockResolvedValue({ items: [draft] });

    sourceImport.uploadedDocument.set(
      documentRead({ status: 'processing', chunks_count: 1 }),
    );
    TestBed.tick();
    await Promise.resolve();
    await Promise.resolve();

    expect(apiClient.listQuestionDrafts).toHaveBeenCalledWith('project-1');
    expect(store.drafts()).toEqual([draft]);

    sourceImport.uploadedDocument.set(documentRead({ status: 'ready' }));
    TestBed.tick();
    await Promise.resolve();
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
    confidence: null,
    source_order: 10001,
    source_question_number: '1',
    item_kind: 'vocabulary_single_question',
    group_key: null,
    group_prompt: null,
    status: 'draft',
    rejection_reason: null,
    created_at: '2026-06-09T00:00:00Z',
    updated_at: '2026-06-09T00:00:00Z',
    ...overrides,
  };
}

function documentRead(overrides: Partial<DocumentRead> = {}): DocumentRead {
  return {
    id: 'document-1',
    project_id: 'project-1',
    filename: 'jlpt-n1.pdf',
    sha256: 'document-sha',
    language_hint: 'ja',
    page_count: 46,
    has_text: true,
    status: 'ready',
    extraction_method: 'paddle_ocr_gpu',
    ocr_device: 'gpu:0',
    ocr_fallback_reason: null,
    ocr_duration_ms: 26513,
    processed_page_count: 46,
    parse_wall_duration_ms: 0,
    render_duration_ms: 0,
    ocr_engine_duration_ms: 26513,
    ocr_worker_count: 1,
    first_chunk_ms: 0,
    exam_item_count: 0,
    content_profile: 'vocabulary_single_questions',
    classification_detail: '{"profile":"vocabulary_single_questions"}',
    chunks_count: 46,
    created_at: '2026-06-09T00:00:00Z',
    updated_at: '2026-06-09T00:00:00Z',
    ...overrides,
  };
}
