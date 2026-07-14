import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../cert-prep-api';
import type { ChunkRead, DocumentRead } from '../../cert-prep-api';
import { ProjectStore } from '../project.store';
import { SourceImportStore } from './source-import.store';

describe('SourceImportStore polling', () => {
  const apiClient = {
    getDocument: vi.fn(),
    listDocumentChunks: vi.fn(),
    listDocuments: vi.fn(),
    uploadDocument: vi.fn(),
    health: vi.fn(),
    llmHealth: vi.fn(),
    ocrHealth: vi.fn(),
    runtimeRequirements: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [{ provide: CERT_PREP_API, useValue: apiClient }],
    });

    apiClient.getDocument.mockImplementation(
      (_projectId: string, documentId = 'document-1') =>
        Promise.resolve(documentRead({ id: documentId })),
    );
    apiClient.listDocumentChunks.mockResolvedValue({ items: [] });

    const projects = TestBed.inject(ProjectStore);
    projects.projects.set([
      {
        id: 'project-1',
        name: 'Runtime QA',
        description: '',
        created_at: '2026-06-18T00:00:00Z',
        updated_at: '2026-06-18T00:00:00Z',
      },
    ]);
    projects.select('project-1');
  });

  afterEach(() => {
    TestBed.inject(SourceImportStore).reset();
    vi.useRealTimers();
  });

  it('polls quickly until the first chunk is visible, then returns to the normal cadence', async () => {
    const store = TestBed.inject(SourceImportStore);
    apiClient.getDocument
      .mockResolvedValueOnce(
        documentRead({ status: 'processing', chunks_count: 1 }),
      )
      .mockResolvedValueOnce(
        documentRead({ status: 'processing', chunks_count: 1 }),
      )
      .mockResolvedValueOnce(
        documentRead({ status: 'processing', chunks_count: 1 }),
      );
    apiClient.listDocumentChunks
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [chunkRead()] })
      .mockResolvedValueOnce({ items: [chunkRead()] });

    await store.refreshUploadedDocument('project-1', 'document-1');

    expect(store.chunks()).toEqual([]);
    expect(apiClient.getDocument).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(499);
    expect(apiClient.getDocument).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(apiClient.getDocument).toHaveBeenCalledTimes(2);
    expect(store.chunks()).toEqual([chunkRead()]);

    await vi.advanceTimersByTimeAsync(1499);
    expect(apiClient.getDocument).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(apiClient.getDocument).toHaveBeenCalledTimes(3);
  });

  it('loads project documents and makes the latest document active explicitly', async () => {
    const store = TestBed.inject(SourceImportStore);
    const latestDocument = documentRead({ id: 'document-2', filename: 'latest.pdf' });
    apiClient.listDocuments.mockResolvedValue({
      items: [latestDocument, documentRead()],
    });
    apiClient.getDocument.mockResolvedValue(latestDocument);
    apiClient.listDocumentChunks.mockResolvedValue({
      items: [chunkRead({ document_id: latestDocument.id })],
    });

    await store.loadLatestDocument('project-1');

    expect(store.documents()).toEqual([latestDocument, documentRead()]);
    expect(store.activeDocumentId()).toBe(latestDocument.id);
    expect(store.uploadedDocument()).toEqual(latestDocument);
    expect(store.activeDocument()).toEqual(latestDocument);
    expect(store.chunks()).toEqual([chunkRead({ document_id: latestDocument.id })]);
  });

  it('ignores a stale project document list response', async () => {
    const store = TestBed.inject(SourceImportStore);
    const projects = TestBed.inject(ProjectStore);
    const projectOneDocuments = deferred<{ items: DocumentRead[] }>();
    apiClient.listDocuments.mockReturnValue(projectOneDocuments.promise);
    projects.projects.update((items) => [
      ...items,
      {
        id: 'project-2',
        name: 'Second project',
        description: '',
        created_at: '2026-06-18T00:00:00Z',
        updated_at: '2026-06-18T00:00:00Z',
      },
    ]);

    const loadPromise = store.loadLatestDocument('project-1');
    projects.select('project-2');
    projectOneDocuments.resolve({ items: [documentRead()] });
    await loadPromise;

    expect(store.documents()).toEqual([]);
    expect(store.activeDocument()).toBeNull();
  });

  it('keeps the newest same-project document list response', async () => {
    const store = TestBed.inject(SourceImportStore);
    const olderResponse = deferred<{ items: DocumentRead[] }>();
    const newerResponse = deferred<{ items: DocumentRead[] }>();
    const olderDocument = documentRead({ id: 'document-old' });
    const newerDocument = documentRead({ id: 'document-new' });
    apiClient.listDocuments
      .mockReturnValueOnce(olderResponse.promise)
      .mockReturnValueOnce(newerResponse.promise);
    apiClient.getDocument.mockResolvedValue(newerDocument);

    const olderLoad = store.loadLatestDocument('project-1');
    const newerLoad = store.loadLatestDocument('project-1');
    newerResponse.resolve({ items: [newerDocument] });
    await newerLoad;
    olderResponse.resolve({ items: [olderDocument] });
    await olderLoad;

    expect(store.documents()).toEqual([newerDocument]);
    expect(store.activeDocumentId()).toBe(newerDocument.id);
  });

  it('selects a project document and refreshes its status and chunks', async () => {
    const store = TestBed.inject(SourceImportStore);
    const firstDocument = documentRead({ id: 'document-1', filename: 'first.pdf' });
    const secondDocument = documentRead({ id: 'document-2', filename: 'second.pdf' });
    const refreshedSecondDocument = documentRead({
      id: secondDocument.id,
      filename: secondDocument.filename,
      chunks_count: 2,
    });
    store.documents.set([firstDocument, secondDocument]);
    store.setActiveDocumentId(firstDocument.id);
    apiClient.getDocument.mockResolvedValue(refreshedSecondDocument);
    apiClient.listDocumentChunks.mockResolvedValue({
      items: [chunkRead({ document_id: secondDocument.id })],
    });

    await store.selectDocument(secondDocument.id);

    expect(apiClient.getDocument).toHaveBeenCalledWith(
      'project-1',
      secondDocument.id,
    );
    expect(apiClient.listDocumentChunks).toHaveBeenCalledWith(
      'project-1',
      secondDocument.id,
    );
    expect(store.activeDocumentId()).toBe(secondDocument.id);
    expect(store.uploadedDocument()).toEqual(refreshedSecondDocument);
    expect(store.chunks()).toEqual([chunkRead({ document_id: secondDocument.id })]);
  });

  it('does not apply a stale document refresh after the project changes', async () => {
    const store = TestBed.inject(SourceImportStore);
    const projects = TestBed.inject(ProjectStore);
    const documentResponse = deferred<DocumentRead>();
    const chunksResponse = deferred<{ items: ChunkRead[] }>();
    projects.projects.update((items) => [
      ...items,
      {
        id: 'project-2',
        name: 'Second project',
        description: '',
        created_at: '2026-06-18T00:00:00Z',
        updated_at: '2026-06-18T00:00:00Z',
      },
    ]);
    apiClient.getDocument.mockReturnValue(documentResponse.promise);
    apiClient.listDocumentChunks.mockReturnValue(chunksResponse.promise);

    const refreshPromise = store.refreshUploadedDocument(
      'project-1',
      'document-1',
    );
    projects.select('project-2');
    documentResponse.resolve(documentRead({ filename: 'stale.pdf' }));
    chunksResponse.resolve({ items: [chunkRead()] });
    await refreshPromise;

    expect(store.documents()).toEqual([]);
    expect(store.uploadedDocument()).toBeNull();
    expect(store.chunks()).toEqual([]);
  });

  it('does not let an older same-document refresh replace terminal state', async () => {
    const store = TestBed.inject(SourceImportStore);
    const olderDocument = deferred<DocumentRead>();
    const newerDocument = deferred<DocumentRead>();
    const olderChunks = deferred<{ items: ChunkRead[] }>();
    const newerChunks = deferred<{ items: ChunkRead[] }>();
    apiClient.getDocument
      .mockReturnValueOnce(olderDocument.promise)
      .mockReturnValueOnce(newerDocument.promise);
    apiClient.listDocumentChunks
      .mockReturnValueOnce(olderChunks.promise)
      .mockReturnValueOnce(newerChunks.promise);

    const olderRefresh = store.refreshUploadedDocument(
      'project-1',
      'document-1',
    );
    const newerRefresh = store.refreshUploadedDocument(
      'project-1',
      'document-1',
    );
    newerDocument.resolve(documentRead({ status: 'canceled' }));
    newerChunks.resolve({ items: [] });
    await newerRefresh;
    olderDocument.resolve(documentRead({ status: 'cancel_requested' }));
    olderChunks.resolve({ items: [] });
    await olderRefresh;

    expect(store.activeDocument()?.status).toBe('canceled');
    await vi.advanceTimersByTimeAsync(5000);
    expect(apiClient.getDocument).toHaveBeenCalledTimes(2);
  });

  it('does not let an older refresh failure clear a newer polling timer', async () => {
    const store = TestBed.inject(SourceImportStore);
    const olderDocument = deferred<DocumentRead>();
    apiClient.getDocument
      .mockReturnValueOnce(olderDocument.promise)
      .mockResolvedValueOnce(documentRead({ status: 'processing' }))
      .mockResolvedValueOnce(documentRead({ status: 'ready' }));
    apiClient.listDocumentChunks.mockResolvedValue({ items: [] });

    const olderRefresh = store.refreshUploadedDocument(
      'project-1',
      'document-1',
    );
    await store.refreshUploadedDocument('project-1', 'document-1');
    olderDocument.reject(new Error('stale request failed'));
    await olderRefresh;

    await vi.advanceTimersByTimeAsync(500);
    expect(apiClient.getDocument).toHaveBeenCalledTimes(3);
    expect(store.activeDocument()?.status).toBe('ready');
  });

  it('polls cancel_requested documents until canceled and then stops', async () => {
    const store = TestBed.inject(SourceImportStore);
    apiClient.getDocument
      .mockResolvedValueOnce(documentRead({ status: 'cancel_requested' }))
      .mockResolvedValueOnce(documentRead({ status: 'canceled' }));
    apiClient.listDocumentChunks.mockResolvedValue({ items: [] });

    await store.refreshUploadedDocument('project-1', 'document-1');
    await vi.advanceTimersByTimeAsync(1500);

    expect(store.activeDocument()?.status).toBe('canceled');
    expect(apiClient.getDocument).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5000);
    expect(apiClient.getDocument).toHaveBeenCalledTimes(2);
  });

  it('uploads selected PDFs in two-document batches by default', async () => {
    const store = TestBed.inject(SourceImportStore);
    const firstUpload = deferred<DocumentRead>();
    const secondUpload = deferred<DocumentRead>();
    const thirdUpload = deferred<DocumentRead>();
    const uploads = new Map([
      ['first.pdf', firstUpload],
      ['second.pdf', secondUpload],
      ['third.pdf', thirdUpload],
    ]);
    const startedUploads: string[] = [];
    apiClient.uploadDocument.mockImplementation((_projectId: string, body: FormData) => {
      const file = body.get('file') as File;
      startedUploads.push(file.name);
      return uploads.get(file.name)?.promise;
    });
    apiClient.getDocument.mockImplementation((_projectId: string, documentId: string) =>
      Promise.resolve(documentRead({ id: documentId })),
    );
    store.chooseFiles([
      pdfFile('first.pdf'),
      pdfFile('second.pdf'),
      pdfFile('third.pdf'),
    ]);

    const uploadPromise = store.uploadDocuments();
    await Promise.resolve();

    expect(startedUploads).toEqual(['first.pdf', 'second.pdf']);
    firstUpload.resolve(documentRead({ id: 'document-1', filename: 'first.pdf' }));
    await flushPromises();

    expect(startedUploads).toEqual(['first.pdf', 'second.pdf']);
    secondUpload.resolve(documentRead({ id: 'document-2', filename: 'second.pdf' }));
    await flushPromises();

    expect(startedUploads).toEqual(['first.pdf', 'second.pdf', 'third.pdf']);
    thirdUpload.resolve(documentRead({ id: 'document-3', filename: 'third.pdf' }));
    await uploadPromise;

    expect(apiClient.uploadDocument).toHaveBeenCalledTimes(3);
    expect(store.uploadItems().map((item) => item.status)).toEqual([
      'uploaded',
      'uploaded',
      'uploaded',
    ]);
    expect(store.activeDocumentId()).toBe('document-3');
    expect(
      store.uploadItems().filter((item) => item.status === 'uploaded'),
    ).toHaveLength(3);
  });

  it('uses the configured upload batch size for the whole upload run', async () => {
    const store = TestBed.inject(SourceImportStore);
    store.setUploadBatchSize(3);
    const uploads = new Map(
      ['first.pdf', 'second.pdf', 'third.pdf', 'fourth.pdf'].map((name) => [
        name,
        deferred<DocumentRead>(),
      ]),
    );
    const startedUploads: string[] = [];
    apiClient.uploadDocument.mockImplementation((_projectId: string, body: FormData) => {
      const file = body.get('file') as File;
      startedUploads.push(file.name);
      return uploads.get(file.name)?.promise;
    });
    store.chooseFiles([
      pdfFile('first.pdf'),
      pdfFile('second.pdf'),
      pdfFile('third.pdf'),
      pdfFile('fourth.pdf'),
    ]);

    const uploadPromise = store.uploadDocuments();
    await Promise.resolve();

    expect(startedUploads).toEqual(['first.pdf', 'second.pdf', 'third.pdf']);
    store.setUploadBatchSize(1);
    uploads.get('first.pdf')?.resolve(
      documentRead({ id: 'document-1', filename: 'first.pdf' }),
    );
    uploads.get('second.pdf')?.resolve(
      documentRead({ id: 'document-2', filename: 'second.pdf' }),
    );
    uploads.get('third.pdf')?.resolve(
      documentRead({ id: 'document-3', filename: 'third.pdf' }),
    );
    await flushPromises();

    expect(startedUploads).toEqual([
      'first.pdf',
      'second.pdf',
      'third.pdf',
      'fourth.pdf',
    ]);
    uploads.get('fourth.pdf')?.resolve(
      documentRead({ id: 'document-4', filename: 'fourth.pdf' }),
    );
    await uploadPromise;

    expect(store.activeDocumentId()).toBe('document-4');
  });

  it('clamps upload batch size to the supported range', () => {
    const store = TestBed.inject(SourceImportStore);

    store.setUploadBatchSize(99);
    expect(store.uploadBatchSize()).toBe(4);

    store.setUploadBatchSize(0);
    expect(store.uploadBatchSize()).toBe(1);

    store.setUploadBatchSize('not-a-number');
    expect(store.uploadBatchSize()).toBe(2);
  });

  it('ignores reentrant upload calls while a document batch is in progress', async () => {
    const store = TestBed.inject(SourceImportStore);
    const firstUpload = deferred<DocumentRead>();
    const secondUpload = deferred<DocumentRead>();
    const uploads = new Map([
      ['first.pdf', firstUpload],
      ['second.pdf', secondUpload],
    ]);
    const startedUploads: string[] = [];
    apiClient.uploadDocument.mockImplementation((_projectId: string, body: FormData) => {
      const file = body.get('file') as File;
      startedUploads.push(file.name);
      return uploads.get(file.name)?.promise;
    });
    store.chooseFiles([pdfFile('first.pdf'), pdfFile('second.pdf')]);

    const uploadPromise = store.uploadDocuments();
    await Promise.resolve();

    const reentrantResult = await store.uploadDocuments();

    expect(reentrantResult).toEqual([]);
    expect(startedUploads).toEqual(['first.pdf', 'second.pdf']);

    firstUpload.resolve(documentRead({ id: 'document-1', filename: 'first.pdf' }));
    await flushPromises();
    expect(startedUploads).toEqual(['first.pdf', 'second.pdf']);

    secondUpload.resolve(documentRead({ id: 'document-2', filename: 'second.pdf' }));
    await uploadPromise;

    expect(apiClient.uploadDocument).toHaveBeenCalledTimes(2);
    expect(store.uploadItems().map((item) => item.status)).toEqual([
      'uploaded',
      'uploaded',
    ]);
  });

  it('keeps successful uploads when one PDF fails', async () => {
    const store = TestBed.inject(SourceImportStore);
    const failed = new Error('Invalid PDF');
    apiClient.uploadDocument.mockImplementation(
      (_projectId: string, body: FormData) => {
        const file = body.get('file') as File;
        if (file.name === 'bad.pdf') {
          return Promise.reject(failed);
        }
        return Promise.resolve(
          documentRead({ id: 'document-good', filename: file.name }),
        );
      },
    );
    apiClient.getDocument.mockResolvedValue(
      documentRead({ id: 'document-good', filename: 'good.pdf' }),
    );
    store.chooseFiles([pdfFile('bad.pdf'), pdfFile('good.pdf')]);

    const documents = await store.uploadDocuments();

    expect(documents).toEqual([
      expect.objectContaining({ id: 'document-good', filename: 'good.pdf' }),
    ]);
    expect(store.uploadItems()).toEqual([
      expect.objectContaining({ file: expect.any(File), status: 'failed' }),
      expect.objectContaining({
        file: expect.any(File),
        status: 'uploaded',
        document: expect.objectContaining({ id: 'document-good' }),
      }),
    ]);
    expect(store.failedUploadCount()).toBe(1);
    expect(store.documents()[0]).toEqual(
      expect.objectContaining({ id: 'document-good' }),
    );
  });

  it('retries failed PDFs without uploading successful items again', async () => {
    const store = TestBed.inject(SourceImportStore);
    const uploadedNames: string[] = [];
    let badUploadAttempts = 0;
    apiClient.uploadDocument.mockImplementation(
      (_projectId: string, body: FormData) => {
        const file = body.get('file') as File;
        uploadedNames.push(file.name);
        if (file.name === 'bad.pdf') {
          badUploadAttempts += 1;
        }
        if (file.name === 'bad.pdf' && badUploadAttempts === 1) {
          return Promise.reject({
            error: { message: 'The PDF could not be parsed.' },
          });
        }
        return Promise.resolve(
          documentRead({
            id: `document-${file.name}`,
            filename: file.name,
          }),
        );
      },
    );
    store.chooseFiles([pdfFile('good.pdf'), pdfFile('bad.pdf')]);

    await store.uploadDocuments();

    expect(store.uploadItems().map((item) => item.status)).toEqual([
      'uploaded',
      'failed',
    ]);
    expect(store.canUpload()).toBe(true);

    uploadedNames.length = 0;
    await store.uploadDocuments();

    expect(uploadedNames).toEqual(['bad.pdf']);
    expect(store.uploadItems().map((item) => item.status)).toEqual([
      'uploaded',
      'uploaded',
    ]);
    expect(store.failedUploadCount()).toBe(0);
    expect(store.activeDocumentId()).toBe('document-bad.pdf');
  });
});

function documentRead(overrides: Partial<DocumentRead> = {}): DocumentRead {
  return {
    id: 'document-1',
    project_id: 'project-1',
    filename: 'runtime.pdf',
    sha256: 'document-sha',
    language_hint: 'en',
    page_count: 8,
    has_text: true,
    status: 'ready',
    extraction_method: 'paddle_ocr_gpu',
    ocr_device: 'gpu:0',
    ocr_fallback_reason: null,
    ocr_duration_ms: 222,
    processed_page_count: 8,
    parse_wall_duration_ms: 0,
    render_duration_ms: 0,
    ocr_engine_duration_ms: 222,
    ocr_worker_count: 1,
    first_chunk_ms: 0,
    exam_item_count: 0,
    content_profile: 'unknown',
    classification_detail: '',
    chunks_count: 8,
    created_at: '2026-06-18T00:00:00Z',
    updated_at: '2026-06-18T00:00:01Z',
    ...overrides,
  };
}

function chunkRead(overrides: Partial<ChunkRead> = {}): ChunkRead {
  return {
    id: 'chunk-1',
    document_id: 'document-1',
    page_number: 1,
    chunk_index: 0,
    text: 'Visible OCR text.',
    raw_text: 'Visible OCR text.',
    line_start: null,
    line_end: null,
    line_count: 1,
    source_excerpt: 'Visible OCR text.',
    extraction_method: 'paddle_ocr_gpu',
    content_profile: 'unknown',
    created_at: '2026-06-18T00:00:00Z',
    ...overrides,
  };
}

function pdfFile(name: string): File {
  return new File(['%PDF-1.7'], name, { type: 'application/pdf' });
}

async function flushPromises(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolver, rejecter) => {
    resolve = resolver;
    reject = rejecter;
  });
  return { promise, resolve, reject };
}
