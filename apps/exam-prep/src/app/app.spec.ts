import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { EXAM_PREP_API } from './exam-prep-api';

describe('App', () => {
  const project = {
    id: 'project-1',
    name: 'Security Study',
    description: 'Local exam prep',
    created_at: '2026-06-17T00:00:00Z',
    updated_at: '2026-06-17T00:00:00Z',
  };
  const document = {
    id: 'document-1',
    project_id: project.id,
    filename: 'security.pdf',
    sha256: 'abc123',
    language_hint: 'en',
    page_count: 12,
    has_text: true,
    status: 'ready',
    extraction_method: 'text',
    ocr_device: null,
    ocr_fallback_reason: null,
    ocr_duration_ms: 0,
    processed_page_count: 12,
    exam_item_count: 1,
    chunks_count: 6,
    created_at: '2026-06-17T00:00:00Z',
    updated_at: '2026-06-17T00:00:00Z',
  };
  const draft = {
    id: 'draft-1',
    project_id: project.id,
    document_id: document.id,
    chunk_id: 'chunk-1',
    question: 'Which principle limits permissions?',
    choices: ['Least privilege', 'Privilege sprawl'],
    answer: 'Least privilege',
    answer_key_source: 'manual',
    rationale: 'Permissions stay scoped.',
    citation_page: 2,
    source_excerpt: 'Least privilege limits access.',
    status: 'approved',
    rejection_reason: null,
    created_at: '2026-06-17T00:00:00Z',
    updated_at: '2026-06-17T00:00:00Z',
  };
  const apiClient = {
    health: vi.fn().mockResolvedValue({
      status: 'ok',
      app: 'exam-prep-backend',
      version: '0.1.0',
      python_version: '3.13.5',
      runtime_mode: 'source',
    }),
    llmHealth: vi.fn().mockResolvedValue({
      provider: 'fake',
      model: 'reasoner:7b',
      available: true,
      detail: 'deterministic local fake provider',
      unavailable_reason: null,
    }),
    ocrHealth: vi.fn().mockResolvedValue({
      provider: 'fake',
      engine: 'none',
      available: true,
      detail: 'deterministic local fake OCR provider',
      python_version: '3.13.5',
      paddle_version: null,
      paddleocr_version: null,
      selected_device: null,
      cuda_available: false,
      gpu_count: 0,
      model_cache_dir: null,
      fallback_reason: null,
      unavailable_reason: null,
    }),
    runtimeRequirements: vi.fn().mockResolvedValue({ items: [] }),
    listProjects: vi.fn().mockResolvedValue({ items: [project] }),
    listDocuments: vi.fn().mockResolvedValue({ items: [document] }),
    getDocument: vi.fn().mockResolvedValue(document),
    listDocumentChunks: vi.fn().mockResolvedValue({ items: [] }),
    listQuestionDrafts: vi.fn().mockResolvedValue({ items: [draft] }),
    listWrongAnswers: vi.fn().mockResolvedValue({ items: [] }),
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    await TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: EXAM_PREP_API, useValue: apiClient }],
    }).compileComponents();
  });

  it('renders compact runtime status and project mode navigation', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(compiled.textContent).toContain('Python 3.13.5');
      expect(compiled.textContent).toContain('Reasoning model: reasoner:7b');
      expect(compiled.textContent).toContain('fake');
    });

    expect(compiled.querySelector('h1')?.textContent).toContain('Exam Prep');
    expect(compiled.textContent).toContain('Create project');
    expect(buttonByText(compiled, 'Build')).not.toBeNull();
    expect(buttonByText(compiled, 'Full Exam')).not.toBeNull();
    expect(buttonByText(compiled, 'Random Quiz')).not.toBeNull();
    expect(buttonByText(compiled, 'Review')).not.toBeNull();
    expect(compiled.textContent).toContain('Source PDF');
    expect(compiled.textContent).toContain('Mock Exam Items');
    expect(compiled.textContent).not.toContain('Wrong Answers');

    buttonByText(compiled, 'Full Exam')?.click();
    fixture.detectChanges();

    expect(compiled.textContent).toContain('Parsed document');
    expect(compiled.textContent).toContain('security.pdf');
    expect(compiled.textContent).toContain('Start full exam');
    expect(compiled.textContent).not.toContain('Source PDF');

    buttonByText(compiled, 'Random Quiz')?.click();
    fixture.detectChanges();

    expect(compiled.textContent).toContain('Approved items');
    expect(compiled.textContent).toContain('Start random quiz');

    buttonByText(compiled, 'Review')?.click();
    fixture.detectChanges();

    expect(compiled.textContent).toContain('Wrong Answers');
  });
});

function buttonByText(
  root: ParentNode,
  text: string,
): HTMLButtonElement | null {
  return (
    Array.from(root.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(text),
    ) ?? null
  );
}
