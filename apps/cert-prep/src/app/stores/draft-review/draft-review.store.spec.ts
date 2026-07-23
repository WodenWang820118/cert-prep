import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../cert-prep-api';
import type { QuestionDraftRead } from '../../cert-prep-api';
import { DraftReviewStore } from './draft-review.store';
import { ProjectStore } from '../project.store';
import { SourceImportStore } from '../source-import/source-import.store';
import {
  documentRead,
  manualDraftOperation,
  questionDraft,
} from './draft-review.store.spec-helpers';
import { provideCertPrepHttpResourceClientFake } from '../../testing/cert-prep-http-resource-client.fake';

describe('DraftReviewStore editable questions', () => {
  const apiClient = {
    startManualDraftOperation: vi.fn(),
    getManualDraftOperation: vi.fn(),
    cancelManualDraftOperation: vi.fn(),
    getDocument: vi.fn(),
    listDocumentChunks: vi.fn(),
    listDocumentDraftJobs: vi.fn(),
    listQuestionDrafts: vi.fn(),
    retryDocumentDraftJobs: vi.fn(),
    updateQuestionDraft: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.listQuestionDrafts.mockReset();
    apiClient.listQuestionDrafts.mockResolvedValue({ items: [] });
    TestBed.configureTestingModule({
      providers: [
        { provide: CERT_PREP_API, useValue: apiClient },
        provideCertPrepHttpResourceClientFake(apiClient),
      ],
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

  it('exposes approved rows as playable editable questions', () => {
    const store = TestBed.inject(DraftReviewStore);
    const question = questionDraft();

    store.drafts.set([question]);

    expect(store.playableQuestions()).toEqual([question]);
    expect(store.isPlayableDraft(question)).toBe(true);
    expect(store.draftStatusLabel(question)).toBe('Playable');
  });

  it('keeps non-approved rows editable but out of practice eligibility', () => {
    const store = TestBed.inject(DraftReviewStore);
    const approved = questionDraft({ id: 'approved-draft' });
    const rejected = questionDraft({
      id: 'rejected-draft',
      status: 'rejected',
      rejection_reason: 'Insufficient answer choices.',
    });

    store.drafts.set([approved, rejected]);

    expect(store.drafts()).toEqual([approved, rejected]);
    expect(store.playableQuestions()).toEqual([approved]);
    expect(store.isPlayableDraft(rejected)).toBe(false);
    expect(store.draftStatusLabel(rejected)).toBe('Not playable');
  });

  it('excludes approved rows that are missing playable question fields', () => {
    const store = TestBed.inject(DraftReviewStore);
    const playable = questionDraft({ id: 'playable-draft' });
    const incompleteCases: ReadonlyArray<{
      readonly overrides: Partial<QuestionDraftRead>;
    }> = [
      { overrides: { question: '   ' } },
      { overrides: { choices: ['A', '   '] } },
      { overrides: { choices: ['A', 'B'], answer: '   ' } },
      { overrides: { choices: ['A', 'B'], answer: 'C' } },
      { overrides: { rationale: '   ' } },
      { overrides: { citation_page: null, source_excerpt: null } },
      { overrides: { citation_page: null, source_excerpt: '   ' } },
    ];
    const incompleteDrafts = incompleteCases.map((testCase, index) =>
      questionDraft({
        id: `incomplete-draft-${index + 1}`,
        ...testCase.overrides,
      }),
    );

    store.drafts.set([playable, ...incompleteDrafts]);

    expect(store.playableQuestions()).toEqual([playable]);
    for (const draft of incompleteDrafts) {
      expect(store.isPlayableDraft(draft)).toBe(false);
      expect(store.draftStatusLabel(draft)).toBe('Not playable');
    }
  });

  it('keeps project playable questions while scoping review rows to the active document', () => {
    const store = TestBed.inject(DraftReviewStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const firstDocument = documentRead({ id: 'document-1', filename: 'first.pdf' });
    const secondDocument = documentRead({
      id: 'document-2',
      filename: 'second.pdf',
    });
    const firstQuestion = questionDraft({
      id: 'first-draft',
      document_id: firstDocument.id,
    });
    const secondQuestion = questionDraft({
      id: 'second-draft',
      document_id: secondDocument.id,
    });
    sourceImport.documents.set([firstDocument, secondDocument]);
    sourceImport.setActiveDocumentId(secondDocument.id);

    store.drafts.set([firstQuestion, secondQuestion]);

    expect(store.playableQuestions()).toEqual([firstQuestion, secondQuestion]);
    expect(store.activeDocumentDrafts()).toEqual([secondQuestion]);
    expect(store.activeDocumentPlayableQuestions()).toEqual([secondQuestion]);
  });

  it('ignores stale draft loads after the selected project changes', async () => {
    const store = TestBed.inject(DraftReviewStore);
    const projects = TestBed.inject(ProjectStore);
    const currentProjectDraft = questionDraft({
      id: 'current-project-draft',
      project_id: 'project-2',
    });
    const staleProjectDraft = questionDraft({
      id: 'stale-project-draft',
      project_id: 'project-1',
    });
    const staleDrafts = deferred<{ items: QuestionDraftRead[] }>();
    apiClient.listQuestionDrafts.mockReturnValueOnce(staleDrafts.promise);
    store.drafts.set([currentProjectDraft]);

    const load = store.load('project-1');
    projects.select('project-2');
    staleDrafts.resolve({ items: [staleProjectDraft] });
    await load;

    expect(store.drafts()).toEqual([currentProjectDraft]);
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
    vi.useFakeTimers();
    const store = TestBed.inject(DraftReviewStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const question = questionDraft();
    const refreshedDocument = documentRead({ exam_item_count: 1 });
    activateDocument(sourceImport, documentRead());
    apiClient.startManualDraftOperation.mockResolvedValue(
      manualDraftOperation(),
    );
    apiClient.getManualDraftOperation.mockResolvedValue(
      manualDraftOperation({
        status: 'succeeded',
        phase: 'succeeded',
        cancellable: false,
        generated_count: 1,
      }),
    );
    apiClient.getDocument.mockResolvedValue(refreshedDocument);
    apiClient.listQuestionDrafts.mockResolvedValue({ items: [question] });

    await store.generateDrafts('hybrid_reasoning');
    await vi.advanceTimersByTimeAsync(1500);

    await vi.waitFor(() => expect(store.drafts()).toEqual([question]));
    expect(store.drafts()).toEqual([question]);
    expect(apiClient.listDocumentDraftJobs).toHaveBeenCalledWith(
      'project-1',
      'document-1',
    );
    expect(sourceImport.documents()).toEqual([refreshedDocument]);
    vi.useRealTimers();
  });
});

function activateDocument(
  sourceImport: SourceImportStore,
  document: ReturnType<typeof documentRead>,
): void {
  sourceImport.documents.set([document]);
  sourceImport.setActiveDocumentId(document.id);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}
