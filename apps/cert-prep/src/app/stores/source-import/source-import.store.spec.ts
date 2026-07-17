import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../cert-prep-api';
import type { ChunkRead, DocumentRead } from '../../cert-prep-api';
import { OperationStore } from '../operation.store';
import { ProjectStore } from '../project.store';
import { SourceImportStore } from './source-import.store';

describe('SourceImportStore polling', () => {
  const apiClient = {
    getDocument: vi.fn(),
    listDocumentChunks: vi.fn(),
    listDocuments: vi.fn(),
    uploadDocument: vi.fn(),
    cancelDocumentOperation: vi.fn(),
    cancelDocumentProcessing: vi.fn(),
    retryDocumentProcessing: vi.fn(),
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
    apiClient.cancelDocumentOperation.mockResolvedValue(
      documentOperation('canceled'),
    );
    apiClient.cancelDocumentProcessing.mockResolvedValue(
      documentOperation('cancel_requested'),
    );
    apiClient.retryDocumentProcessing.mockResolvedValue(
      documentOperation('running'),
    );

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

  it('retries polling with bounded backoff and exposes an actionable error', async () => {
    const store = TestBed.inject(SourceImportStore);
    apiClient.getDocument.mockRejectedValue(new Error('backend offline'));

    await store.refreshUploadedDocument('project-1', 'document-1');

    expect(store.pollingError()).toBeNull();
    expect(apiClient.getDocument).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);

    expect(apiClient.getDocument).toHaveBeenCalledTimes(4);
    expect(store.pollingError()).toContain('could not be refreshed');

    apiClient.getDocument.mockResolvedValue(documentRead());
    store.retryDocumentPolling();
    await flushPromises();

    expect(store.pollingError()).toBeNull();
    expect(apiClient.getDocument).toHaveBeenCalledTimes(5);
  });

  it('accepts source files by supported MIME type or filename extension', () => {
    const store = TestBed.inject(SourceImportStore);
    const operations = TestBed.inject(OperationStore);

    store.chooseFiles([
      pdfFile('guide.pdf'),
      sourceFile('mime-only.bin', 'image/png'),
      sourceFile('scan.JPG', 'application/octet-stream'),
      sourceFile('portrait.JPEG', ''),
      sourceFile('webp-by-mime.bin', 'image/webp'),
      sourceFile('diagram.WEBP', ''),
      sourceFile('animated.gif', 'image/gif'),
      sourceFile('vector.svg', 'image/svg+xml'),
    ]);

    expect(store.selectedFiles().map((file) => file.name)).toEqual([
      'guide.pdf',
      'mime-only.bin',
      'scan.JPG',
      'portrait.JPEG',
      'webp-by-mime.bin',
      'diagram.WEBP',
    ]);
    expect(store.selectedFileLabel()).toBe('6 files selected');
    expect(operations.error()).toContain('animated.gif');
    expect(operations.error()).toContain('vector.svg');
    expect(operations.error()).toContain('PDF, PNG, JPEG, and WebP');

    store.chooseFiles([sourceFile('next.png', 'image/png')]);

    expect(operations.error()).toBeNull();
    expect(operations.errorCode()).toBeNull();
  });

  it('uploads selected source files in two-document batches by default', async () => {
    const store = TestBed.inject(SourceImportStore);
    const firstUpload = deferred<DocumentRead>();
    const secondUpload = deferred<DocumentRead>();
    const thirdUpload = deferred<DocumentRead>();
    const uploads = new Map([
      ['first.pdf', firstUpload],
      ['second.png', secondUpload],
      ['third.webp', thirdUpload],
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
      sourceFile('second.png', 'image/png'),
      sourceFile('third.webp', 'image/webp'),
    ]);

    const uploadPromise = store.uploadDocuments();
    await Promise.resolve();

    expect(startedUploads).toEqual(['first.pdf', 'second.png']);
    firstUpload.resolve(documentRead({ id: 'document-1', filename: 'first.pdf' }));
    await flushPromises();

    expect(startedUploads).toEqual(['first.pdf', 'second.png']);
    secondUpload.resolve(documentRead({ id: 'document-2', filename: 'second.png' }));
    await flushPromises();

    expect(startedUploads).toEqual(['first.pdf', 'second.png', 'third.webp']);
    thirdUpload.resolve(documentRead({ id: 'document-3', filename: 'third.webp' }));
    await uploadPromise;

    expect(apiClient.uploadDocument).toHaveBeenCalledTimes(3);
    expect(store.uploadItems().map((item) => item.status)).toEqual([
      'uploaded',
      'uploaded',
      'uploaded',
    ]);
    expect(store.activeDocumentId()).toBe('document-3');
    expect(store.uploadedFileCount()).toBe(3);
    expect(TestBed.inject(OperationStore).status()).toBe(
      '3 source files uploaded',
    );
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

  it('keeps successful uploads when one source file fails', async () => {
    const store = TestBed.inject(SourceImportStore);
    const failed = new Error('Invalid source file');
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
    expect(TestBed.inject(OperationStore).error()).toBe(
      '1 source file failed to upload.',
    );
  });

  it('retries failed source files without uploading successful items again', async () => {
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
            error: { message: 'The source file could not be parsed.' },
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

  it('aborts an upload and persists its operation tombstone', async () => {
    const store = TestBed.inject(SourceImportStore);
    apiClient.uploadDocument.mockImplementation(
      (
        _projectId: string,
        _body: FormData,
        options: { signal?: AbortSignal },
      ) =>
        new Promise<DocumentRead>((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('canceled', 'AbortError')),
            { once: true },
          );
        }),
    );
    store.chooseFile(pdfFile('cancel-me.pdf'));
    const item = store.uploadItems()[0];
    if (item === undefined) {
      throw new Error('Expected the selected upload item.');
    }

    const uploadPromise = store.uploadDocuments();
    await Promise.resolve();
    await store.cancelUploadItem(item.id);
    await uploadPromise;

    expect(apiClient.cancelDocumentOperation).toHaveBeenCalledWith(
      'project-1',
      item.operationId,
    );
    expect(store.uploadItems()[0]?.status).toBe('canceled');
    const requestOptions = apiClient.uploadDocument.mock.calls[0]?.[2] as {
      headers?: Record<string, string>;
    };
    expect(requestOptions.headers?.['X-Cert-Prep-Operation-Id']).toBe(
      item.operationId,
    );
  });
});

function documentOperation(status: string) {
  return {
    id: 'operation-1',
    project_id: 'project-1',
    document_id: null,
    status,
    phase: status,
    cancellable: status === 'running',
    error: null,
    created_at: '2026-07-11T00:00:00Z',
    updated_at: '2026-07-11T00:00:00Z',
  };
}

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

function sourceFile(name: string, type: string): File {
  return new File(['source'], name, { type });
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
