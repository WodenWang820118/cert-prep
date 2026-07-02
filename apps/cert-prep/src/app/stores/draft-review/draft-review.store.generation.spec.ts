import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../cert-prep-api';
import { DraftReviewStore } from './draft-review.store';
import { ProjectStore } from '../project.store';
import { SourceImportStore } from '../source-import/source-import.store';
import { documentRead, questionDraft } from './draft-review.store.spec-helpers';

describe('DraftReviewStore generation', () => {
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

  it('sends deterministic strategy when generating deterministic questions', async () => {
    const store = TestBed.inject(DraftReviewStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const draft = questionDraft();
    activateDocument(sourceImport, documentRead());
    apiClient.generateDocumentDrafts.mockResolvedValue({ items: [draft] });
    apiClient.listQuestionDrafts.mockResolvedValue({ items: [draft] });

    await store.generateDrafts('deterministic_only');

    expect(apiClient.generateDocumentDrafts).toHaveBeenCalledWith(
      'project-1',
      'document-1',
      { limit: 3, strategy: 'deterministic_only' },
    );
    expect(apiClient.listDocumentDraftJobs).toHaveBeenCalledWith(
      'project-1',
      'document-1',
    );
  });

  it('sends hybrid reasoning strategy when generating questions', async () => {
    const store = TestBed.inject(DraftReviewStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const draft = questionDraft();
    store.setQuestionLimit(8);
    activateDocument(sourceImport, documentRead());
    apiClient.generateDocumentDrafts.mockResolvedValue({ items: [draft] });
    apiClient.listQuestionDrafts.mockResolvedValue({ items: [draft] });

    await store.generateDrafts('hybrid_reasoning');

    expect(apiClient.generateDocumentDrafts).toHaveBeenCalledWith(
      'project-1',
      'document-1',
      { limit: 8, strategy: 'hybrid_reasoning' },
    );
    expect(apiClient.listDocumentDraftJobs).toHaveBeenCalledWith(
      'project-1',
      'document-1',
    );
  });
});

function activateDocument(
  sourceImport: SourceImportStore,
  document: ReturnType<typeof documentRead>,
): void {
  sourceImport.documents.set([document]);
  sourceImport.setActiveDocumentId(document.id);
}
