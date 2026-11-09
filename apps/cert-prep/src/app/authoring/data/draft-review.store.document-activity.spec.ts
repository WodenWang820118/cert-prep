import { TestBed } from '@angular/core/testing';
import { NEVER, of } from 'rxjs';
import { CERT_PREP_API, CertPrepSseClient } from '../../core/data';
import type { DocumentRead } from '../../core/domain';
import { ProjectStore } from '../../projects/data';
import { SourceImportStore } from '../../source-library/data';
import { provideCertPrepHttpResourceClientFake } from '../../core/testing';
import { DraftReviewStore } from './draft-review.store';
import { documentRead } from './draft-review.store.spec-helpers';

const latestDocument: DocumentRead = documentRead();
const otherDocument: DocumentRead = documentRead({
  id: 'document-2',
  filename: 'second.pdf',
});

describe('DraftReviewStore reacting to source document activity', () => {
  const apiClient = {
    listDocuments: vi.fn(),
    getDocument: vi.fn(),
    listDocumentChunks: vi.fn(),
    listDocumentDraftJobs: vi.fn(),
    listQuestionDrafts: vi.fn(),
    uploadDocument: vi.fn(),
  };
  let drafts: DraftReviewStore;
  let sourceImport: SourceImportStore;
  let load: ReturnType<typeof vi.fn<(projectId: string) => void>>;

  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.listDocuments.mockReturnValue(
      of({ items: [latestDocument, otherDocument] }),
    );
    apiClient.getDocument.mockImplementation(
      (_projectId: string, documentId: string) =>
        of(documentId === otherDocument.id ? otherDocument : latestDocument),
    );
    apiClient.listDocumentChunks.mockReturnValue(of({ items: [] }));
    apiClient.listDocumentDraftJobs.mockReturnValue(of({ items: [] }));
    apiClient.listQuestionDrafts.mockReturnValue(of({ items: [] }));
    apiClient.uploadDocument.mockReturnValue(NEVER);
    TestBed.configureTestingModule({
      providers: [
        { provide: CERT_PREP_API, useValue: apiClient },
        { provide: CertPrepSseClient, useValue: { streamJson: vi.fn() } },
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
    drafts = TestBed.inject(DraftReviewStore);
    sourceImport = TestBed.inject(SourceImportStore);
    load = vi.fn<(projectId: string) => void>();
    vi.spyOn(drafts, 'load').mockImplementation(load);
    TestBed.tick();
  });

  function activateLatestDocument(): void {
    sourceImport.loadLatestDocument('project-1');
    TestBed.tick();
    load.mockClear();
  }

  it('reloads the drafts when the latest document becomes active', () => {
    expect(load).not.toHaveBeenCalled();

    sourceImport.loadLatestDocument('project-1');
    TestBed.tick();

    expect(sourceImport.activeDocumentId()).toBe(latestDocument.id);
    expect(load).toHaveBeenCalledExactlyOnceWith('project-1');
  });

  it('reloads the drafts when the learner uploads', () => {
    activateLatestDocument();
    sourceImport.chooseFiles([
      new File(['%PDF-1.7'], 'upload.pdf', { type: 'application/pdf' }),
    ]);
    TestBed.tick();
    load.mockClear();

    sourceImport.uploadDocuments();
    TestBed.tick();

    expect(apiClient.uploadDocument).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledExactlyOnceWith('project-1');
  });

  it('reloads the drafts when the learner selects another document', () => {
    activateLatestDocument();

    sourceImport.selectDocument(otherDocument.id);
    TestBed.tick();

    expect(load).toHaveBeenCalledExactlyOnceWith('project-1');
  });

  it('reloads the drafts when the learner selects the active document again', () => {
    activateLatestDocument();

    sourceImport.selectDocument(latestDocument.id);
    TestBed.tick();
    sourceImport.selectDocument(latestDocument.id);
    TestBed.tick();

    expect(sourceImport.activeDocumentId()).toBe(latestDocument.id);
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenNthCalledWith(2, 'project-1');
  });
});
