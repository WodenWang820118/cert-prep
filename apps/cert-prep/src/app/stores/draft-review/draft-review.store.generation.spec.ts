import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { CERT_PREP_API } from '../../constants/cert-prep-api.constants';
import { CertPrepSseClient } from '../../services/cert-prep-sse-client.service';
import { OperationStore } from '../operation.store';
import { DraftReviewStore } from './draft-review.store';
import { provideCertPrepHttpResourceClientFake } from '../../testing/cert-prep-http-resource-client.fake';
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
  let manualStream: Subject<ReturnType<typeof manualDraftOperation>>;
  const sseClient = { streamJson: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    manualStream = new Subject();
    sseClient.streamJson.mockReturnValue(manualStream.asObservable());
    TestBed.configureTestingModule({
      providers: [
        { provide: CERT_PREP_API, useValue: apiClient },
        { provide: CertPrepSseClient, useValue: sseClient },
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

    apiClient.getDocument.mockReturnValue(of(documentRead()));
    apiClient.listDocumentChunks.mockReturnValue(of({ items: [] }));
    apiClient.listDocumentDraftJobs.mockReturnValue(of({ items: [] }));
  });

  it('uses source-file guidance when generation has no active document', () => {
    const store = TestBed.inject(DraftReviewStore);
    const operations = TestBed.inject(OperationStore);

    store.generateDrafts();
    TestBed.tick();

    expect(operations.error()).toBe(
      'Upload a source file with extractable text before generating questions.',
    );
    expect(apiClient.startManualDraftOperation).not.toHaveBeenCalled();
  });

  it('sends deterministic strategy when generating deterministic questions', () => {
    const store = TestBed.inject(DraftReviewStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const draft = questionDraft();
    activateDocument(sourceImport, documentRead());
    apiClient.startManualDraftOperation.mockReturnValue(of(
      manualDraftOperation({ strategy: 'deterministic_only' }),
    ));
    apiClient.listQuestionDrafts.mockReturnValue(of({ items: [draft] }));

    store.generateDrafts('deterministic_only');
    TestBed.tick();

    expect(apiClient.startManualDraftOperation).toHaveBeenCalledWith(
      'project-1',
      'document-1',
      { limit: 3, strategy: 'deterministic_only' },
      { signal: expect.any(AbortSignal) },
    );
    manualStream.next(manualDraftOperation({
      strategy: 'deterministic_only',
      status: 'succeeded',
      phase: 'succeeded',
      cancellable: false,
      generated_count: 1,
    }));
    TestBed.tick();
    expect(apiClient.listDocumentDraftJobs).toHaveBeenCalledWith(
      'project-1',
      'document-1',
    );
  });

  it('sends hybrid reasoning strategy when generating questions', () => {
    const store = TestBed.inject(DraftReviewStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const draft = questionDraft();
    store.setQuestionLimit(8);
    activateDocument(sourceImport, documentRead());
    apiClient.startManualDraftOperation.mockReturnValue(of(
      manualDraftOperation({ limit: 8 }),
    ));
    apiClient.listQuestionDrafts.mockReturnValue(of({ items: [draft] }));

    store.generateDrafts('hybrid_reasoning');
    TestBed.tick();

    expect(apiClient.startManualDraftOperation).toHaveBeenCalledWith(
      'project-1',
      'document-1',
      { limit: 8, strategy: 'hybrid_reasoning' },
      { signal: expect.any(AbortSignal) },
    );
    manualStream.next(manualDraftOperation({
      limit: 8,
      status: 'succeeded',
      phase: 'succeeded',
      cancellable: false,
      generated_count: 1,
    }));
    TestBed.tick();
    expect(apiClient.listDocumentDraftJobs).toHaveBeenCalledWith(
      'project-1',
      'document-1',
    );
  });

  it('requests cancellation and applies the terminal manual operation event', () => {
    const store = TestBed.inject(DraftReviewStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    activateDocument(sourceImport, documentRead());
    apiClient.startManualDraftOperation.mockReturnValue(of(
      manualDraftOperation(),
    ));
    apiClient.cancelManualDraftOperation.mockReturnValue(of(
      manualDraftOperation({
        status: 'cancel_requested',
        phase: 'canceling',
      }),
    ));

    store.generateDrafts();
    TestBed.tick();
    store.cancelManualDraftOperation();
    TestBed.tick();

    expect(apiClient.cancelManualDraftOperation).toHaveBeenCalledWith(
      'project-1',
      'document-1',
      'manual-operation-1',
    );
    expect(store.manualDraftOperation()?.status).toBe('cancel_requested');

    manualStream.next(manualDraftOperation({
      status: 'canceled',
      phase: 'canceled',
      cancellable: false,
    }));
    TestBed.tick();
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
