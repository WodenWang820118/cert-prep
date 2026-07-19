import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../cert-prep-api';
import type { ChunkRead, DocumentRead } from '../../cert-prep-api';
import { HealthStore } from '../health/health.store';
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
    updateDocumentChunk: vi.fn(),
    translateDocumentChunk: vi.fn(),
    translateDocumentStaleChunks: vi.fn(),
    health: vi.fn(),
    llmHealth: vi.fn(),
    ocrHealth: vi.fn(),
    runtimeRequirements: vi.fn(),
    startRuntimeInstallation: vi.fn(),
    getRuntimeInstallation: vi.fn(),
    cancelRuntimeInstallation: vi.fn(),
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
    apiClient.runtimeRequirements.mockResolvedValue({
      items: [whisperRequirement(true)],
    });

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
      sourceFile('lesson.mp3', 'audio/mpeg'),
      sourceFile('dialog.WAV', ''),
      sourceFile('practice.m4a', 'audio/mp4'),
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
      'lesson.mp3',
      'dialog.WAV',
      'practice.m4a',
    ]);
    expect(store.selectedFileLabel()).toBe('9 files selected');
    expect(operations.error()).toContain('animated.gif');
    expect(operations.error()).toContain('vector.svg');
    expect(operations.error()).toContain('PDF, PNG, JPEG, WebP, MP3, WAV, and M4A');

    store.chooseFiles([sourceFile('next.png', 'image/png')]);

    expect(operations.error()).toBeNull();
    expect(operations.errorCode()).toBeNull();
  });

  it('opens consent and blocks audio upload until both Whisper models are ready', async () => {
    const store = TestBed.inject(SourceImportStore);
    const health = TestBed.inject(HealthStore);
    apiClient.runtimeRequirements.mockResolvedValue({
      items: [whisperRequirement(false)],
    });

    store.chooseFile(sourceFile('lesson.mp3', 'audio/mpeg'));
    await flushPromises();

    expect(health.runtimeInstallConsentKind()).toBe('whisper_models');
    expect(store.canUpload()).toBe(false);

    const uploaded = await store.uploadDocuments();

    expect(uploaded).toEqual([]);
    expect(apiClient.uploadDocument).not.toHaveBeenCalled();
    expect(TestBed.inject(OperationStore).status()).toContain(
      'consent is required',
    );
  });

  it('does not open stale Whisper consent after the selection changes during preflight', async () => {
    const store = TestBed.inject(SourceImportStore);
    const health = TestBed.inject(HealthStore);
    const requirementRequest = deferred<{
      items: ReturnType<typeof whisperRequirement>[];
    }>();
    apiClient.runtimeRequirements.mockReturnValue(requirementRequest.promise);

    store.chooseFile(sourceFile('lesson.mp3', 'audio/mpeg'));
    expect(apiClient.runtimeRequirements).toHaveBeenCalledTimes(1);

    store.chooseFile(pdfFile('guide.pdf'));
    requirementRequest.resolve({ items: [whisperRequirement(false)] });
    await flushPromises();

    expect(store.selectedFile()?.name).toBe('guide.pdf');
    expect(health.runtimeInstallConsentKind()).toBeNull();
    expect(TestBed.inject(OperationStore).error()).toBeNull();
  });

  it('uploads audio after the Whisper model inventory is ready', async () => {
    const store = TestBed.inject(SourceImportStore);
    apiClient.uploadDocument.mockResolvedValue(
      documentRead({
        id: 'audio-document',
        filename: 'lesson.mp3',
        source_kind: 'audio',
        page_count: 0,
      }),
    );

    store.chooseFile(sourceFile('lesson.mp3', 'audio/mpeg'));
    await flushPromises();
    const uploaded = await store.uploadDocuments();

    expect(uploaded).toHaveLength(1);
    expect(apiClient.uploadDocument).toHaveBeenCalledTimes(1);
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

  it('serializes transcript mutations to prevent duplicate and overlapping requests', async () => {
    const store = TestBed.inject(SourceImportStore);
    const document = documentRead({
      source_kind: 'audio',
      page_count: 0,
      chunks_count: 1,
    });
    const chunk = chunkRead({
      locator_kind: 'time',
      page_number: 0,
      start_ms: 0,
      end_ms: 1_000,
    });
    store.documents.set([document]);
    store.setActiveDocumentId(document.id);
    store.chunks.set([chunk]);

    const editRequest = deferred<ChunkRead>();
    apiClient.updateDocumentChunk.mockReturnValue(editRequest.promise);
    const editRun = store.updateTranscriptChunk(chunk.id, '更新後的日文');
    const duplicateEdit = store.updateTranscriptChunk(chunk.id, '重複日文');
    const blockedTranslate = store.translateTranscriptChunk(chunk.id);
    const blockedBulk = store.translateStaleTranscriptChunks();

    expect(apiClient.updateDocumentChunk).toHaveBeenCalledTimes(1);
    expect(apiClient.translateDocumentChunk).not.toHaveBeenCalled();
    expect(apiClient.translateDocumentStaleChunks).not.toHaveBeenCalled();
    editRequest.resolve({ ...chunk, text: '更新後的日文' });
    await Promise.all([editRun, duplicateEdit, blockedTranslate, blockedBulk]);

    const translateRequest = deferred<ChunkRead>();
    apiClient.translateDocumentChunk.mockReturnValue(translateRequest.promise);
    const translateRun = store.translateTranscriptChunk(chunk.id);
    const duplicateTranslate = store.translateTranscriptChunk(chunk.id);
    const blockedEdit = store.updateTranscriptChunk(chunk.id, '再更新');
    const blockedBulkDuringTranslate = store.translateStaleTranscriptChunks();

    expect(apiClient.translateDocumentChunk).toHaveBeenCalledTimes(1);
    expect(apiClient.updateDocumentChunk).toHaveBeenCalledTimes(1);
    expect(apiClient.translateDocumentStaleChunks).not.toHaveBeenCalled();
    translateRequest.resolve({ ...chunk, translated_text: '繁體中文' });
    await Promise.all([
      translateRun,
      duplicateTranslate,
      blockedEdit,
      blockedBulkDuringTranslate,
    ]);

    const bulkRequest = deferred<{ items: ChunkRead[] }>();
    apiClient.translateDocumentStaleChunks.mockReturnValue(bulkRequest.promise);
    const bulkRun = store.translateStaleTranscriptChunks();
    const duplicateBulk = store.translateStaleTranscriptChunks();
    const blockedEditDuringBulk = store.updateTranscriptChunk(chunk.id, '又更新');
    const blockedTranslateDuringBulk = store.translateTranscriptChunk(chunk.id);

    expect(apiClient.translateDocumentStaleChunks).toHaveBeenCalledTimes(1);
    expect(apiClient.updateDocumentChunk).toHaveBeenCalledTimes(1);
    expect(apiClient.translateDocumentChunk).toHaveBeenCalledTimes(1);
    bulkRequest.resolve({ items: [{ ...chunk, translated_text: '批次繁中' }] });
    await Promise.all([
      bulkRun,
      duplicateBulk,
      blockedEditDuringBulk,
      blockedTranslateDuringBulk,
    ]);
  });

  it('refreshes document translation metadata after transcript mutations', async () => {
    const store = TestBed.inject(SourceImportStore);
    const document = documentRead({
      source_kind: 'audio',
      page_count: 0,
      chunks_count: 1,
      translation_status: 'succeeded',
    });
    const chunk = chunkRead({
      locator_kind: 'time',
      page_number: 0,
      start_ms: 0,
      end_ms: 1_000,
      source_revision: 1,
      translated_text: '原翻譯',
      translation_source_revision: 1,
      translation_stale: false,
    });
    store.documents.set([document]);
    store.setActiveDocumentId(document.id);
    store.chunks.set([chunk]);

    const editedChunk = {
      ...chunk,
      text: '更新後的日文',
      source_revision: 2,
      translation_stale: true,
    };
    const failedTranslationDocument = documentRead({
      ...document,
      translation_status: 'failed',
    });
    apiClient.updateDocumentChunk.mockResolvedValue(editedChunk);
    apiClient.getDocument.mockResolvedValueOnce(failedTranslationDocument);

    await store.updateTranscriptChunk(chunk.id, editedChunk.text);

    expect(store.chunks()[0]).toEqual(editedChunk);
    expect(store.activeDocument()?.translation_status).toBe('failed');
    expect(store.documents()[0]?.translation_status).toBe('failed');

    const translatedChunk = {
      ...editedChunk,
      translated_text: '更新後的繁體中文',
      translation_source_revision: 2,
      translation_stale: false,
    };
    const translatedDocument = documentRead({
      ...document,
      translation_status: 'succeeded',
    });
    apiClient.translateDocumentChunk.mockResolvedValue(translatedChunk);
    apiClient.getDocument.mockResolvedValueOnce(translatedDocument);

    await store.translateTranscriptChunk(chunk.id);

    expect(store.chunks()[0]).toEqual(translatedChunk);
    expect(store.activeDocument()?.translation_status).toBe('succeeded');

    apiClient.translateDocumentStaleChunks.mockResolvedValue({
      items: [translatedChunk],
    });
    apiClient.getDocument.mockResolvedValueOnce(translatedDocument);

    await store.translateStaleTranscriptChunks();

    expect(apiClient.getDocument).toHaveBeenCalledTimes(3);
    expect(store.documents()[0]?.translation_status).toBe('succeeded');
  });

  it('stops polling and allows retry after audio transcription fails', async () => {
    const store = TestBed.inject(SourceImportStore);
    const failedDocument = documentRead({
      source_kind: 'audio',
      page_count: 0,
      chunks_count: 0,
      has_text: false,
      status: 'transcription_failed',
      transcription_status: 'failed',
    });
    store.documents.set([failedDocument]);
    store.setActiveDocumentId(failedDocument.id);
    apiClient.getDocument.mockResolvedValue(failedDocument);

    await store.refreshUploadedDocument('project-1', failedDocument.id);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(apiClient.getDocument).toHaveBeenCalledTimes(1);
    expect(store.parseStageText()).toContain('transcription failed');

    await store.retryActiveDocumentProcessing();

    expect(apiClient.retryDocumentProcessing).toHaveBeenCalledWith(
      'project-1',
      failedDocument.id,
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

function whisperRequirement(available: boolean) {
  return {
    kind: 'whisper_models' as const,
    label: 'Whisper speech models',
    available,
    detail: available
      ? 'Whisper speech models are ready.'
      : 'Whisper speech models require download.',
    unavailable_reason: available ? null : 'whisper_models_missing',
    version: 'large-v3-turbo + small',
  };
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
