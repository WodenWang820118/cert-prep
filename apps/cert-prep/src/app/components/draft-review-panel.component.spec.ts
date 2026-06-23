import { TestBed } from '@angular/core/testing';
import {
  DocumentRead,
  DraftGenerationJobRead,
  CERT_PREP_API,
  ProjectRead,
} from '../cert-prep-api';
import { DraftReviewStore } from '../stores/draft-review/draft-review.store';
import { ProjectStore } from '../stores/project.store';
import { SourceImportStore } from '../stores/source-import/source-import.store';
import { DraftReviewPanelComponent } from './draft-review-panel.component';

describe('DraftReviewPanelComponent', () => {
  const apiClient = {
    generateDocumentDrafts: vi.fn(),
    listDocumentDraftJobs: vi.fn(),
    listQuestionDrafts: vi.fn(),
    retryDocumentDraftJobs: vi.fn(),
    updateQuestionDraft: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    await TestBed.configureTestingModule({
      imports: [DraftReviewPanelComponent],
      providers: [{ provide: CERT_PREP_API, useValue: apiClient }],
    }).compileComponents();
  });

  it('renders streaming question job progress as a live status', () => {
    const projects = TestBed.inject(ProjectStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const drafts = TestBed.inject(DraftReviewStore);
    projects.projects.set([projectRead()]);
    projects.select('project-1');
    sourceImport.uploadedDocument.set(documentRead());
    drafts.draftJobs.set([draftJob({ status: 'running' })]);

    const fixture = TestBed.createComponent(DraftReviewPanelComponent);
    fixture.detectChanges();

    const liveRegion = fixture.nativeElement.querySelector(
      '[aria-live="polite"]',
    ) as HTMLElement | null;
    expect(liveRegion?.textContent).toContain('Generating 1/1');
    expect(liveRegion?.textContent).toContain('0 questions ready so far.');
  });

  it('renders retry action when streaming question jobs are blocked', () => {
    const projects = TestBed.inject(ProjectStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const drafts = TestBed.inject(DraftReviewStore);
    projects.projects.set([projectRead()]);
    projects.select('project-1');
    sourceImport.uploadedDocument.set(documentRead());
    drafts.draftJobs.set([draftJob({ status: 'skipped_missing_model' })]);

    const fixture = TestBed.createComponent(DraftReviewPanelComponent);
    fixture.detectChanges();

    const retryButton = fixture.nativeElement.querySelector(
      'button',
    ) as HTMLButtonElement | null;
    expect(fixture.nativeElement.textContent).toContain('Model missing');
    expect(retryButton?.textContent).toContain('Retry generation');
  });
});

function projectRead(): ProjectRead {
  return {
    id: 'project-1',
    name: 'JLPT Prep',
    description: 'Local prep',
    created_at: '2026-06-09T00:00:00Z',
    updated_at: '2026-06-09T00:00:00Z',
  };
}

function documentRead(overrides: Partial<DocumentRead> = {}): DocumentRead {
  return {
    id: 'document-1',
    project_id: 'project-1',
    filename: 'jlpt-n1.pdf',
    sha256: 'document-sha',
    language_hint: 'ja',
    page_count: 46,
    has_text: true,
    status: 'ready',
    extraction_method: 'paddle_ocr_gpu',
    ocr_device: 'gpu:0',
    ocr_fallback_reason: null,
    ocr_duration_ms: 26513,
    processed_page_count: 46,
    parse_wall_duration_ms: 0,
    render_duration_ms: 0,
    ocr_engine_duration_ms: 26513,
    ocr_worker_count: 1,
    first_chunk_ms: 0,
    exam_item_count: 0,
    content_profile: 'vocabulary_single_questions',
    classification_detail: '{"profile":"vocabulary_single_questions"}',
    chunks_count: 46,
    created_at: '2026-06-09T00:00:00Z',
    updated_at: '2026-06-09T00:00:00Z',
    ...overrides,
  };
}

function draftJob(
  overrides: Partial<DraftGenerationJobRead> = {},
): DraftGenerationJobRead {
  return {
    id: 'job-1',
    project_id: 'project-1',
    document_id: 'document-1',
    chunk_id: 'chunk-1',
    page_number: 1,
    strategy: 'hybrid_reasoning',
    status: 'pending',
    provider: 'ollama',
    model: 'qwen3.5:4b',
    generated_count: 0,
    retry_count: 0,
    last_error: null,
    created_at: '2026-06-09T00:00:00Z',
    updated_at: '2026-06-09T00:00:00Z',
    ...overrides,
  };
}
