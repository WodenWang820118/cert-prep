import { TestBed } from '@angular/core/testing';
import { NEVER, of } from 'rxjs';
import { CERT_PREP_API, CertPrepSseClient } from '../../core/data';
import type { DocumentRead } from '../../core/domain';
import { ProjectStore } from '../../projects/data';
import { appDocument, appProject } from '../../core/testing';
import { provideCertPrepHttpResourceClientFake } from '../../core/testing';
import { SourceImportStore } from './source-import.store';

const otherDocument: DocumentRead = {
  ...appDocument,
  id: 'document-3',
  filename: 'controls.pdf',
};

describe('SourceImportStore document activity', () => {
  const apiClient = {
    listDocuments: vi.fn(),
    getDocument: vi.fn(),
    listDocumentChunks: vi.fn(),
    uploadDocument: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.listDocuments.mockReturnValue(
      of({ items: [appDocument, otherDocument] }),
    );
    apiClient.getDocument.mockImplementation(
      (_projectId: string, documentId: string) =>
        of(documentId === otherDocument.id ? otherDocument : appDocument),
    );
    apiClient.listDocumentChunks.mockReturnValue(of({ items: [] }));
    apiClient.uploadDocument.mockReturnValue(NEVER);
    TestBed.configureTestingModule({
      providers: [
        { provide: CERT_PREP_API, useValue: apiClient },
        { provide: CertPrepSseClient, useValue: { streamJson: vi.fn() } },
        provideCertPrepHttpResourceClientFake(apiClient),
      ],
    });
  });

  function selectProject(): void {
    const projects = TestBed.inject(ProjectStore);
    projects.projects.set([appProject]);
    projects.select(appProject.id);
  }

  function storeWithActiveDocument(): SourceImportStore {
    selectProject();
    const store = TestBed.inject(SourceImportStore);
    store.loadLatestDocument(appProject.id);
    TestBed.tick();
    return store;
  }

  it('reports activity when the latest document becomes active', () => {
    selectProject();
    const store = TestBed.inject(SourceImportStore);
    TestBed.tick();
    expect(store.documentActivity()).toBeNull();

    store.loadLatestDocument(appProject.id);
    TestBed.tick();

    expect(store.activeDocumentId()).toBe(appDocument.id);
    expect(store.documentActivity()).toEqual({ projectId: appProject.id });
  });

  it('reports a new activity when the learner uploads', () => {
    const store = storeWithActiveDocument();
    store.chooseFiles([
      new File(['%PDF-1.7'], 'upload.pdf', { type: 'application/pdf' }),
    ]);
    TestBed.tick();
    const before = store.documentActivity();

    store.uploadDocuments();

    expect(apiClient.uploadDocument).toHaveBeenCalledTimes(1);
    expect(store.documentActivity()).toEqual({ projectId: appProject.id });
    expect(store.documentActivity()).not.toBe(before);
  });

  it('reports a new activity when the learner selects another document', () => {
    const store = storeWithActiveDocument();
    const before = store.documentActivity();

    store.selectDocument(otherDocument.id);

    expect(store.activeDocumentId()).toBe(otherDocument.id);
    expect(store.documentActivity()).toEqual({ projectId: appProject.id });
    expect(store.documentActivity()).not.toBe(before);
  });

  it('reports a new activity when the learner selects the active document again', () => {
    const store = storeWithActiveDocument();
    const before = store.documentActivity();

    store.selectDocument(appDocument.id);
    TestBed.tick();

    expect(store.activeDocumentId()).toBe(appDocument.id);
    expect(store.documentActivity()).toEqual({ projectId: appProject.id });
    expect(store.documentActivity()).not.toBe(before);
  });

  it('reports nothing without a selected project', () => {
    const store = TestBed.inject(SourceImportStore);

    store.uploadDocuments();
    store.selectDocument(appDocument.id);
    TestBed.tick();

    expect(store.documentActivity()).toBeNull();
  });
});
