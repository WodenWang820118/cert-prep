import { TestBed } from '@angular/core/testing';
import { DocumentRead, EXAM_PREP_API, OCRHealthRead } from '../../exam-prep-api';
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

    await TestBed.configureTestingModule({
      imports: [SourceImportPanelComponent],
      providers: [{ provide: EXAM_PREP_API, useValue: apiClient }],
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
    sourceImport.uploadedDocument.set(
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
    sourceImport.uploadedDocument.set(documentRead({ ocr_duration_ms: 0 }));

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
    sourceImport.uploadedDocument.set(
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

  it('keeps upload disabled while runtime health is waiting for first OCR status', async () => {
    const fixture = TestBed.createComponent(SourceImportPanelComponent);
    const health = TestBed.inject(HealthStore);
    const operations = TestBed.inject(OperationStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    health.healthSnapshotLoading.set(true);
    sourceImport.chooseFile(
      new File(['%PDF-1.7'], 'runtime.pdf', { type: 'application/pdf' }),
    );

    fixture.detectChanges();

    expect(health.isOcrHealthLoading()).toBe(true);
    expect(sourceImport.canUpload()).toBe(false);
    expect(uploadButton(fixture.nativeElement)?.disabled).toBe(true);

    await sourceImport.uploadDocument();

    expect(apiClient.uploadDocument).not.toHaveBeenCalled();
    expect(operations.error()).toBe(
      'PaddleOCR is warming up. Try again when runtime health finishes.',
    );
  });

  it('keeps upload available when OCR is known and LLM health is still settling', () => {
    const fixture = TestBed.createComponent(SourceImportPanelComponent);
    const health = TestBed.inject(HealthStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    health.ocrHealth.set(ocrHealth());
    health.healthSnapshotLoading.set(true);
    sourceImport.chooseFile(
      new File(['%PDF-1.7'], 'runtime.pdf', { type: 'application/pdf' }),
    );

    fixture.detectChanges();

    expect(health.isOcrHealthLoading()).toBe(false);
    expect(sourceImport.canUpload()).toBe(true);
    expect(uploadButton(fixture.nativeElement)?.disabled).toBe(false);
  });

  it('polls faster only until the first source chunk is visible', async () => {
    vi.useFakeTimers();
    TestBed.createComponent(SourceImportPanelComponent);
    const sourceImport = TestBed.inject(SourceImportStore);
    sourceImport.uploadedDocument.set(
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
