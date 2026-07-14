import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../cert-prep-api';
import { DraftReviewStore } from './draft-review.store';
import { ProjectStore } from '../project.store';
import { SourceImportStore } from '../source-import/source-import.store';
import {
  documentRead,
  manualDraftOperation,
  questionDraft,
} from './draft-review.store.spec-helpers';

describe('DraftReviewStore generation', () => {
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
    vi.useFakeTimers();
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends deterministic strategy when generating deterministic questions', async () => {
    const store = TestBed.inject(DraftReviewStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const draft = questionDraft();
    activateDocument(sourceImport, documentRead());
    apiClient.startManualDraftOperation.mockResolvedValue(
      manualDraftOperation({ strategy: 'deterministic_only' }),
    );
    apiClient.getManualDraftOperation.mockResolvedValue(
      manualDraftOperation({
        strategy: 'deterministic_only',
        status: 'succeeded',
        phase: 'succeeded',
        cancellable: false,
        generated_count: 1,
      }),
    );
    apiClient.listQuestionDrafts.mockResolvedValue({ items: [draft] });

    await store.generateDrafts('deterministic_only');

    expect(apiClient.startManualDraftOperation).toHaveBeenCalledWith(
      'project-1',
      'document-1',
      { limit: 3, strategy: 'deterministic_only' },
    );
    await vi.advanceTimersByTimeAsync(1500);
    expect(apiClient.getManualDraftOperation).toHaveBeenCalledWith(
      'project-1',
      'document-1',
      'manual-operation-1',
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
    apiClient.startManualDraftOperation.mockResolvedValue(
      manualDraftOperation({ limit: 8 }),
    );
    apiClient.getManualDraftOperation.mockResolvedValue(
      manualDraftOperation({
        limit: 8,
        status: 'succeeded',
        phase: 'succeeded',
        cancellable: false,
        generated_count: 1,
      }),
    );
    apiClient.listQuestionDrafts.mockResolvedValue({ items: [draft] });

    await store.generateDrafts('hybrid_reasoning');

    expect(apiClient.startManualDraftOperation).toHaveBeenCalledWith(
      'project-1',
      'document-1',
      { limit: 8, strategy: 'hybrid_reasoning' },
    );
    await vi.advanceTimersByTimeAsync(1500);
    expect(apiClient.listDocumentDraftJobs).toHaveBeenCalledWith(
      'project-1',
      'document-1',
    );
  });

  it('requests cancellation and keeps polling until the manual operation is terminal', async () => {
    const store = TestBed.inject(DraftReviewStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    activateDocument(sourceImport, documentRead());
    apiClient.startManualDraftOperation.mockResolvedValue(
      manualDraftOperation(),
    );
    apiClient.cancelManualDraftOperation.mockResolvedValue(
      manualDraftOperation({
        status: 'cancel_requested',
        phase: 'canceling',
      }),
    );
    apiClient.getManualDraftOperation.mockResolvedValue(
      manualDraftOperation({
        status: 'canceled',
        phase: 'canceled',
        cancellable: false,
      }),
    );

    await store.generateDrafts();
    await store.cancelManualDraftOperation();

    expect(apiClient.cancelManualDraftOperation).toHaveBeenCalledWith(
      'project-1',
      'document-1',
      'manual-operation-1',
    );
    expect(store.manualDraftOperation()?.status).toBe('cancel_requested');

    await vi.advanceTimersByTimeAsync(1500);
    expect(store.manualDraftOperation()?.status).toBe('canceled');
  });
});

function activateDocument(
  sourceImport: SourceImportStore,
  document: ReturnType<typeof documentRead>,
): void {
  sourceImport.documents.set([document]);
  sourceImport.setActiveDocumentId(document.id);
}
