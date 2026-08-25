import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CERT_PREP_API } from '../../constants/cert-prep-api.constants';
import type {
  DocumentRead,
  DraftGenerationJobRead,
  ProjectRead,
  QuestionDraftRead,
} from '../../contracts/api.contracts';
import { DraftReviewStore } from '../../stores/draft-review/draft-review.store';
import { manualDraftOperation } from '../../stores/draft-review/draft-review.store.spec-helpers';
import { OperationStore } from '../../stores/operation.store';
import { ProjectStore } from '../../stores/project.store';
import { SourceImportStore } from '../../stores/source-import/source-import.store';
import { DraftReviewPanelComponent } from './draft-review-panel.component';

describe('DraftReviewPanelComponent', () => {
  const apiClient = {
    generateDocumentDrafts: vi.fn(),
    listDocumentDraftJobs: vi.fn(),
    listQuestionDrafts: vi.fn(),
    retryDocumentDraftJobs: vi.fn(),
    updateQuestionDraft: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      imports: [DraftReviewPanelComponent],
      providers: [
        { provide: CERT_PREP_API, useValue: apiClient },
        provideRouter([]),
      ],
    });
  });

  it('guides the user when no source with text is ready', () => {
    const fixture = TestBed.createComponent(DraftReviewPanelComponent);

    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain(
      'Add a source file with text before generating questions.',
    );
    expect(text).toContain('No questions are ready yet.');
  });

  it('shows human-only preparation status without generation telemetry', () => {
    const projects = TestBed.inject(ProjectStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const drafts = TestBed.inject(DraftReviewStore);
    projects.projects.set([projectRead()]);
    projects.select('project-1');
    activateDocument(sourceImport, documentRead());
    drafts.draftJobs.set([draftJob({ status: 'running' })]);

    const fixture = TestBed.createComponent(DraftReviewPanelComponent);
    fixture.detectChanges();

    const status = fixture.nativeElement.querySelector(
      '[data-testid="draft-generation-status"]',
    ) as HTMLElement;
    const text = status.textContent as string;
    expect(text).toContain('Preparing questions...');
    expect(text).not.toContain('Generating 1/1');
    expect(text).not.toContain('questions ready so far');
    expect(text).not.toContain('ollama');
    expect(text).not.toContain('qwen3.5:4b');
    expect(text).not.toContain('job-1');
    expect(text).not.toContain('phase');
  });

  it('shows a human retry state for failed generation without raw details', () => {
    const projects = TestBed.inject(ProjectStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const drafts = TestBed.inject(DraftReviewStore);
    projects.projects.set([projectRead()]);
    projects.select('project-1');
    activateDocument(sourceImport, documentRead());
    drafts.draftJobs.set([
      draftJob({
        status: 'skipped_missing_model',
        last_error: 'internal model detail',
      }),
    ]);

    const fixture = TestBed.createComponent(DraftReviewPanelComponent);
    fixture.detectChanges();

    const status = fixture.nativeElement.querySelector(
      '[data-testid="draft-generation-status"]',
    ) as HTMLElement;
    expect(status.textContent).toContain('Could not prepare questions. Retry.');
    expect(status.querySelector('[data-testid="draft-retry"]')).not.toBeNull();
    expect(status.textContent).not.toContain('Model missing');
    expect(status.textContent).not.toContain('internal model detail');
  });

  it('renders editable question content and source evidence without internal fields', () => {
    const projects = TestBed.inject(ProjectStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const drafts = TestBed.inject(DraftReviewStore);
    projects.projects.set([projectRead()]);
    projects.select('project-1');
    activateDocument(sourceImport, documentRead());
    drafts.drafts.set([questionDraft()]);

    const fixture = TestBed.createComponent(DraftReviewPanelComponent);
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Which answer is supported by the source?');
    expect(text).toContain('The source supports A.');
    expect(text).toContain('The cited source supports answer A.');
    expect(text).toContain('Page 1');
    expect(text).toContain('Answer');
    expect(text).toContain('Ready for practice');
    expect(text).not.toContain('draft-1');
    expect(text).not.toContain('ai_inferred');
    expect(text).not.toContain('rejection_reason');
  });

  it('does not render a question without source grounding', () => {
    const projects = TestBed.inject(ProjectStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const drafts = TestBed.inject(DraftReviewStore);
    projects.projects.set([projectRead()]);
    projects.select('project-1');
    activateDocument(sourceImport, documentRead());
    drafts.drafts.set([
      questionDraft({
        question: 'Question without document evidence',
        citation_page: null,
        source_excerpt: null,
      }),
    ]);

    const fixture = TestBed.createComponent(DraftReviewPanelComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).not.toContain(
      'Question without document evidence',
    );
    expect(fixture.nativeElement.textContent).toContain(
      'No questions are ready yet.',
    );
  });

  it('does not render a source-grounded draft without a source item number', () => {
    const projects = TestBed.inject(ProjectStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const drafts = TestBed.inject(DraftReviewStore);
    projects.projects.set([projectRead()]);
    projects.select('project-1');
    activateDocument(sourceImport, documentRead());
    drafts.drafts.set([
      questionDraft({
        question: 'Placeholder inferred from a source chunk',
        source_question_number: null,
      }),
    ]);

    const fixture = TestBed.createComponent(DraftReviewPanelComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).not.toContain(
      'Placeholder inferred from a source chunk',
    );
    expect(fixture.nativeElement.textContent).toContain(
      'No questions are ready yet.',
    );
  });

  it('shows only source evidence for unavailable items', () => {
    const projects = TestBed.inject(ProjectStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const drafts = TestBed.inject(DraftReviewStore);
    projects.projects.set([projectRead()]);
    projects.select('project-1');
    activateDocument(sourceImport, documentRead());
    drafts.manualDraftOperation.set(
      manualDraftOperation({
        status: 'succeeded',
        phase: 'completed',
        generated_count: 1,
        unavailable_blocks: [
          {
            status: 'needs_review',
            chunk_id: 'chunk-2',
            citation_page: 8,
            source_excerpt: 'Question source',
            source_order: 20002,
            source_question_number: '2',
            reason: 'Capture Runtime returned no playable answer.',
          },
        ],
      }),
    );

    const fixture = TestBed.createComponent(DraftReviewPanelComponent);
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Page 8');
    expect(text).toContain('Question source');
    expect(text).not.toContain('Capture Runtime returned no playable answer.');
    expect(text).not.toContain('completed');
    expect(text).not.toContain('generated_count');
  });

  it('keeps the visible questions scoped to the active document', () => {
    const projects = TestBed.inject(ProjectStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const drafts = TestBed.inject(DraftReviewStore);
    const firstDocument = documentRead({
      id: 'document-1',
      filename: 'first.pdf',
    });
    const secondDocument = documentRead({
      id: 'document-2',
      filename: 'second.pdf',
    });
    projects.projects.set([projectRead()]);
    projects.select('project-1');
    sourceImport.documents.set([firstDocument, secondDocument]);
    sourceImport.setActiveDocumentId(secondDocument.id);
    drafts.drafts.set([
      questionDraft({ id: 'active-draft', document_id: secondDocument.id }),
      questionDraft({
        id: 'other-draft',
        document_id: firstDocument.id,
        question: 'Question from another PDF',
      }),
    ]);

    const fixture = TestBed.createComponent(DraftReviewPanelComponent);
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Which answer is supported by the source?');
    expect(text).not.toContain('Question from another PDF');
    expect(text).not.toContain('active-draft');
  });

  it('shows the save result and a clear random-quiz next step', () => {
    const projects = TestBed.inject(ProjectStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const drafts = TestBed.inject(DraftReviewStore);
    const operations = TestBed.inject(OperationStore);
    projects.projects.set([projectRead()]);
    projects.select('project-1');
    activateDocument(sourceImport, documentRead());
    drafts.drafts.set([questionDraft()]);
    operations.status.set('Question saved');

    const fixture = TestBed.createComponent(DraftReviewPanelComponent);
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('[data-testid="draft-save-result"]')
        ?.textContent,
    ).toContain('Question saved.');
    const practiceLink = fixture.nativeElement.querySelector(
      '[data-testid="draft-practice-link"]',
    ) as HTMLAnchorElement;
    expect(practiceLink.textContent).toContain('Practice questions');
    expect(practiceLink.getAttribute('href')).toBe('/random-quiz');
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
    extraction_method: 'windowsml_ocr',
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
    phase: 'queued',
    cancellable: true,
    provider: 'ollama',
    model: 'qwen3.5:4b',
    effective_provider: null,
    effective_model: null,
    fallback_reason: null,
    generated_count: 0,
    retry_count: 0,
    last_error: null,
    created_at: '2026-06-09T00:00:00Z',
    updated_at: '2026-06-09T00:00:00Z',
    ...overrides,
  };
}

function questionDraft(
  overrides: Partial<QuestionDraftRead> = {},
): QuestionDraftRead {
  return {
    id: 'draft-1',
    project_id: 'project-1',
    document_id: 'document-1',
    chunk_id: 'chunk-1',
    question: 'Which answer is supported by the source?',
    choices: ['A', 'B'],
    answer: 'A',
    answer_key_source: 'ai_inferred',
    rationale: 'The source supports A.',
    citation_page: 1,
    source_excerpt: 'The cited source supports answer A.',
    confidence: null,
    source_order: 10001,
    source_question_number: '1',
    item_kind: 'vocabulary_single',
    group_key: null,
    group_prompt: null,
    status: 'approved',
    rejection_reason: null,
    created_at: '2026-06-09T00:00:00Z',
    updated_at: '2026-06-09T00:00:00Z',
    ...overrides,
  };
}

function activateDocument(
  sourceImport: SourceImportStore,
  document: DocumentRead,
): void {
  sourceImport.documents.set([document]);
  sourceImport.setActiveDocumentId(document.id);
}
