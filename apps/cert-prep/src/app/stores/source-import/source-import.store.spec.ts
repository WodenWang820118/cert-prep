import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../cert-prep-api';
import type {
  ChunkRead,
  DocumentOperationRead,
  DocumentRead,
} from '../../cert-prep-api';
import { OperationStore } from '../operation.store';
import { ProjectStore } from '../project.store';
import { SourceImportStore } from './source-import.store';

describe('SourceImportStore polling', () => {
  const apiClient = {
    getDocument: vi.fn(),
    listDocumentChunks: vi.fn(),
    listDocuments: vi.fn(),
    uploadDocument: vi.fn(),
    retryDocumentProcessing: vi.fn(),
    getDocumentOperation: vi.fn(),
    cancelDocumentOperation: vi.fn(),
    health: vi.fn(),
    llmHealth: vi.fn(),
    ocrHealth: vi.fn(),
    runtimeRequirements: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    TestBed.configureTestingModule({
      providers: [{ provide: CERT_PREP_API, useValue: apiClient }],
    });

    apiClient.getDocument.mockImplementation(
      (_projectId: string, documentId = 'document-1') =>
        Promise.resolve(documentRead({ id: documentId })),
    );
    apiClient.listDocumentChunks.mockResolvedValue({ items: [] });
    apiClient.cancelDocumentOperation.mockImplementation(
      (projectId: string, operationId: string) =>
        Promise.resolve(
          operationRead({
            id: operationId,
            project_id: projectId,
            status: 'canceled',
            phase: 'canceled',
            cancellable: false,
          }),
        ),
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
    vi.restoreAllMocks();
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
    const operations = TestBed.inject(OperationStore);
    const firstUpload = deferred<DocumentRead>();
    const secondUpload = deferred<DocumentRead>();
    const thirdUpload = deferred<DocumentRead>();
    const uploads = new Map([
      ['first.pdf', firstUpload],
      ['second.pdf', secondUpload],
      ['third.pdf', thirdUpload],
    ]);
    const thirdStarted = deferred<void>();
    const startedUploads: string[] = [];
    apiClient.uploadDocument.mockImplementation((_projectId: string, body: FormData) => {
      const file = body.get('file') as File;
      startedUploads.push(file.name);
      if (file.name === 'third.pdf') {
        thirdStarted.resolve();
      }
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
    expect(operations.isBusyFor('upload')).toBe(true);
    firstUpload.resolve(documentRead({ id: 'document-1', filename: 'first.pdf' }));
    await thirdStarted.promise;

    expect(startedUploads).toEqual([
      'first.pdf',
      'second.pdf',
      'third.pdf',
    ]);
    expect(operations.isBusyFor('upload')).toBe(true);
    secondUpload.resolve(documentRead({ id: 'document-2', filename: 'second.pdf' }));

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
    expect(operations.isBusyFor('upload')).toBe(false);
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
    const fourthStarted = deferred<void>();
    const startedUploads: string[] = [];
    apiClient.uploadDocument.mockImplementation((_projectId: string, body: FormData) => {
      const file = body.get('file') as File;
      startedUploads.push(file.name);
      if (file.name === 'fourth.pdf') {
        fourthStarted.resolve();
      }
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
    await fourthStarted.promise;

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
    const failed = { status: 400, message: 'Invalid PDF' };
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
    expect(TestBed.inject(OperationStore).status()).toBe(
      '1 PDF upload accepted; 1 did not complete',
    );
  });

  it('retries failed PDFs without uploading successful items again', async () => {
    const firstOperationId = fixedOperationId(5);
    const failedOperationId = fixedOperationId(8);
    const retryOperationId = fixedOperationId(6);
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce(firstOperationId)
      .mockReturnValueOnce(failedOperationId)
      .mockReturnValueOnce(retryOperationId);
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
            status: 422,
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
    expect(store.canUpload()).toBe(false);

    uploadedNames.length = 0;
    const failedItem = store.uploadItems().find((item) => item.status === 'failed');
    expect(failedItem).toBeDefined();
    await store.retryUpload(failedItem?.id ?? 'missing');

    expect(uploadedNames).toEqual(['bad.pdf']);
    expect(store.uploadItems().map((item) => item.status)).toEqual([
      'uploaded',
      'uploaded',
    ]);
    expect(store.failedUploadCount()).toBe(0);
    expect(store.activeDocumentId()).toBe('document-bad.pdf');
    expect(apiClient.uploadDocument.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        headers: { 'X-Cert-Prep-Operation-Id': firstOperationId },
      }),
    );
    expect(apiClient.uploadDocument.mock.calls[2]?.[2]).toEqual(
      expect.objectContaining({
        headers: { 'X-Cert-Prep-Operation-Id': retryOperationId },
      }),
    );
  });

  it('cancels a queued PDF locally without claiming an operation id', async () => {
    const store = TestBed.inject(SourceImportStore);
    store.chooseFiles([pdfFile('queued.pdf')]);

    await store.cancelUpload(store.uploadItems()[0]?.id ?? 'missing');

    expect(store.uploadItems()[0]?.status).toBe('canceled');
    expect(apiClient.uploadDocument).not.toHaveBeenCalled();
    expect(apiClient.cancelDocumentOperation).not.toHaveBeenCalled();
  });

  it('releases normal processing handoffs without retaining upload cancel ownership', async () => {
    const store = TestBed.inject(SourceImportStore);
    apiClient.uploadDocument.mockImplementation(
      (_projectId: string, body: FormData) => {
        const file = body.get('file') as File;
        return Promise.resolve(
          documentRead({
            id: `document-${file.name}`,
            filename: file.name,
            status: 'processing',
            has_text: false,
            chunks_count: 0,
          }),
        );
      },
    );
    store.chooseFiles([pdfFile('first.pdf'), pdfFile('second.pdf')]);

    await store.uploadDocuments();

    expect(store.uploadItems().map((item) => item.status)).toEqual([
      'uploaded',
      'uploaded',
    ]);
    expect(
      store.uploadItems().map((item) => store.canCancelUpload(item)),
    ).toEqual([false, false]);
    store.reset();
    expect(apiClient.cancelDocumentOperation).not.toHaveBeenCalled();
  });

  it('starts the next queued PDF after one sibling is canceled', async () => {
    const operationIds = [
      fixedOperationId(12),
      fixedOperationId(13),
      fixedOperationId(14),
    ];
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce(operationIds[0])
      .mockReturnValueOnce(operationIds[1])
      .mockReturnValueOnce(operationIds[2]);
    const store = TestBed.inject(SourceImportStore);
    const uploads = new Map(
      ['first.pdf', 'second.pdf', 'third.pdf'].map((name) => [
        name,
        deferred<DocumentRead>(),
      ]),
    );
    const started: string[] = [];
    const signals = new Map<string, AbortSignal>();
    const thirdStarted = deferred<void>();
    apiClient.uploadDocument.mockImplementation(
      (
        _projectId: string,
        body: FormData,
        options?: { signal?: AbortSignal },
      ) => {
        const file = body.get('file') as File;
        started.push(file.name);
        if (options?.signal !== undefined) {
          signals.set(file.name, options.signal);
        }
        if (file.name === 'third.pdf') {
          thirdStarted.resolve();
        }
        return uploads.get(file.name)?.promise;
      },
    );
    store.chooseFiles([
      pdfFile('first.pdf'),
      pdfFile('second.pdf'),
      pdfFile('third.pdf'),
    ]);

    const uploadPromise = store.uploadDocuments();
    expect(started).toEqual(['first.pdf', 'second.pdf']);
    await store.cancelUpload(store.uploadItems()[0]?.id ?? 'missing');
    await thirdStarted.promise;

    expect(signals.get('first.pdf')?.aborted).toBe(true);
    expect(signals.get('second.pdf')?.aborted).toBe(false);
    expect(started).toEqual(['first.pdf', 'second.pdf', 'third.pdf']);
    uploads.get('second.pdf')?.resolve(
      documentRead({ id: 'document-second', filename: 'second.pdf' }),
    );
    uploads.get('third.pdf')?.resolve(
      documentRead({ id: 'document-third', filename: 'third.pdf' }),
    );
    await uploadPromise;

    expect(store.uploadItems().map((item) => item.status)).toEqual([
      'canceled',
      'uploaded',
      'uploaded',
    ]);
  });

  it('uses the exact private operation id to cancel an in-flight POST', async () => {
    const operationId = fixedOperationId(1);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(operationId);
    const store = TestBed.inject(SourceImportStore);
    const uploadStarted = deferred<void>();
    const canceled = deferred<DocumentOperationRead>();
    apiClient.uploadDocument.mockImplementation(
      (
        _projectId: string,
        _body: FormData,
        options?: { signal?: AbortSignal },
      ) =>
        new Promise<DocumentRead>((_resolve, reject) => {
          uploadStarted.resolve();
          options?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Upload canceled.', 'AbortError'));
          });
        }),
    );
    apiClient.cancelDocumentOperation.mockReturnValue(canceled.promise);
    store.chooseFiles([pdfFile('in-flight.pdf')]);

    const uploadPromise = store.uploadDocuments();
    await uploadStarted.promise;

    const options = apiClient.uploadDocument.mock.calls[0]?.[2] as
      | { headers?: Record<string, string>; signal?: AbortSignal }
      | undefined;
    expect(options?.headers).toEqual({
      'X-Cert-Prep-Operation-Id': operationId,
    });
    expect(store.uploadItems()[0]).not.toHaveProperty('operationId');

    await store.cancelUpload(store.uploadItems()[0]?.id ?? 'missing');

    expect(apiClient.cancelDocumentOperation).toHaveBeenCalledWith(
      'project-1',
      operationId,
    );
    expect(options?.signal?.aborted).toBe(true);
    expect(store.uploadItems()[0]?.status).toBe('cancel_requested');
    canceled.resolve(
      operationRead({
        id: operationId,
        status: 'canceled',
        phase: 'canceled',
        cancellable: false,
      }),
    );
    const documents = await uploadPromise;

    expect(store.uploadItems()[0]?.status).toBe('canceled');
    expect(documents).toEqual([]);
    const operations = TestBed.inject(OperationStore);
    expect(operations.isBusyFor('upload')).toBe(false);
    expect(operations.status()).toBe('PDF upload canceled');
  });

  it('keeps publish-wins when completion beats an in-flight cancellation', async () => {
    const operationId = fixedOperationId(2);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(operationId);
    const store = TestBed.inject(SourceImportStore);
    const upload = deferred<DocumentRead>();
    const cancel = deferred<DocumentOperationRead>();
    const published = documentRead({
      id: 'document-published',
      status: 'ready',
    });
    apiClient.uploadDocument.mockReturnValue(upload.promise);
    apiClient.cancelDocumentOperation.mockReturnValue(cancel.promise);
    apiClient.getDocument.mockResolvedValue(published);
    store.chooseFiles([pdfFile('published.pdf')]);

    const uploadPromise = store.uploadDocuments();
    await store.cancelUpload(store.uploadItems()[0]?.id ?? 'missing');
    cancel.resolve(
      operationRead({
        id: operationId,
        document_id: published.id,
        status: 'succeeded',
        phase: 'completed',
        cancellable: false,
      }),
    );

    await uploadPromise;
    upload.resolve(published);
    await Promise.resolve();

    expect(store.uploadItems()[0]).toEqual(
      expect.objectContaining({
        status: 'uploaded',
        document: expect.objectContaining({ id: published.id }),
      }),
    );
    expect(store.activeDocumentId()).toBe(published.id);
    const publishedItem = store.uploadItems()[0];
    expect(publishedItem).toBeDefined();
    expect(
      publishedItem === undefined
        ? undefined
        : store.canCancelUpload(publishedItem),
    ).toBe(false);
  });

  it('keeps cancel_requested with an attached document until cancellation is terminal', async () => {
    const operationId = fixedOperationId(10);
    const retryOperationId = fixedOperationId(11);
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce(operationId)
      .mockReturnValueOnce(retryOperationId);
    const store = TestBed.inject(SourceImportStore);
    const upload = deferred<DocumentRead>();
    const cancellation = deferred<DocumentOperationRead>();
    const cancelRequestedDocument = documentRead({
      status: 'cancel_requested',
      has_text: false,
      chunks_count: 0,
    });
    const canceledDocument = documentRead({
      status: 'canceled',
      has_text: false,
      chunks_count: 0,
    });
    const retryingDocument = documentRead({
      status: 'processing',
      has_text: false,
      chunks_count: 0,
    });
    apiClient.uploadDocument.mockReturnValue(upload.promise);
    apiClient.cancelDocumentOperation.mockReturnValue(cancellation.promise);
    apiClient.getDocument
      .mockResolvedValueOnce(cancelRequestedDocument)
      .mockResolvedValueOnce(canceledDocument)
      .mockResolvedValueOnce(retryingDocument);
    apiClient.getDocumentOperation.mockResolvedValue(
      operationRead({
        id: operationId,
        document_id: canceledDocument.id,
        status: 'canceled',
        phase: 'canceled',
        cancellable: false,
      }),
    );
    store.chooseFiles([pdfFile('cancel-processing.pdf')]);

    const uploadPromise = store.uploadDocuments();
    await store.cancelUpload(store.uploadItems()[0]?.id ?? 'missing');
    cancellation.resolve(
      operationRead({
        id: operationId,
        document_id: cancelRequestedDocument.id,
        status: 'cancel_requested',
        phase: 'canceling',
        cancellable: false,
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(store.uploadItems()[0]?.status).toBe('cancel_requested');
    await vi.advanceTimersByTimeAsync(1000);
    await uploadPromise;
    expect(store.uploadItems()[0]).toEqual(
      expect.objectContaining({
        status: 'canceled',
        document: expect.objectContaining({ status: 'canceled' }),
      }),
    );

    apiClient.retryDocumentProcessing.mockResolvedValue(
      operationRead({
        id: retryOperationId,
        document_id: canceledDocument.id,
      }),
    );
    await store.retryUpload(store.uploadItems()[0]?.id ?? 'missing');

    expect(apiClient.retryDocumentProcessing).toHaveBeenCalledWith(
      'project-1',
      canceledDocument.id,
      expect.objectContaining({
        headers: { 'X-Cert-Prep-Operation-Id': retryOperationId },
      }),
    );
    expect(store.uploadItems()[0]?.status).toBe('uploaded');
    upload.resolve(cancelRequestedDocument);
  });

  it('retries a cancellation tombstone after ambiguous DELETE and GET 404', async () => {
    const operationId = fixedOperationId(3);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(operationId);
    const store = TestBed.inject(SourceImportStore);
    apiClient.uploadDocument.mockReturnValue(deferred<DocumentRead>().promise);
    apiClient.cancelDocumentOperation
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(
        operationRead({
          id: operationId,
          status: 'canceled',
          phase: 'canceled',
          cancellable: false,
        }),
      );
    apiClient.getDocumentOperation.mockRejectedValue({ status: 404 });
    store.chooseFiles([pdfFile('ambiguous.pdf')]);

    const uploadPromise = store.uploadDocuments();
    await store.cancelUpload(store.uploadItems()[0]?.id ?? 'missing');
    await vi.advanceTimersByTimeAsync(1000);
    await uploadPromise;

    expect(apiClient.getDocumentOperation).toHaveBeenCalledWith(
      'project-1',
      operationId,
    );
    expect(apiClient.cancelDocumentOperation).toHaveBeenCalledTimes(2);
    expect(apiClient.cancelDocumentOperation).toHaveBeenNthCalledWith(
      2,
      'project-1',
      operationId,
    );
    expect(store.uploadItems()[0]?.status).toBe('canceled');
  });

  it('tombstones and ignores a stale upload result after reset', async () => {
    const operationId = fixedOperationId(4);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(operationId);
    const store = TestBed.inject(SourceImportStore);
    const upload = deferred<DocumentRead>();
    apiClient.uploadDocument.mockReturnValue(upload.promise);
    store.chooseFiles([pdfFile('stale.pdf')]);

    const uploadPromise = store.uploadDocuments();
    const signal = (
      apiClient.uploadDocument.mock.calls[0]?.[2] as
        | { signal?: AbortSignal }
        | undefined
    )?.signal;
    store.reset();
    upload.resolve(documentRead({ id: 'stale-document' }));
    await uploadPromise;

    expect(signal?.aborted).toBe(true);
    expect(apiClient.cancelDocumentOperation).toHaveBeenCalledWith(
      'project-1',
      operationId,
    );
    expect(store.uploadItems()).toEqual([]);
    expect(store.documents()).toEqual([]);
  });

  it('handles the original cancel rejection when reset detaches the operation', async () => {
    const operationId = fixedOperationId(22);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(operationId);
    const store = TestBed.inject(SourceImportStore);
    const originalDelete = deferred<DocumentOperationRead>();
    apiClient.uploadDocument.mockImplementation(
      (
        _projectId: string,
        _body: FormData,
        options?: { signal?: AbortSignal },
      ) =>
        new Promise<DocumentRead>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Canceled.', 'AbortError'));
          });
        }),
    );
    apiClient.cancelDocumentOperation
      .mockReturnValueOnce(originalDelete.promise)
      .mockResolvedValueOnce(
        operationRead({
          id: operationId,
          status: 'canceled',
          phase: 'canceled',
          cancellable: false,
        }),
      );
    store.chooseFiles([pdfFile('cancel-reset.pdf')]);

    const uploadPromise = store.uploadDocuments();
    void store.cancelUpload(store.uploadItems()[0]?.id ?? 'missing');
    store.reset();
    originalDelete.reject(new Error('original DELETE disconnected'));
    await uploadPromise;
    await vi.advanceTimersByTimeAsync(0);

    expect(apiClient.cancelDocumentOperation).toHaveBeenCalledTimes(2);
    expect(apiClient.cancelDocumentOperation).toHaveBeenNthCalledWith(
      2,
      'project-1',
      operationId,
    );
    expect(store.uploadItems()).toEqual([]);
  });

  it('returns no stale partial successes when reset invalidates an upload run', async () => {
    const store = TestBed.inject(SourceImportStore);
    const firstUpload = deferred<DocumentRead>();
    apiClient.uploadDocument.mockImplementation(
      (
        _projectId: string,
        body: FormData,
        options?: { signal?: AbortSignal },
      ) => {
        const file = body.get('file') as File;
        if (file.name === 'accepted-before-reset.pdf') {
          return firstUpload.promise;
        }
        return new Promise<DocumentRead>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Context changed.', 'AbortError'));
          });
        });
      },
    );
    store.chooseFiles([
      pdfFile('accepted-before-reset.pdf'),
      pdfFile('pending-at-reset.pdf'),
    ]);

    const uploadPromise = store.uploadDocuments();
    firstUpload.resolve(
      documentRead({
        id: 'document-before-reset',
        filename: 'accepted-before-reset.pdf',
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(store.uploadItems()[0]?.status).toBe('uploaded');

    store.reset();
    const documents = await uploadPromise;

    expect(documents).toEqual([]);
    expect(store.documents()).toEqual([]);
    expect(TestBed.inject(OperationStore).status()).toBe('Ready');
  });

  it('continues detached tombstone reconciliation after reset transport failures', async () => {
    const operationId = fixedOperationId(15);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(operationId);
    const store = TestBed.inject(SourceImportStore);
    apiClient.uploadDocument.mockImplementation(
      (
        _projectId: string,
        _body: FormData,
        options?: { signal?: AbortSignal },
      ) =>
        new Promise<DocumentRead>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Context changed.', 'AbortError'));
          });
        }),
    );
    apiClient.cancelDocumentOperation
      .mockRejectedValueOnce(new Error('delete unavailable 1'))
      .mockRejectedValueOnce(new Error('delete unavailable 2'))
      .mockRejectedValueOnce(new Error('delete unavailable 3'))
      .mockResolvedValue(
        operationRead({
          id: operationId,
          status: 'canceled',
          phase: 'canceled',
          cancellable: false,
        }),
      );
    apiClient.getDocumentOperation.mockRejectedValue(
      new Error('get unavailable'),
    );
    store.chooseFiles([pdfFile('detached.pdf')]);

    const uploadPromise = store.uploadDocuments();
    store.reset();
    await uploadPromise;
    await vi.advanceTimersByTimeAsync(0);

    expect(apiClient.cancelDocumentOperation).toHaveBeenCalledTimes(1);
    expect(apiClient.getDocumentOperation).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(apiClient.cancelDocumentOperation).toHaveBeenCalledTimes(3);
    expect(apiClient.getDocumentOperation).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(4000);
    expect(apiClient.cancelDocumentOperation).toHaveBeenCalledTimes(4);
    expect(apiClient.cancelDocumentOperation).toHaveBeenLastCalledWith(
      'project-1',
      operationId,
    );

    await vi.advanceTimersByTimeAsync(8000);
    expect(apiClient.cancelDocumentOperation).toHaveBeenCalledTimes(4);
  });

  it('rejects a foreign operation snapshot and re-queries the expected id', async () => {
    const operationId = fixedOperationId(16);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(operationId);
    const store = TestBed.inject(SourceImportStore);
    apiClient.uploadDocument.mockRejectedValue(new Error('connection lost'));
    apiClient.getDocumentOperation
      .mockResolvedValueOnce(
        operationRead({
          id: fixedOperationId(17),
          document_id: 'foreign-document',
          status: 'succeeded',
          phase: 'completed',
          cancellable: false,
        }),
      )
      .mockResolvedValueOnce(
        operationRead({
          id: operationId,
          document_id: 'expected-document',
          status: 'succeeded',
          phase: 'completed',
          cancellable: false,
        }),
      );
    apiClient.getDocument.mockResolvedValue(
      documentRead({ id: 'expected-document' }),
    );
    store.chooseFiles([pdfFile('foreign-snapshot.pdf')]);

    const uploadPromise = store.uploadDocuments();
    await vi.advanceTimersByTimeAsync(0);
    expect(apiClient.getDocumentOperation).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    const documents = await uploadPromise;

    expect(apiClient.getDocumentOperation).toHaveBeenNthCalledWith(
      2,
      'project-1',
      operationId,
    );
    expect(apiClient.getDocument).toHaveBeenCalledTimes(1);
    expect(apiClient.getDocument).toHaveBeenCalledWith(
      'project-1',
      'expected-document',
    );
    expect(documents).toEqual([
      expect.objectContaining({ id: 'expected-document' }),
    ]);
  });

  it('preserves the authoritative document id when its terminal read is temporarily unavailable', async () => {
    const operationId = fixedOperationId(18);
    const retryOperationId = fixedOperationId(19);
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce(operationId)
      .mockReturnValueOnce(retryOperationId);
    const store = TestBed.inject(SourceImportStore);
    const documentId = 'document-terminal';
    apiClient.uploadDocument.mockRejectedValue(new Error('connection lost'));
    apiClient.getDocumentOperation.mockResolvedValue(
      operationRead({
        id: operationId,
        document_id: documentId,
        status: 'failed',
        phase: 'failed',
        cancellable: false,
        error: 'OCR failed.',
      }),
    );
    apiClient.getDocument.mockRejectedValue(new Error('document unavailable'));
    store.chooseFiles([pdfFile('terminal-document.pdf')]);

    const uploadPromise = store.uploadDocuments();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    const firstResult = await uploadPromise;

    expect(firstResult).toEqual([]);
    expect(store.uploadItems()[0]).toEqual(
      expect.objectContaining({
        status: 'status_unavailable',
        document: null,
      }),
    );

    apiClient.getDocument.mockResolvedValueOnce(
      documentRead({
        id: documentId,
        status: 'ocr_failed',
        has_text: false,
        chunks_count: 0,
      }),
    );
    await store.retryUpload(store.uploadItems()[0]?.id ?? 'missing');

    expect(store.uploadItems()[0]).toEqual(
      expect.objectContaining({
        status: 'failed',
        document: expect.objectContaining({ id: documentId }),
      }),
    );
    expect(apiClient.uploadDocument).toHaveBeenCalledTimes(1);

    apiClient.retryDocumentProcessing.mockResolvedValue(
      operationRead({
        id: retryOperationId,
        document_id: documentId,
        status: 'running',
        phase: 'processing',
        cancellable: true,
      }),
    );
    apiClient.getDocument.mockResolvedValueOnce(
      documentRead({
        id: documentId,
        status: 'processing',
        has_text: false,
        chunks_count: 0,
      }),
    );
    await store.retryUpload(store.uploadItems()[0]?.id ?? 'missing');

    expect(apiClient.retryDocumentProcessing).toHaveBeenCalledWith(
      'project-1',
      documentId,
      expect.objectContaining({
        headers: { 'X-Cert-Prep-Operation-Id': retryOperationId },
      }),
    );
    expect(apiClient.uploadDocument).toHaveBeenCalledTimes(1);
    expect(store.uploadItems()[0]?.status).toBe('uploaded');
  });

  it('does not consume transport retry budget for normal nonterminal progress', async () => {
    const operationId = fixedOperationId(20);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(operationId);
    const store = TestBed.inject(SourceImportStore);
    apiClient.uploadDocument.mockRejectedValue(new Error('connection lost'));
    apiClient.getDocumentOperation.mockImplementation(() => {
      if (apiClient.getDocumentOperation.mock.calls.length < 10) {
        return Promise.resolve(
          operationRead({
            id: operationId,
            status: 'queued',
            phase: 'uploading',
            cancellable: true,
          }),
        );
      }
      return Promise.resolve(
        operationRead({
          id: operationId,
          document_id: 'document-eventual',
          status: 'succeeded',
          phase: 'completed',
          cancellable: false,
        }),
      );
    });
    apiClient.getDocument.mockResolvedValue(
      documentRead({ id: 'document-eventual' }),
    );
    store.chooseFiles([pdfFile('slow-progress.pdf')]);

    const uploadPromise = store.uploadDocuments();
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 8; index += 1) {
      await vi.advanceTimersByTimeAsync(1000);
    }

    expect(apiClient.getDocumentOperation).toHaveBeenCalledTimes(9);
    expect(store.uploadItems()[0]).toEqual(
      expect.objectContaining({ status: 'uploading', error: null }),
    );

    await vi.advanceTimersByTimeAsync(1000);
    const documents = await uploadPromise;
    expect(documents).toEqual([
      expect.objectContaining({ id: 'document-eventual' }),
    ]);
  });

  it('retains the exact operation after 1, 2, and 4 second transport retries', async () => {
    const operationId = fixedOperationId(7);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(operationId);
    const store = TestBed.inject(SourceImportStore);
    const getStarted = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
    apiClient.uploadDocument.mockRejectedValue(new Error('connection lost'));
    apiClient.getDocumentOperation.mockImplementation(() => {
      getStarted[apiClient.getDocumentOperation.mock.calls.length - 1]?.resolve();
      return Promise.reject(new Error('still unavailable'));
    });
    store.chooseFiles([pdfFile('bounded.pdf')]);

    const uploadPromise = store.uploadDocuments();
    await getStarted[0]?.promise;
    await vi.advanceTimersByTimeAsync(999);
    expect(apiClient.getDocumentOperation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await getStarted[1]?.promise;
    await vi.advanceTimersByTimeAsync(1999);
    expect(apiClient.getDocumentOperation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await getStarted[2]?.promise;
    await vi.advanceTimersByTimeAsync(3999);
    expect(apiClient.getDocumentOperation).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    await getStarted[3]?.promise;
    await uploadPromise;

    expect(apiClient.getDocumentOperation).toHaveBeenCalledTimes(4);
    expect(store.uploadItems()[0]).toEqual(
      expect.objectContaining({
        status: 'status_unavailable',
        error: 'Upload status is unavailable. Retry status check.',
      }),
    );

    apiClient.getDocumentOperation.mockResolvedValue(
      operationRead({
        id: operationId,
        document_id: 'document-recovered',
        status: 'succeeded',
        phase: 'completed',
        cancellable: false,
      }),
    );
    apiClient.getDocument.mockResolvedValue(
      documentRead({ id: 'document-recovered' }),
    );

    await store.retryUpload(store.uploadItems()[0]?.id ?? 'missing');

    expect(apiClient.uploadDocument).toHaveBeenCalledTimes(1);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
    expect(apiClient.getDocumentOperation).toHaveBeenLastCalledWith(
      'project-1',
      operationId,
    );
    expect(store.uploadItems()[0]).toEqual(
      expect.objectContaining({
        status: 'uploaded',
        document: expect.objectContaining({ id: 'document-recovered' }),
      }),
    );
  });

  it('resumes an unavailable cancellation with DELETE on the same operation', async () => {
    const operationId = fixedOperationId(21);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(operationId);
    const store = TestBed.inject(SourceImportStore);
    apiClient.uploadDocument.mockImplementation(
      (
        _projectId: string,
        _body: FormData,
        options?: { signal?: AbortSignal },
      ) =>
        new Promise<DocumentRead>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Canceled.', 'AbortError'));
          });
        }),
    );
    apiClient.cancelDocumentOperation.mockRejectedValue(
      new Error('delete unavailable'),
    );
    apiClient.getDocumentOperation.mockRejectedValue(
      new Error('get unavailable'),
    );
    store.chooseFiles([pdfFile('cancel-status.pdf')]);

    const uploadPromise = store.uploadDocuments();
    await store.cancelUpload(store.uploadItems()[0]?.id ?? 'missing');
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    await uploadPromise;

    expect(store.uploadItems()[0]).toEqual(
      expect.objectContaining({
        status: 'status_unavailable',
        error: 'Cancellation status is unavailable. Retry status check.',
      }),
    );
    const deleteCallCount = apiClient.cancelDocumentOperation.mock.calls.length;
    apiClient.cancelDocumentOperation.mockResolvedValue(
      operationRead({
        id: operationId,
        status: 'canceled',
        phase: 'canceled',
        cancellable: false,
      }),
    );

    await store.retryUpload(store.uploadItems()[0]?.id ?? 'missing');

    expect(apiClient.cancelDocumentOperation).toHaveBeenCalledTimes(
      deleteCallCount + 1,
    );
    expect(apiClient.cancelDocumentOperation).toHaveBeenLastCalledWith(
      'project-1',
      operationId,
    );
    expect(apiClient.uploadDocument).toHaveBeenCalledTimes(1);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
    expect(store.uploadItems()[0]?.status).toBe('canceled');
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

function operationRead(
  overrides: Partial<DocumentOperationRead> = {},
): DocumentOperationRead {
  return {
    id: fixedOperationId(9),
    project_id: 'project-1',
    document_id: null,
    status: 'running',
    phase: 'processing',
    cancellable: true,
    error: null,
    created_at: '2026-06-18T00:00:00Z',
    updated_at: '2026-06-18T00:00:01Z',
    ...overrides,
  };
}

function fixedOperationId(
  suffix: number,
): `${string}-${string}-${string}-${string}-${string}` {
  return `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`;
}

function pdfFile(name: string): File {
  return new File(['%PDF-1.7'], name, { type: 'application/pdf' });
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
