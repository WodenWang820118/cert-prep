import { TestBed } from '@angular/core/testing';
import { finalize, of, Subject, throwError } from 'rxjs';
import { CERT_PREP_API } from '../../constants/cert-prep-api.constants';
import type { ChunkRead, DocumentRead } from '../../contracts/api.contracts';
import { HealthStore } from '../health/health.store';
import { OperationStore } from '../operation.store';
import { ProjectStore } from '../project.store';
import { SourceImportStore } from './source-import.store';
import { provideCertPrepHttpResourceClientFake } from '../../testing/cert-prep-http-resource-client.fake';

describe('SourceImportStore polling', () => {
  const apiClient = {
    getDocument: vi.fn(),
    listDocumentChunks: vi.fn(),
    listDocuments: vi.fn(),
    uploadDocument: vi.fn(),
    getDocumentOperation: vi.fn(),
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
      providers: [
        { provide: CERT_PREP_API, useValue: apiClient },
        provideCertPrepHttpResourceClientFake(apiClient),
      ],
    });

    apiClient.getDocument.mockImplementation(
      (_projectId: string, documentId = 'document-1') =>
        of(documentRead({ id: documentId })),
    );
    apiClient.listDocumentChunks.mockReturnValue(of({ items: [] }));
    apiClient.getDocumentOperation.mockImplementation(
      (projectId: string, operationId: string) =>
        of(
          documentOperation('running', {
            id: operationId,
            project_id: projectId,
          }),
        ),
    );
    apiClient.cancelDocumentOperation.mockImplementation(
      (projectId: string, operationId: string) =>
        of(
          documentOperation('canceled', {
            id: operationId,
            project_id: projectId,
          }),
        ),
    );
    apiClient.cancelDocumentProcessing.mockReturnValue(of(
      documentOperation('cancel_requested'),
    ));
    apiClient.retryDocumentProcessing.mockReturnValue(of(
      documentOperation('running'),
    ));
    apiClient.runtimeRequirements.mockReturnValue(of({
      items: [whisperRequirement(true)],
    }));

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

  it('polls quickly until the first chunk is visible, then returns to the normal cadence', () => {
    const store = TestBed.inject(SourceImportStore);
    apiClient.getDocument
      .mockReturnValueOnce(of(
        documentRead({ status: 'processing', chunks_count: 1 }),
      ))
      .mockReturnValueOnce(of(
        documentRead({ status: 'processing', chunks_count: 1 }),
      ))
      .mockReturnValueOnce(of(
        documentRead({ status: 'processing', chunks_count: 1 }),
      ));
    apiClient.listDocumentChunks
      .mockReturnValueOnce(of({ items: [] }))
      .mockReturnValueOnce(of({ items: [chunkRead()] }))
      .mockReturnValueOnce(of({ items: [chunkRead()] }));

    store.refreshUploadedDocument('project-1', 'document-1');

    expect(store.chunks()).toEqual([]);
    expect(apiClient.getDocument).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(499);
    expect(apiClient.getDocument).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(apiClient.getDocument).toHaveBeenCalledTimes(2);
    expect(store.chunks()).toEqual([chunkRead()]);

    vi.advanceTimersByTime(1499);
    expect(apiClient.getDocument).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1);
    expect(apiClient.getDocument).toHaveBeenCalledTimes(3);
  });

  it('loads project documents and makes the latest document active explicitly', () => {
    const store = TestBed.inject(SourceImportStore);
    const latestDocument = documentRead({ id: 'document-2', filename: 'latest.pdf' });
    apiClient.listDocuments.mockReturnValue(of({
      items: [latestDocument, documentRead()],
    }));
    apiClient.getDocument.mockReturnValue(of(latestDocument));
    apiClient.listDocumentChunks.mockReturnValue(of({
      items: [chunkRead({ document_id: latestDocument.id })],
    }));

    store.loadLatestDocument('project-1');
    flushReactive();
    expect(store.documents()).toEqual([latestDocument, documentRead()]);
    expect(store.chunks()).toEqual([chunkRead({ document_id: latestDocument.id })]);

    expect(store.documents()).toEqual([latestDocument, documentRead()]);
    expect(store.activeDocumentId()).toBe(latestDocument.id);
    expect(store.uploadedDocument()).toEqual(latestDocument);
    expect(store.activeDocument()).toEqual(latestDocument);
    expect(store.chunks()).toEqual([chunkRead({ document_id: latestDocument.id })]);
  });

  it('selects a project document and refreshes its status and chunks', () => {
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
    apiClient.getDocument.mockReturnValue(of(refreshedSecondDocument));
    apiClient.listDocumentChunks.mockReturnValue(of({
      items: [chunkRead({ document_id: secondDocument.id })],
    }));

    store.selectDocument(secondDocument.id);
    flushReactive();
    expect(apiClient.getDocument).toHaveBeenCalledWith(
      'project-1',
      secondDocument.id,
    );
    expect(store.chunks()[0]?.document_id).toBe(secondDocument.id);

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

  it('retries polling with bounded backoff and exposes an actionable error', () => {
    const store = TestBed.inject(SourceImportStore);
    apiClient.getDocument.mockReturnValue(throwError(() => new Error('backend offline')));

    store.refreshUploadedDocument('project-1', 'document-1');

    expect(store.pollingError()).toBeNull();
    expect(apiClient.getDocument).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(2000);
    vi.advanceTimersByTime(4000);

    expect(apiClient.getDocument).toHaveBeenCalledTimes(4);
    expect(store.pollingError()).toContain('could not be refreshed');

    apiClient.getDocument.mockReturnValue(of(documentRead()));
    store.retryDocumentPolling();
    flushReactive();

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

  it('restores audio upload authorization after Whisper consent is canceled', () => {
    const store = TestBed.inject(SourceImportStore);
    const health = TestBed.inject(HealthStore);
    apiClient.runtimeRequirements.mockReturnValue(of({
      items: [whisperRequirement(false)],
    }));

    store.chooseFile(sourceFile('lesson.mp3', 'audio/mpeg'));
    flushReactive();

    expect(health.runtimeInstallConsentKind()).toBe('whisper_models');
    expect(store.canUpload()).toBe(true);

    store.uploadDocuments();

    expect(apiClient.uploadDocument).not.toHaveBeenCalled();
    expect(store.canUpload()).toBe(false);
    expect(TestBed.inject(OperationStore).status()).toContain(
      'consent is required',
    );

    health.cancelRuntimeInstallConsent();
    TestBed.tick();
    flushReactive();

    expect(store.canUpload()).toBe(true);
    health.runtimeRequirements.set([whisperRequirement(true)]);
    TestBed.tick();
    flushReactive();

    expect(apiClient.uploadDocument).not.toHaveBeenCalled();
  });

  it('restores audio upload authorization when Whisper preflight fails', () => {
    const store = TestBed.inject(SourceImportStore);
    const health = TestBed.inject(HealthStore);
    apiClient.runtimeRequirements.mockReturnValue(throwError(() =>
      new TypeError('Runtime requirements unavailable'),
    ));

    store.chooseFile(sourceFile('lesson.mp3', 'audio/mpeg'));
    flushReactive();
    store.uploadDocuments();
    TestBed.tick();
    flushReactive();

    expect(store.canUpload()).toBe(true);
    expect(apiClient.uploadDocument).not.toHaveBeenCalled();

    health.runtimeRequirements.set([whisperRequirement(true)]);
    TestBed.tick();
    flushReactive();

    expect(apiClient.uploadDocument).not.toHaveBeenCalled();
  });

  it('restores audio upload authorization when Whisper installation fails', () => {
    const store = TestBed.inject(SourceImportStore);
    const health = TestBed.inject(HealthStore);
    health.runtimeRequirements.set([whisperRequirement(false)]);
    store.chooseFile(sourceFile('lesson.mp3', 'audio/mpeg'));

    store.uploadDocuments();
    expect(store.canUpload()).toBe(false);

    health.runtimeInstall.set({
      jobId: 'whisper-install-1',
      kind: 'whisper_models',
      label: 'Whisper speech models',
      phase: 'failed',
      status: 'failed',
      progress: null,
      message: 'Whisper model download failed.',
      error: 'Whisper model download failed.',
      cancellable: false,
    });
    TestBed.tick();
    flushReactive();

    expect(store.canUpload()).toBe(true);
    health.runtimeRequirements.set([whisperRequirement(true)]);
    TestBed.tick();
    flushReactive();

    expect(apiClient.uploadDocument).not.toHaveBeenCalled();
  });

  it('does not auto-upload selected audio before the user authorizes it', () => {
    const store = TestBed.inject(SourceImportStore);
    const health = TestBed.inject(HealthStore);
    health.runtimeRequirements.set([whisperRequirement(false)]);
    apiClient.uploadDocument.mockReturnValue(of(
      documentRead({
        id: 'audio-document',
        filename: 'lesson.mp3',
        source_kind: 'audio',
        page_count: 0,
      }),
    ));

    store.chooseFile(sourceFile('lesson.mp3', 'audio/mpeg'));
    health.runtimeRequirements.set([whisperRequirement(true)]);
    TestBed.tick();
    flushReactive();

    expect(apiClient.uploadDocument).not.toHaveBeenCalled();
    expect(store.uploadItems()[0]?.status).toBe('queued');
    expect(store.canUpload()).toBe(true);
  });

  it('auto-starts an authorized audio upload when Whisper becomes ready', () => {
    const store = TestBed.inject(SourceImportStore);
    const health = TestBed.inject(HealthStore);
    const audioUpload = deferred<DocumentRead>();
    health.runtimeRequirements.set([whisperRequirement(false)]);
    apiClient.uploadDocument.mockReturnValue(audioUpload.observable);

    store.chooseFile(sourceFile('lesson.mp3', 'audio/mpeg'));
    store.uploadDocuments();
    expect(apiClient.uploadDocument).not.toHaveBeenCalled();

    health.runtimeRequirements.set([whisperRequirement(true)]);
    TestBed.tick();
    flushReactive();

    expect(apiClient.uploadDocument).toHaveBeenCalledTimes(1);
    expect(store.uploadItems()[0]?.status).toBe('uploading');

    audioUpload.resolve(
      documentRead({
        id: 'audio-document',
        filename: 'lesson.mp3',
        source_kind: 'audio',
        page_count: 0,
      }),
    );
    flushReactive();

    expect(store.uploadItems()[0]?.status).toBe('uploaded');
  });

  it('does not open stale Whisper consent after the selection changes during preflight', () => {
    const store = TestBed.inject(SourceImportStore);
    const health = TestBed.inject(HealthStore);
    const requirementRequest = deferred<{
      items: ReturnType<typeof whisperRequirement>[];
    }>();
    apiClient.runtimeRequirements.mockReturnValue(requirementRequest.observable);

    store.chooseFile(sourceFile('lesson.mp3', 'audio/mpeg'));
    expect(apiClient.runtimeRequirements).toHaveBeenCalledTimes(1);

    store.chooseFile(pdfFile('guide.pdf'));
    requirementRequest.resolve({ items: [whisperRequirement(false)] });
    flushReactive();

    expect(store.selectedFile()?.name).toBe('guide.pdf');
    expect(health.runtimeInstallConsentKind()).toBeNull();
    expect(TestBed.inject(OperationStore).error()).toBeNull();
  });

  it('uploads audio after the Whisper model inventory is ready', () => {
    const store = TestBed.inject(SourceImportStore);
    apiClient.uploadDocument.mockReturnValue(of(
      documentRead({
        id: 'audio-document',
        filename: 'lesson.mp3',
        source_kind: 'audio',
        page_count: 0,
      }),
    ));

    store.chooseFile(sourceFile('lesson.mp3', 'audio/mpeg'));
    flushReactive();
    store.uploadDocuments();

    expect(apiClient.uploadDocument).toHaveBeenCalledTimes(1);
  });

  it('keeps two upload slots full as each source transport completes', () => {
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
      return uploads.get(file.name)?.observable;
    });
    apiClient.getDocument.mockImplementation((_projectId: string, documentId: string) =>
      of(documentRead({ id: documentId })),
    );
    store.chooseFiles([
      pdfFile('first.pdf'),
      sourceFile('second.png', 'image/png'),
      sourceFile('third.webp', 'image/webp'),
    ]);

    store.uploadDocuments();
    flushReactive();

    expect(startedUploads).toEqual(['first.pdf', 'second.png']);
    firstUpload.resolve(documentRead({ id: 'document-1', filename: 'first.pdf' }));
    flushUploadQueue();

    expect(startedUploads).toEqual(['first.pdf', 'second.png', 'third.webp']);
    expect(store.uploadItems()[0]?.status).toBe('uploaded');
    secondUpload.resolve(documentRead({ id: 'document-2', filename: 'second.png' }));
    flushReactive();

    expect(startedUploads).toEqual(['first.pdf', 'second.png', 'third.webp']);
    thirdUpload.resolve(documentRead({ id: 'document-3', filename: 'third.webp' }));
    flushUploadQueue();

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

  it('appends ready files to the active run and waits for the appended transport', () => {
    const store = TestBed.inject(SourceImportStore);
    const firstUpload = deferred<DocumentRead>();
    const appendedUpload = deferred<DocumentRead>();
    const startedUploads: string[] = [];
    apiClient.uploadDocument.mockImplementation(
      (_projectId: string, body: FormData) => {
        const file = body.get('file') as File;
        startedUploads.push(file.name);
        return file.name === 'first.pdf'
          ? firstUpload.observable
          : appendedUpload.observable;
      },
    );
    store.chooseFile(pdfFile('first.pdf'));

    store.uploadDocuments();
    flushReactive();
    store.chooseFile(pdfFile('appended.pdf'));
    flushReactive();

    expect(startedUploads).toEqual(['first.pdf', 'appended.pdf']);
    expect(store.selectedFiles().map((file) => file.name)).toEqual([
      'first.pdf',
      'appended.pdf',
    ]);

    firstUpload.resolve(
      documentRead({ id: 'document-first', filename: 'first.pdf' }),
    );
    flushReactive();

    expect(store.uploadItems()[0]?.status).toBe('uploaded');

    appendedUpload.resolve(
      documentRead({ id: 'document-appended', filename: 'appended.pdf' }),
    );
    flushReactive();
    expect(store.uploadItems().map((item) => item.status)).toEqual([
      'uploaded',
      'uploaded',
    ]);
  });

  it('releases active-run appended audio authorization when consent is canceled', () => {
    const store = TestBed.inject(SourceImportStore);
    const health = TestBed.inject(HealthStore);
    const pdfUpload = deferred<DocumentRead>();
    const uploadedNames: string[] = [];
    health.runtimeRequirements.set([whisperRequirement(false)]);
    apiClient.uploadDocument.mockImplementation(
      (_projectId: string, body: FormData) => {
        const file = body.get('file') as File;
        uploadedNames.push(file.name);
        return file.name === 'busy.pdf'
          ? pdfUpload.observable
          : of(
              documentRead({
                id: 'document-audio',
                filename: file.name,
                source_kind: 'audio',
                page_count: 0,
              }),
            );
      },
    );
    store.chooseFile(pdfFile('busy.pdf'));

    store.uploadDocuments();
    flushReactive();
    store.chooseFile(sourceFile('lesson.mp3', 'audio/mpeg'));
    flushReactive();

    expect(health.runtimeInstallConsentKind()).toBe('whisper_models');
    expect(store.uploadItems()[1]?.status).toBe('queued');

    health.cancelRuntimeInstallConsent();
    TestBed.tick();
    flushReactive();
    pdfUpload.resolve(
      documentRead({ id: 'document-busy', filename: 'busy.pdf' }),
    );
    flushReactive();

    expect(store.canUpload()).toBe(true);
    health.runtimeRequirements.set([whisperRequirement(true)]);
    TestBed.tick();
    flushReactive();

    expect(uploadedNames).toEqual(['busy.pdf']);
    expect(store.uploadItems()[1]?.status).toBe('queued');
  });

  it('uploads a mixed PDF immediately while missing Whisper models keep audio queued', () => {
    const store = TestBed.inject(SourceImportStore);
    const health = TestBed.inject(HealthStore);
    const pdfUpload = deferred<DocumentRead>();
    const audioUpload = deferred<DocumentRead>();
    const uploadedNames: string[] = [];
    health.runtimeRequirements.set([whisperRequirement(false)]);
    apiClient.uploadDocument.mockImplementation(
      (_projectId: string, body: FormData) => {
        const file = body.get('file') as File;
        uploadedNames.push(file.name);
        return file.name.endsWith('.mp3')
          ? audioUpload.observable
          : pdfUpload.observable;
      },
    );
    store.chooseFiles([
      pdfFile('guide.pdf'),
      sourceFile('lesson.mp3', 'audio/mpeg'),
    ]);

    store.uploadDocuments();
    flushReactive();

    expect(uploadedNames).toEqual(['guide.pdf']);
    expect(store.uploadItems().map((item) => item.status)).toEqual([
      'uploading',
      'queued',
    ]);
    expect(health.runtimeInstallConsentKind()).toBe('whisper_models');

    health.runtimeRequirements.set([whisperRequirement(true)]);
    TestBed.tick();
    flushReactive();

    expect(uploadedNames).toEqual(['guide.pdf', 'lesson.mp3']);
    expect(store.uploadItems().map((item) => item.status)).toEqual([
      'uploading',
      'uploading',
    ]);

    pdfUpload.resolve(
      documentRead({ id: 'document-guide.pdf', filename: 'guide.pdf' }),
    );
    audioUpload.resolve(
      documentRead({
        id: 'document-lesson.mp3',
        filename: 'lesson.mp3',
        source_kind: 'audio',
        page_count: 0,
      }),
    );
    flushReactive();
    expect(store.uploadItems().map((item) => item.status)).toEqual([
      'uploaded',
      'uploaded',
    ]);
  });

  it('reconciles a claimed upload after a 503 transport response', () => {
    const store = TestBed.inject(SourceImportStore);
    let operationId = '';
    apiClient.uploadDocument.mockImplementation(
      (
        _projectId: string,
        _body: FormData,
        options: { headers?: Record<string, string> },
      ) => {
        operationId = options.headers?.['X-Cert-Prep-Operation-Id'] ?? '';
        return throwError(() => ({
          status: 503,
          error: { message: 'The upload response was interrupted.' },
        }));
      },
    );
    apiClient.getDocumentOperation.mockImplementation(
      (projectId: string, requestedOperationId: string) =>
        of(
          documentOperation('succeeded', {
            id: requestedOperationId,
            project_id: projectId,
            document_id: 'document-claimed',
            phase: 'completed',
          }),
        ),
    );
    apiClient.getDocument.mockReturnValue(of(
      documentRead({ id: 'document-claimed', filename: 'claimed.pdf' }),
    ));
    store.chooseFile(pdfFile('claimed.pdf'));

    store.uploadDocuments();

    expect(operationId).not.toBe('');
    expect(apiClient.getDocumentOperation).toHaveBeenCalledWith(
      'project-1',
      operationId,
    );
    expect(store.documents()[0]).toEqual(
      expect.objectContaining({ id: 'document-claimed' }),
    );
    expect(store.uploadItems()[0]).toEqual(
      expect.objectContaining({
        status: 'uploaded',
        document: expect.objectContaining({ id: 'document-claimed' }),
      }),
    );
  });

  it('cancels a queued source locally without creating or canceling an operation', () => {
    const store = TestBed.inject(SourceImportStore);
    const firstUpload = deferred<DocumentRead>();
    store.setUploadBatchSize(1);
    apiClient.uploadDocument.mockReturnValue(firstUpload.observable);
    store.chooseFiles([pdfFile('first.pdf'), pdfFile('queued.pdf')]);

    store.uploadDocuments();
    flushReactive();
    const queuedItem = store.uploadItems()[1];
    if (queuedItem === undefined) {
      throw new Error('Expected a queued upload item.');
    }
    store.cancelUploadItem(queuedItem.id);

    expect(store.uploadItems()[1]?.status).toBe('canceled');
    expect(apiClient.uploadDocument).toHaveBeenCalledTimes(1);
    expect(apiClient.cancelDocumentOperation).not.toHaveBeenCalled();

    firstUpload.resolve(
      documentRead({ id: 'document-first', filename: 'first.pdf' }),
    );
      });

  it('refills the upload slot after canceling an active transport', () => {
    const store = TestBed.inject(SourceImportStore);
    const secondUpload = deferred<DocumentRead>();
    const activeUpload = deferred<DocumentRead>();
    const startedUploads: string[] = [];
    const operationIds = new Map<string, string>();
    store.setUploadBatchSize(1);
    apiClient.uploadDocument.mockImplementation(
      (
        _projectId: string,
        body: FormData,
        options: {
          headers?: Record<string, string>;
          signal?: AbortSignal;
        },
      ) => {
        const file = body.get('file') as File;
        startedUploads.push(file.name);
        operationIds.set(
          file.name,
          options.headers?.['X-Cert-Prep-Operation-Id'] ?? '',
        );
        if (file.name === 'active.pdf') {
          options.signal?.addEventListener(
            'abort',
            () => activeUpload.reject(new DOMException('canceled', 'AbortError')),
            { once: true },
          );
          return activeUpload.observable;
        }
        return secondUpload.observable;
      },
    );
    store.chooseFiles([pdfFile('active.pdf'), pdfFile('queued.pdf')]);

    store.uploadDocuments();
    flushReactive();
    const activeItem = store.uploadItems()[0];
    if (activeItem === undefined) {
      throw new Error('Expected an active upload item.');
    }
    store.cancelUploadItem(activeItem.id);
    flushUploadQueue();

    const firstOperationId = operationIds.get('active.pdf');
    expect(firstOperationId).toBeTruthy();
    expect(apiClient.cancelDocumentOperation).toHaveBeenCalledWith(
      'project-1',
      firstOperationId,
    );
    expect(startedUploads).toEqual(['active.pdf', 'queued.pdf']);
    expect(store.uploadItems().map((item) => item.status)).toEqual([
      'canceled',
      'uploading',
    ]);
    expect(operationIds.get('queued.pdf')).not.toBe(firstOperationId);

    secondUpload.resolve(
      documentRead({ id: 'document-queued', filename: 'queued.pdf' }),
    );

    expect(store.uploadItems()[1]?.status).toBe('uploaded');
  });

  it('appends new files without invalidating a status-unavailable upload attempt', () => {
    const store = TestBed.inject(SourceImportStore);
    const secondUpload = deferred<DocumentRead>();
    let firstOperationId = '';
    apiClient.uploadDocument.mockImplementation(
      (
        _projectId: string,
        body: FormData,
        options: { headers?: Record<string, string> },
      ) => {
        const file = body.get('file') as File;
        if (file.name === 'uncertain.pdf') {
          firstOperationId =
            options.headers?.['X-Cert-Prep-Operation-Id'] ?? '';
          return throwError(() => new TypeError('Connection interrupted'));
        }
        return secondUpload.observable;
      },
    );
    apiClient.getDocumentOperation.mockReturnValue(throwError(() =>
      new TypeError('Status endpoint unavailable'),
    ));
    store.chooseFile(pdfFile('uncertain.pdf'));

    store.uploadDocuments();
    flushReactive();
    for (const delay of [1_000, 2_000, 4_000]) {
      vi.advanceTimersByTime(delay);
      flushReactive();
    }

    const uncertainItem = store.uploadItems()[0];
    expect(uncertainItem?.status).toBe('status_unavailable');
    expect(firstOperationId).not.toBe('');

    store.chooseFile(pdfFile('new.pdf'));
    flushReactive();

    expect(store.selectedFiles().map((file) => file.name)).toEqual([
      'uncertain.pdf',
      'new.pdf',
    ]);
    expect(store.uploadItems()[0]).toBe(uncertainItem);
    expect(store.uploadItems()[0]?.status).toBe('status_unavailable');
    expect(apiClient.uploadDocument).toHaveBeenCalledTimes(2);

    secondUpload.resolve(
      documentRead({ id: 'document-new', filename: 'new.pdf' }),
    );
    flushReactive();

    apiClient.getDocumentOperation.mockImplementation(
      (projectId: string, requestedOperationId: string) =>
        of(
          documentOperation('succeeded', {
            id: requestedOperationId,
            project_id: projectId,
            document_id: 'document-uncertain',
            phase: 'completed',
          }),
        ),
    );
    apiClient.getDocument.mockImplementation(
      (_projectId: string, documentId: string) =>
        of(documentRead({ id: documentId })),
    );
    if (uncertainItem === undefined) {
      throw new Error('Expected the status-unavailable upload item.');
    }
    store.retryUploadItem(uncertainItem.id);

    expect(apiClient.getDocumentOperation).toHaveBeenLastCalledWith(
      'project-1',
      firstOperationId,
    );
    expect(store.uploadItems()[0]?.status).toBe('uploaded');
  });

  it('queues status reconciliation behind the active upload concurrency slot', () => {
    const store = TestBed.inject(SourceImportStore);
    const blockingUpload = deferred<DocumentRead>();
    let uncertainOperationId = '';
    let blockingTransportActive = false;
    let reconciliationOverlappedTransport = false;
    store.setUploadBatchSize(1);
    apiClient.uploadDocument.mockImplementation(
      (
        _projectId: string,
        body: FormData,
        options: { headers?: Record<string, string> },
      ) => {
        const file = body.get('file') as File;
        if (file.name === 'uncertain.pdf') {
          uncertainOperationId =
            options.headers?.['X-Cert-Prep-Operation-Id'] ?? '';
          return throwError(() => new TypeError('Connection interrupted'));
        }
        blockingTransportActive = true;
        return blockingUpload.observable.pipe(
          finalize(() => {
            blockingTransportActive = false;
          }),
        );
      },
    );
    apiClient.getDocumentOperation.mockImplementation(() => {
      reconciliationOverlappedTransport ||= blockingTransportActive;
      return throwError(() => new TypeError('Status endpoint unavailable'));
    });
    store.chooseFile(pdfFile('uncertain.pdf'));

    store.uploadDocuments();
    flushReactive();
    for (const delay of [1_000, 2_000, 4_000]) {
      vi.advanceTimersByTime(delay);
      flushReactive();
    }

    const uncertainItem = store.uploadItems()[0];
    if (uncertainItem === undefined) {
      throw new Error('Expected the status-unavailable upload item.');
    }
    expect(uncertainItem.status).toBe('status_unavailable');
    const reconciliationCallsBeforeRetry =
      apiClient.getDocumentOperation.mock.calls.length;
    apiClient.getDocumentOperation.mockImplementation(
      (projectId: string, requestedOperationId: string) => {
        reconciliationOverlappedTransport ||= blockingTransportActive;
        return of(
          documentOperation('succeeded', {
            id: requestedOperationId,
            project_id: projectId,
            document_id: 'document-uncertain',
            phase: 'completed',
          }),
        );
      },
    );
    store.chooseFile(pdfFile('blocking.pdf'), {
      append: true,
      autoUpload: false,
    });

    store.uploadDocuments();
    flushReactive();
    flushReactive();
    store.retryUploadItem(uncertainItem.id);
    flushReactive();

    expect(blockingTransportActive).toBe(true);
    expect(apiClient.getDocumentOperation).toHaveBeenCalledTimes(
      reconciliationCallsBeforeRetry,
    );
    expect(store.uploadItems()[0]?.status).toBe('status_unavailable');

    blockingUpload.resolve(
      documentRead({ id: 'document-blocking', filename: 'blocking.pdf' }),
    );
    flushUploadQueue();

    expect(reconciliationOverlappedTransport).toBe(false);
    expect(apiClient.getDocumentOperation).toHaveBeenLastCalledWith(
      'project-1',
      uncertainOperationId,
    );
    expect(store.uploadItems().map((item) => item.status)).toEqual([
      'uploaded',
      'uploaded',
    ]);
  });

  it('ignores a late upload result after the project context resets', () => {
    const store = TestBed.inject(SourceImportStore);
    const upload = deferred<DocumentRead>();
    apiClient.uploadDocument.mockReturnValue(upload.observable);
    store.chooseFile(pdfFile('stale.pdf'));

    store.uploadDocuments();
    flushReactive();
    store.reset();

        upload.resolve(
      documentRead({ id: 'document-stale', filename: 'stale.pdf' }),
    );
    flushReactive();

    expect(store.uploadItems()).toEqual([]);
    expect(store.documents()).toEqual([]);
    expect(store.activeDocument()).toBeNull();
  });

  it('uses the configured upload batch size for the whole upload run', () => {
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
      return uploads.get(file.name)?.observable;
    });
    store.chooseFiles([
      pdfFile('first.pdf'),
      pdfFile('second.pdf'),
      pdfFile('third.pdf'),
      pdfFile('fourth.pdf'),
    ]);

    store.uploadDocuments();
    flushReactive();

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
    flushUploadQueue();

    expect(startedUploads).toEqual([
      'first.pdf',
      'second.pdf',
      'third.pdf',
      'fourth.pdf',
    ]);
    uploads.get('fourth.pdf')?.resolve(
      documentRead({ id: 'document-4', filename: 'fourth.pdf' }),
    );

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

  it('ignores reentrant upload calls while a document batch is in progress', () => {
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
      return uploads.get(file.name)?.observable;
    });
    store.chooseFiles([pdfFile('first.pdf'), pdfFile('second.pdf')]);

    store.uploadDocuments();
    flushReactive();

    store.uploadDocuments();
    expect(startedUploads).toEqual(['first.pdf', 'second.pdf']);

    firstUpload.resolve(documentRead({ id: 'document-1', filename: 'first.pdf' }));
    flushReactive();
    expect(startedUploads).toEqual(['first.pdf', 'second.pdf']);

    secondUpload.resolve(documentRead({ id: 'document-2', filename: 'second.pdf' }));

    expect(apiClient.uploadDocument).toHaveBeenCalledTimes(2);
    expect(store.uploadItems().map((item) => item.status)).toEqual([
      'uploaded',
      'uploaded',
    ]);
  });

  it('keeps successful uploads when one source file fails', () => {
    const store = TestBed.inject(SourceImportStore);
    const failed = { status: 400, error: { message: 'Invalid source file' } };
    apiClient.uploadDocument.mockImplementation(
      (_projectId: string, body: FormData) => {
        const file = body.get('file') as File;
        if (file.name === 'bad.pdf') {
          return throwError(() => failed);
        }
        return of(
          documentRead({ id: 'document-good', filename: file.name }),
        );
      },
    );
    apiClient.getDocument.mockReturnValue(of(
      documentRead({ id: 'document-good', filename: 'good.pdf' }),
    ));
    store.chooseFiles([pdfFile('bad.pdf'), pdfFile('good.pdf')]);

    store.uploadDocuments();
    flushReactive();

    expect(store.documents()[0]).toEqual(
      expect.objectContaining({ id: 'document-good', filename: 'good.pdf' }),
    );
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

  it('opens the OCR runtime prompt when its best-effort health refresh fails', () => {
    const store = TestBed.inject(SourceImportStore);
    const health = TestBed.inject(HealthStore);
    const healthError = new Error('Runtime health unavailable');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const openPrompt = vi.spyOn(health, 'openOcrRuntimeInstallConsent');
    vi.spyOn(health, 'load').mockImplementation(() => {
      throw healthError;
    });
    apiClient.uploadDocument.mockReturnValue(throwError(() => ({
      status: 503,
      error: {
        code: 'windowsml_runtime_missing',
        message: 'WindowsML runtime is missing.',
      },
    })));
    store.chooseFile(pdfFile('runtime-missing.pdf'));

    store.uploadDocuments();
    flushReactive();

    expect(store.uploadItems()[0]).toEqual(
      expect.objectContaining({
        status: 'failed',
        error: 'WindowsML runtime is missing.',
      }),
    );
    expect(TestBed.inject(OperationStore).error()).toBe(
      '1 source file failed to upload.',
    );
    expect(openPrompt).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      'Unable to refresh runtime health before opening the OCR runtime prompt.',
      healthError,
    );
  });

  it('retries failed source files without uploading successful items again', () => {
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
          return throwError(() => ({
            status: 400,
            error: { message: 'The source file could not be parsed.' },
          }));
        }
        return of(
          documentRead({
            id: `document-${file.name}`,
            filename: file.name,
          }),
        );
      },
    );
    store.chooseFiles([pdfFile('good.pdf'), pdfFile('bad.pdf')]);

    store.uploadDocuments();
    flushReactive();

    expect(store.uploadItems().map((item) => item.status)).toEqual([
      'uploaded',
      'failed',
    ]);
    expect(store.canUpload()).toBe(true);

    uploadedNames.length = 0;
    const failedItem = store.uploadItems().find(
      (item) => item.file.name === 'bad.pdf',
    );
    if (failedItem === undefined) {
      throw new Error('Expected the failed upload item.');
    }
    store.retryUploadItem(failedItem.id);
    flushReactive();

    expect(uploadedNames).toEqual(['bad.pdf']);
    expect(store.uploadItems().map((item) => item.status)).toEqual([
      'uploaded',
      'uploaded',
    ]);
    expect(store.failedUploadCount()).toBe(0);
    expect(store.activeDocumentId()).toBe('document-bad.pdf');
  });

  it('aborts an upload and persists its operation tombstone', () => {
    const store = TestBed.inject(SourceImportStore);
    const activeUpload = deferred<DocumentRead>();
    let operationId = '';
    apiClient.uploadDocument.mockImplementation(
      (
        _projectId: string,
        _body: FormData,
        options: { headers?: Record<string, string>; signal?: AbortSignal },
      ) => {
        operationId = options.headers?.['X-Cert-Prep-Operation-Id'] ?? '';
        options.signal?.addEventListener(
          'abort',
          () => activeUpload.reject(new DOMException('canceled', 'AbortError')),
          { once: true },
        );
        return activeUpload.observable;
      },
    );
    store.chooseFile(pdfFile('cancel-me.pdf'));
    const item = store.uploadItems()[0];
    if (item === undefined) {
      throw new Error('Expected the selected upload item.');
    }

    store.uploadDocuments();
    flushReactive();
    store.cancelUploadItem(item.id);

    expect(apiClient.cancelDocumentOperation).toHaveBeenCalledWith(
      'project-1',
      operationId,
    );
    expect(store.uploadItems()[0]?.status).toBe('canceled');
    const requestOptions = apiClient.uploadDocument.mock.calls[0]?.[2] as {
      headers?: Record<string, string>;
    };
    expect(requestOptions.headers?.['X-Cert-Prep-Operation-Id']).toBe(
      operationId,
    );
  });

  it('serializes transcript mutations to prevent duplicate and overlapping requests', () => {
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
    apiClient.updateDocumentChunk.mockReturnValue(editRequest.observable);
    store.updateTranscriptChunk(chunk.id, 'edited');
    store.updateTranscriptChunk(chunk.id, 'duplicate');
    store.translateTranscriptChunk(chunk.id);
    store.translateStaleTranscriptChunks();
    flushReactive();

    expect(apiClient.updateDocumentChunk).toHaveBeenCalledTimes(1);
    expect(apiClient.translateDocumentChunk).not.toHaveBeenCalled();
    expect(apiClient.translateDocumentStaleChunks).not.toHaveBeenCalled();
    editRequest.resolve({ ...chunk, text: 'edited' });
    flushReactive();

    const translateRequest = deferred<ChunkRead>();
    apiClient.translateDocumentChunk.mockReturnValue(translateRequest.observable);
    store.translateTranscriptChunk(chunk.id);
    store.translateTranscriptChunk(chunk.id);
    store.updateTranscriptChunk(chunk.id, 'blocked');
    store.translateStaleTranscriptChunks();
    flushReactive();

    expect(apiClient.translateDocumentChunk).toHaveBeenCalledTimes(1);
    expect(apiClient.updateDocumentChunk).toHaveBeenCalledTimes(1);
    expect(apiClient.translateDocumentStaleChunks).not.toHaveBeenCalled();
    translateRequest.resolve({ ...chunk, translated_text: 'translated' });
    flushReactive();

    const bulkRequest = deferred<{ items: ChunkRead[] }>();
    apiClient.translateDocumentStaleChunks.mockReturnValue(bulkRequest.observable);
    store.translateStaleTranscriptChunks();
    store.translateStaleTranscriptChunks();
    store.updateTranscriptChunk(chunk.id, 'blocked');
    store.translateTranscriptChunk(chunk.id);
    flushReactive();

    expect(apiClient.translateDocumentStaleChunks).toHaveBeenCalledTimes(1);
    expect(apiClient.updateDocumentChunk).toHaveBeenCalledTimes(1);
    expect(apiClient.translateDocumentChunk).toHaveBeenCalledTimes(1);
    bulkRequest.resolve({ items: [{ ...chunk, translated_text: 'translated' }] });
    flushReactive();
  });

  it('refreshes document translation metadata after transcript mutations', () => {
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
      translated_text: 'existing',
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
    apiClient.updateDocumentChunk.mockReturnValue(of(editedChunk));
    apiClient.getDocument.mockReturnValueOnce(of(failedTranslationDocument));

    store.updateTranscriptChunk(chunk.id, editedChunk.text);
    flushReactive();

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
    apiClient.translateDocumentChunk.mockReturnValue(of(translatedChunk));
    apiClient.getDocument.mockReturnValueOnce(of(translatedDocument));

    store.translateTranscriptChunk(chunk.id);
    flushReactive();

    expect(store.chunks()[0]).toEqual(translatedChunk);
    expect(store.activeDocument()?.translation_status).toBe('succeeded');

    apiClient.translateDocumentStaleChunks.mockReturnValue(of({
      items: [translatedChunk],
    }));
    apiClient.getDocument.mockReturnValueOnce(of(translatedDocument));

    store.translateStaleTranscriptChunks();
    flushReactive();

    expect(apiClient.getDocument).toHaveBeenCalledTimes(3);
    expect(store.documents()[0]?.translation_status).toBe('succeeded');
  });

  it('keeps a successful transcript mutation visible when metadata refresh fails', () => {
    const store = TestBed.inject(SourceImportStore);
    const operations = TestBed.inject(OperationStore);
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
      translated_text: 'existing',
      translation_source_revision: 1,
      translation_stale: false,
    });
    const editedChunk = {
      ...chunk,
      text: '更新後的日文',
      source_revision: 2,
      translation_stale: true,
    };
    const metadataError = new Error('Document metadata unavailable');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    store.documents.set([document]);
    store.setActiveDocumentId(document.id);
    store.chunks.set([chunk]);
    apiClient.updateDocumentChunk.mockReturnValue(of(editedChunk));
    apiClient.getDocument.mockReturnValueOnce(throwError(() => metadataError));

    store.updateTranscriptChunk(chunk.id, editedChunk.text);
    flushReactive();

    expect(store.chunks()[0]).toEqual(editedChunk);
    expect(store.activeDocument()).toEqual(document);
    expect(operations.status()).toBe('Japanese transcript saved');
    expect(operations.error()).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      'Unable to refresh document metadata after a transcript mutation.',
      metadataError,
    );
  });

  it('stops polling and allows retry after audio transcription fails', () => {
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
    apiClient.getDocument.mockReturnValue(of(failedDocument));

    store.refreshUploadedDocument('project-1', failedDocument.id);
    flushReactive();
    vi.advanceTimersByTime(5_000);

    expect(apiClient.getDocument).toHaveBeenCalledTimes(1);
    expect(store.parseStageText()).toContain('transcription failed');

    store.retryActiveDocumentProcessing();
    flushReactive();

    expect(apiClient.retryDocumentProcessing).toHaveBeenCalledWith(
      'project-1',
      failedDocument.id,
      { signal: expect.any(AbortSignal) },
    );
  });
});

function documentOperation(
  status: string,
  overrides: Record<string, unknown> = {},
) {
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
    ...overrides,
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

function flushReactive(): void {
  for (let index = 0; index < 3; index += 1) {
    TestBed.tick();
    TestBed.flushEffects();
    vi.runAllTicks();
  }
}

function flushUploadQueue(): void {
  vi.advanceTimersByTime(0);
  flushReactive();
}

function deferred<T>(): {
  readonly observable: Subject<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  const observable = new Subject<T>();
  return {
    observable,
    resolve: (value) => {
      observable.next(value);
      observable.complete();
    },
    reject: (error) => observable.error(error),
  };
}
