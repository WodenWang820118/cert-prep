import { TestBed } from '@angular/core/testing';
import { DocumentRead, EXAM_PREP_API } from '../exam-prep-api';
import { ProjectStore } from '../stores/project.store';
import { SourceImportStore } from '../stores/source-import.store';
import { SourceImportPanelComponent } from './source-import-panel.component';

describe('SourceImportPanelComponent', () => {
  const apiClient = {
    generateDocumentDrafts: vi.fn(),
    listQuestionDrafts: vi.fn(),
    uploadDocument: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();

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
