import { TestBed } from '@angular/core/testing';
import { DocumentRead, CERT_PREP_API, OCRHealthRead } from '../../cert-prep-api';
import { HealthStore } from '../../stores/health/health.store';
import { OperationStore } from '../../stores/operation.store';
import { ProjectStore } from '../../stores/project.store';
import { SourceImportStore } from '../../stores/source-import/source-import.store';
import { SourceImportPanelComponent } from './source-import-panel.component';

describe('SourceImportPanelComponent', () => {
  const apiClient = {
    generateDocumentDrafts: vi.fn(),
    getDocument: vi.fn(),
    listDocumentChunks: vi.fn(),
    listQuestionDrafts: vi.fn(),
    uploadDocument: vi.fn(),
  };

  beforeEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
    apiClient.getDocument.mockResolvedValue(documentRead());
    apiClient.listDocumentChunks.mockResolvedValue({ items: [] });
    apiClient.listQuestionDrafts.mockResolvedValue({ items: [] });

    await TestBed.configureTestingModule({
      imports: [SourceImportPanelComponent],
      providers: [{ provide: CERT_PREP_API, useValue: apiClient }],
    }).compileComponents();

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
    vi.useRealTimers();
  });

  it('renders parsing metrics when the document carries timing fields', () => {
    const fixture = TestBed.createComponent(SourceImportPanelComponent);
    const sourceImport = TestBed.inject(SourceImportStore);
    activateDocument(
      sourceImport,
      documentRead({
        parse_wall_time_ms: 1234,
        render_time_ms: 456,
        ocr_engine_time_ms: 789,
        worker_count: 4,
        first_chunk_time_ms: 111,
      }),
    );

    fixture.detectChanges();

    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Parse wall time');
    expect(text).toContain('1234 ms');
    expect(text).toContain('Render time');
    expect(text).toContain('456 ms');
    expect(text).toContain('OCR engine time');
    expect(text).toContain('789 ms');
    expect(text).toContain('Worker count');
    expect(text).toContain('4');
    expect(text).toContain('First chunk time');
    expect(text).toContain('111 ms');
  });

  it('hides parsing metrics that are absent from older document payloads', () => {
    const fixture = TestBed.createComponent(SourceImportPanelComponent);
    const sourceImport = TestBed.inject(SourceImportStore);
    activateDocument(sourceImport, documentRead({ ocr_duration_ms: 0 }));

    fixture.detectChanges();

    const text = fixture.nativeElement.textContent;
    expect(text).not.toContain('Parse wall time');
    expect(text).not.toContain('Render time');
    expect(text).not.toContain('Worker count');
    expect(text).not.toContain('First chunk time');
  });

  it('renders complete ready documents at 100 percent progress', () => {
    const fixture = TestBed.createComponent(SourceImportPanelComponent);
    const sourceImport = TestBed.inject(SourceImportStore);
    activateDocument(
      sourceImport,
      documentRead({
        chunks_count: 8,
        processed_page_count: 7,
        status: 'ready',
      }),
    );

    fixture.detectChanges();

    expect(sourceImport.progressPercent()).toBe(100);
    expect(sourceImport.progressLabel()).toBe('8/8 pages');
    expect(fixture.nativeElement.textContent).toContain('8/8 pages / 8 chunks');
  });

  it('renders the project document library and refreshes the selected document', async () => {
    const fixture = TestBed.createComponent(SourceImportPanelComponent);
    const sourceImport = TestBed.inject(SourceImportStore);
    const firstDocument = documentRead({ id: 'document-1', filename: 'first.pdf' });
    const secondDocument = documentRead({
      id: 'document-2',
      filename: 'second.pdf',
      chunks_count: 3,
    });
    sourceImport.documents.set([firstDocument, secondDocument]);
    sourceImport.setActiveDocumentId(firstDocument.id);
    apiClient.getDocument.mockResolvedValue(secondDocument);
    apiClient.listDocumentChunks.mockResolvedValue({
      items: [
        {
          id: 'chunk-2',
          document_id: secondDocument.id,
          page_number: 1,
          chunk_index: 0,
          text: 'Second document text',
          raw_text: 'Second document text',
          line_start: 1,
          line_end: 1,
          line_count: 1,
          source_excerpt: 'Second document text',
          extraction_method: 'paddle_ocr_gpu',
          content_profile: 'unknown',
          created_at: '2026-06-18T00:00:01Z',
        },
      ],
    });

    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(
      'Project document library',
    );
    const selector = documentSelector(fixture.nativeElement);
    expect(selector).not.toBeNull();
    await (
      fixture.componentInstance as unknown as {
        selectDocument(documentId: string): Promise<void>;
      }
    ).selectDocument(secondDocument.id);
    fixture.detectChanges();

    expect(apiClient.getDocument).toHaveBeenCalledWith(
      'project-1',
      secondDocument.id,
    );
    expect(sourceImport.activeDocumentId()).toBe(secondDocument.id);
    expect(sourceImport.chunks()[0]?.document_id).toBe(secondDocument.id);
  });

  it('shows an actionable document polling error and retries status', async () => {
    const fixture = TestBed.createComponent(SourceImportPanelComponent);
    const sourceImport = TestBed.inject(SourceImportStore);
    const processing = documentRead({
      filename: 'polling-error.pdf',
      status: 'processing',
      has_text: false,
      chunks_count: 0,
    });
    activateDocument(sourceImport, processing);
    sourceImport.documentPollingError.set(
      'Document status could not be refreshed. Retry status.',
    );
    apiClient.getDocument.mockResolvedValue(
      documentRead({ id: processing.id, filename: processing.filename }),
    );

    fixture.detectChanges();

    const alert = fixture.nativeElement.querySelector('[role="alert"]');
    const retry = fixture.nativeElement.querySelector(
      'button[aria-label="Retry document status for polling-error.pdf"]',
    ) as HTMLButtonElement | null;
    expect(alert?.textContent).toContain(
      'Document status could not be refreshed. Retry status.',
    );
    expect(fixture.nativeElement.textContent).toContain('status unavailable');
    expect(retry?.textContent?.trim()).toBe('Retry status');

    retry?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(apiClient.getDocument).toHaveBeenCalledWith(
      'project-1',
      processing.id,
    );
    expect(sourceImport.documentPollingError()).toBeNull();
    expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows the active uploaded document file size after a batch upload', () => {
    const fixture = TestBed.createComponent(SourceImportPanelComponent);
    const sourceImport = TestBed.inject(SourceImportStore);
    const firstDocument = documentRead({ id: 'document-small', filename: 'small.pdf' });
    const secondDocument = documentRead({
      id: 'document-large',
      filename: 'large.pdf',
    });
    const smallFile = new File(['%PDF-1.7'], 'small.pdf', {
      type: 'application/pdf',
    });
    const largeFile = new File([new Uint8Array(2 * 1024 * 1024)], 'large.pdf', {
      type: 'application/pdf',
    });
    sourceImport.uploadItems.set([
      {
        id: 'source-upload-1',
        file: smallFile,
        status: 'uploaded',
        document: firstDocument,
        error: null,
      },
      {
        id: 'source-upload-2',
        file: largeFile,
        status: 'uploaded',
        document: secondDocument,
        error: null,
      },
    ]);
    sourceImport.documents.set([firstDocument, secondDocument]);
    sourceImport.setActiveDocumentId(secondDocument.id);

    fixture.detectChanges();

    expect(metricValue(fixture.nativeElement, 'File Size')).toBe('2.0 MB');
  });

  it('does not reuse a selected file size for an unrelated library document', () => {
    const fixture = TestBed.createComponent(SourceImportPanelComponent);
    const sourceImport = TestBed.inject(SourceImportStore);
    const document = documentRead({
      id: 'document-library',
      filename: 'library.pdf',
    });
    sourceImport.uploadItems.set([
      {
        id: 'source-upload-1',
        file: new File([new Uint8Array(2 * 1024 * 1024)], 'new-selection.pdf', {
          type: 'application/pdf',
        }),
        status: 'queued',
        document: null,
        error: null,
      },
    ]);
    sourceImport.documents.set([document]);
    sourceImport.setActiveDocumentId(document.id);

    fixture.detectChanges();

    expect(metricValue(fixture.nativeElement, 'File Size')).toBe('-');
  });

  it('renders selected, uploaded, and failed PDF states from a multiple file input', async () => {
    const fixture = TestBed.createComponent(SourceImportPanelComponent);
    const sourceImport = TestBed.inject(SourceImportStore);
    apiClient.uploadDocument.mockImplementation(
      (_projectId: string, body: FormData) => {
        const file = body.get('file') as File;
        if (file.name === 'failed.pdf') {
          return Promise.reject({
            status: 422,
            error: { message: 'Invalid PDF' },
          });
        }
        return Promise.resolve(
          documentRead({
            id: 'document-uploaded',
            filename: file.name,
            chunks_count: 4,
          }),
        );
      },
    );
    sourceImport.chooseFiles([
      new File(['%PDF-1.7'], 'uploaded.pdf', { type: 'application/pdf' }),
      new File(['not a pdf'], 'failed.pdf', { type: 'application/pdf' }),
    ]);

    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector(
      '#sourcePdfFile',
    ) as HTMLInputElement | null;
    expect(input?.multiple).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('2 PDFs selected');
    expect(fixture.nativeElement.textContent).toContain('Queued');

    await sourceImport.uploadDocuments();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent;
    expect(uploadButton(fixture.nativeElement)?.textContent).toContain(
      'Upload PDF',
    );
    expect(text).toContain('uploaded.pdf');
    expect(text).toContain('failed.pdf');
    expect(text).toContain('Uploaded');
    expect(text).toContain('Failed');
    expect(text).toContain('Invalid PDF');
  });

  it('exposes accessible per-row Cancel and Retry actions', async () => {
    const fixture = TestBed.createComponent(SourceImportPanelComponent);
    const sourceImport = TestBed.inject(SourceImportStore);
    sourceImport.uploadItems.set([
      {
        id: 'source-upload-cancel',
        file: new File(['%PDF-1.7'], 'cancel-me.pdf', {
          type: 'application/pdf',
        }),
        status: 'queued',
        document: null,
        error: null,
      },
      {
        id: 'source-upload-retry',
        file: new File(['broken'], 'retry-me.pdf', {
          type: 'application/pdf',
        }),
        status: 'failed',
        document: null,
        error: 'Invalid PDF',
      },
    ]);

    fixture.detectChanges();

    const cancel = fixture.nativeElement.querySelector(
      'button[aria-label="Cancel upload of cancel-me.pdf"]',
    ) as HTMLButtonElement | null;
    const retry = fixture.nativeElement.querySelector(
      'button[aria-label="Retry upload of retry-me.pdf"]',
    ) as HTMLButtonElement | null;
    expect(cancel?.textContent?.trim()).toBe('Cancel');
    expect(retry?.textContent?.trim()).toBe('Retry');

    cancel?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(sourceImport.uploadItems()[0]?.status).toBe('canceled');
    expect(fixture.nativeElement.textContent).toContain('Canceled');
  });

  it('exposes document-owned OCR cancellation in the active card', async () => {
    const fixture = TestBed.createComponent(SourceImportPanelComponent);
    const sourceImport = TestBed.inject(SourceImportStore);
    const processing = documentRead({
      id: 'document-processing',
      filename: 'processing.pdf',
      status: 'processing',
      has_text: false,
      chunks_count: 0,
    });
    const cancelProcessing = vi
      .spyOn(sourceImport, 'cancelDocumentProcessing')
      .mockResolvedValue(true);
    sourceImport.uploadItems.set([
      {
        id: 'source-upload-processing',
        file: new File(['%PDF-1.7'], processing.filename, {
          type: 'application/pdf',
        }),
        status: 'uploaded',
        document: processing,
        error: null,
      },
    ]);
    activateDocument(sourceImport, processing);

    fixture.detectChanges();

    const cancelButtons = fixture.nativeElement.querySelectorAll(
      'button[aria-label="Cancel OCR for processing.pdf"]',
    ) as NodeListOf<HTMLButtonElement>;
    expect(cancelButtons).toHaveLength(1);
    expect(fixture.nativeElement.textContent).toContain('OCR: Processing');
    expect(
      fixture.nativeElement.querySelector(
        'button[aria-label="Retry upload of processing.pdf"]',
      ),
    ).toBeNull();

    cancelButtons[0]?.click();
    await fixture.whenStable();

    expect(cancelProcessing).toHaveBeenCalledWith(processing.id);
  });

  it('exposes document-owned OCR cancellation for a non-active upload row', async () => {
    const fixture = TestBed.createComponent(SourceImportPanelComponent);
    const sourceImport = TestBed.inject(SourceImportStore);
    const active = documentRead({
      id: 'document-active-cancel',
      filename: 'active-cancel.pdf',
      status: 'ready',
    });
    const processing = documentRead({
      id: 'document-row-processing',
      filename: 'row-processing.pdf',
      status: 'processing',
      has_text: false,
      chunks_count: 0,
    });
    const cancelProcessing = vi
      .spyOn(sourceImport, 'cancelDocumentProcessing')
      .mockResolvedValue(true);
    sourceImport.uploadItems.set([
      {
        id: 'source-upload-row-processing',
        file: new File(['%PDF-1.7'], processing.filename, {
          type: 'application/pdf',
        }),
        status: 'uploaded',
        document: processing,
        error: null,
      },
    ]);
    sourceImport.documents.set([active, processing]);
    sourceImport.setActiveDocumentId(active.id);

    fixture.detectChanges();

    const cancel = fixture.nativeElement.querySelector(
      'button[aria-label="Cancel OCR for row-processing.pdf"]',
    ) as HTMLButtonElement | null;
    expect(cancel?.textContent?.trim()).toBe('Cancel OCR');

    cancel?.click();
    await fixture.whenStable();

    expect(cancelProcessing).toHaveBeenCalledWith(processing.id);
  });

  it('routes canceled documents to OCR retry instead of upload retry', async () => {
    const fixture = TestBed.createComponent(SourceImportPanelComponent);
    const sourceImport = TestBed.inject(SourceImportStore);
    const canceled = documentRead({
      id: 'document-canceled',
      filename: 'retry-ocr.pdf',
      status: 'canceled',
      has_text: false,
      chunks_count: 0,
    });
    const active = documentRead({
      id: 'document-active-retry',
      filename: 'active-retry.pdf',
      status: 'ready',
    });
    const retryProcessing = vi
      .spyOn(sourceImport, 'retryDocumentProcessing')
      .mockResolvedValue(true);
    sourceImport.uploadItems.set([
      {
        id: 'source-upload-canceled',
        file: new File(['%PDF-1.7'], canceled.filename, {
          type: 'application/pdf',
        }),
        status: 'canceled',
        document: canceled,
        error: null,
      },
    ]);
    sourceImport.documents.set([active, canceled]);
    sourceImport.setActiveDocumentId(active.id);

    fixture.detectChanges();

    const retryButtons = fixture.nativeElement.querySelectorAll(
      'button[aria-label="Retry OCR for retry-ocr.pdf"]',
    ) as NodeListOf<HTMLButtonElement>;
    expect(retryButtons).toHaveLength(1);
    expect(
      fixture.nativeElement.querySelector(
        'button[aria-label="Retry upload of retry-ocr.pdf"]',
      ),
    ).toBeNull();

    retryButtons[0]?.click();
    await fixture.whenStable();

    expect(retryProcessing).toHaveBeenCalledWith(canceled.id);
  });

  it('keeps OCR action errors separate and exposes status reconciliation', async () => {
    const fixture = TestBed.createComponent(SourceImportPanelComponent);
    const sourceImport = TestBed.inject(SourceImportStore);
    const document = documentRead({
      id: 'document-status-unavailable',
      filename: 'status-unavailable.pdf',
      status: 'processing',
      has_text: false,
      chunks_count: 0,
    });
    const error = 'OCR retry status is unavailable. Retry status.';
    const retryStatus = vi
      .spyOn(sourceImport, 'retryDocumentActionStatus')
      .mockResolvedValue(true);
    vi.spyOn(sourceImport, 'canRetryDocumentActionStatus').mockReturnValue(true);
    vi.spyOn(sourceImport, 'canCancelDocumentProcessing').mockReturnValue(false);
    sourceImport.documentProcessingActions.set(
      new Map([
        [
          document.id,
          {
            kind: 'retry',
            status: 'status_unavailable',
            cancellable: true,
            error,
          } as const,
        ],
      ]),
    );
    sourceImport.uploadItems.set([
      {
        id: 'source-upload-status-unavailable',
        file: new File(['%PDF-1.7'], document.filename, {
          type: 'application/pdf',
        }),
        status: 'uploaded',
        document,
        error: null,
      },
    ]);
    activateDocument(sourceImport, document);

    fixture.detectChanges();

    const alert = fixture.nativeElement.querySelector('[role="alert"]');
    const retryButtons = fixture.nativeElement.querySelectorAll(
      'button[aria-label="Retry OCR status for status-unavailable.pdf"]',
    ) as NodeListOf<HTMLButtonElement>;
    expect(alert?.textContent).toContain(error);
    expect(retryButtons).toHaveLength(1);
    expect(fixture.nativeElement.textContent).toContain(
      'OCR: Status unavailable',
    );

    retryButtons[0]?.click();
    await fixture.whenStable();

    expect(retryStatus).toHaveBeenCalledWith(document.id);
  });

  it('shows a non-active document action error in its upload row', () => {
    const fixture = TestBed.createComponent(SourceImportPanelComponent);
    const sourceImport = TestBed.inject(SourceImportStore);
    const active = documentRead({
      id: 'document-active',
      filename: 'active.pdf',
      status: 'ready',
    });
    const failed = documentRead({
      id: 'document-failed',
      filename: 'failed-ocr.pdf',
      status: 'ocr_failed',
      has_text: false,
      chunks_count: 0,
    });
    const error = 'OCR retry failed before processing could restart.';
    sourceImport.documentProcessingActions.set(
      new Map([
        [
          failed.id,
          {
            kind: 'retry',
            status: 'failed',
            cancellable: false,
            error,
          } as const,
        ],
      ]),
    );
    sourceImport.uploadItems.set([
      {
        id: 'source-upload-failed-ocr',
        file: new File(['%PDF-1.7'], failed.filename, {
          type: 'application/pdf',
        }),
        status: 'uploaded',
        document: failed,
        error: null,
      },
    ]);
    sourceImport.documents.set([active, failed]);
    sourceImport.setActiveDocumentId(active.id);

    fixture.detectChanges();

    const alerts = Array.from(
      fixture.nativeElement.querySelectorAll('[role="alert"]'),
    ) as HTMLElement[];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toContain(error);
    expect(fixture.nativeElement.textContent).toContain('OCR: Action failed');
  });

  it('lets the user adjust the upload batch size', async () => {
    const fixture = TestBed.createComponent(SourceImportPanelComponent);
    const sourceImport = TestBed.inject(SourceImportStore);

    fixture.detectChanges();
    await fixture.whenStable();

    const selector = batchSizeSelector(fixture.nativeElement);
    expect(selector).not.toBeNull();
    if (selector === null) {
      throw new Error('Batch size selector was not rendered.');
    }
    expect(selector?.value).toBe('2');

    selector.value = '3';
    selector.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(sourceImport.uploadBatchSize()).toBe(3);
  });

  it('keeps the file chooser disabled while a batch upload is in flight', async () => {
    const fixture = TestBed.createComponent(SourceImportPanelComponent);
    const sourceImport = TestBed.inject(SourceImportStore);
    let resolveUpload!: (document: DocumentRead) => void;
    apiClient.uploadDocument.mockReturnValue(
      new Promise<DocumentRead>((resolve) => {
        resolveUpload = resolve;
      }),
    );
    sourceImport.chooseFiles([
      new File(['%PDF-1.7'], 'busy.pdf', { type: 'application/pdf' }),
    ]);

    const uploadPromise = sourceImport.uploadDocuments();
    await Promise.resolve();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector(
      '#sourcePdfFile',
    ) as HTMLInputElement | null;
    const chooser = fixture.nativeElement.querySelector(
      'label.workbench-secondary-button',
    ) as HTMLLabelElement | null;
    expect(input?.disabled).toBe(true);
    expect(chooser?.getAttribute('for')).toBeNull();
    (
      fixture.componentInstance as unknown as {
        chooseFiles(event: Event): void;
      }
    ).chooseFiles({
      target: {
        files: [
          new File(['%PDF-1.7'], 'replacement.pdf', {
            type: 'application/pdf',
          }),
        ],
      },
    } as unknown as Event);
    expect(sourceImport.selectedFile()?.name).toBe('busy.pdf');

    resolveUpload(documentRead({ id: 'document-busy', filename: 'busy.pdf' }));
    await uploadPromise;
  });

  it('keeps upload disabled while runtime health is waiting for first OCR status', async () => {
    const fixture = TestBed.createComponent(SourceImportPanelComponent);
    const health = TestBed.inject(HealthStore);
    const operations = TestBed.inject(OperationStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    health.healthSnapshotLoading.set(true);
    sourceImport.chooseFiles([
      new File(['%PDF-1.7'], 'runtime.pdf', { type: 'application/pdf' }),
    ]);

    fixture.detectChanges();

    expect(health.isOcrHealthLoading()).toBe(true);
    expect(sourceImport.canUpload()).toBe(false);
    expect(uploadButton(fixture.nativeElement)?.disabled).toBe(true);

    await sourceImport.uploadDocuments();

    expect(apiClient.uploadDocument).not.toHaveBeenCalled();
    expect(operations.error()).toBe(
      'OCR runtime is warming up. Try again when runtime health finishes.',
    );
  });

  it('keeps upload available when OCR is known and LLM health is still settling', () => {
    const fixture = TestBed.createComponent(SourceImportPanelComponent);
    const health = TestBed.inject(HealthStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    health.ocrHealth.set(ocrHealth());
    health.healthSnapshotLoading.set(true);
    sourceImport.chooseFiles([
      new File(['%PDF-1.7'], 'runtime.pdf', { type: 'application/pdf' }),
    ]);

    fixture.detectChanges();

    expect(health.isOcrHealthLoading()).toBe(false);
    expect(sourceImport.canUpload()).toBe(true);
    expect(uploadButton(fixture.nativeElement)?.disabled).toBe(false);
  });

  it('polls faster only until the first source chunk is visible', async () => {
    vi.useFakeTimers();
    TestBed.createComponent(SourceImportPanelComponent);
    const sourceImport = TestBed.inject(SourceImportStore);
    activateDocument(
      sourceImport,
      documentRead({ status: 'processing', chunks_count: 0 }),
    );
    apiClient.getDocument
      .mockResolvedValueOnce(documentRead({ status: 'processing', chunks_count: 0 }))
      .mockResolvedValueOnce(documentRead({ status: 'processing', chunks_count: 1 }))
      .mockResolvedValueOnce(documentRead({ status: 'processing', chunks_count: 1 }));
    apiClient.listDocumentChunks
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValue({
        items: [
          {
            id: 'chunk-1',
            document_id: 'document-1',
            page_number: 1,
            chunk_index: 0,
            text: 'First chunk',
            raw_text: 'First chunk',
            line_start: 1,
            line_end: 1,
            line_count: 1,
            source_excerpt: 'First chunk',
            extraction_method: 'paddle_ocr_gpu',
            content_profile: 'unknown',
            created_at: '2026-06-18T00:00:01Z',
          },
        ],
      });

    await sourceImport.refreshUploadedDocument('project-1', 'document-1');

    expect(apiClient.getDocument).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(apiClient.getDocument).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(apiClient.getDocument).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1499);
    expect(apiClient.getDocument).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(apiClient.getDocument).toHaveBeenCalledTimes(3);
  });
});

function documentRead(
  overrides: Partial<DocumentRead> & Record<string, unknown> = {},
): DocumentRead {
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
    exam_item_count: 0,
    content_profile: 'unknown',
    classification_detail: '',
    chunks_count: 8,
    created_at: '2026-06-18T00:00:00Z',
    updated_at: '2026-06-18T00:00:01Z',
    ...overrides,
  } as DocumentRead;
}

function ocrHealth(): OCRHealthRead {
  return {
    provider: 'paddle',
    engine: 'paddleocr',
    available: true,
    detail: 'PaddleOCR imports available',
    python_version: '3.13.5',
    paddle_version: '3.3.0',
    paddleocr_version: '3.6.0',
    selected_device: 'gpu:0',
    cuda_available: true,
    gpu_count: 1,
    model_cache_dir: null,
    fallback_reason: null,
    unavailable_reason: null,
  };
}

function uploadButton(root: ParentNode): HTMLButtonElement | null {
  return (
    Array.from(root.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Upload PDF'),
    ) ?? null
  );
}

function documentSelector(root: ParentNode): HTMLSelectElement | null {
  return (
    Array.from(root.querySelectorAll('select')).find((select) =>
      select.textContent?.includes('second.pdf'),
    ) ?? null
  );
}

function batchSizeSelector(root: ParentNode): HTMLSelectElement | null {
  return (
    Array.from(root.querySelectorAll('label.workbench-field')).find((label) =>
      label.textContent?.includes('Batch size'),
    )?.querySelector('select') ?? null
  );
}

function metricValue(root: ParentNode, label: string): string | null {
  const metric = Array.from(root.querySelectorAll('.workbench-metric')).find(
    (item) => item.querySelector('dt')?.textContent?.trim() === label,
  );
  return metric?.querySelector('dd')?.textContent?.trim() ?? null;
}

function activateDocument(
  sourceImport: SourceImportStore,
  document: DocumentRead,
): void {
  sourceImport.documents.set([document]);
  sourceImport.setActiveDocumentId(document.id);
}
