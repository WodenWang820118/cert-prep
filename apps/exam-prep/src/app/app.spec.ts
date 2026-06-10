import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { EXAM_PREP_API } from './exam-prep-api';

describe('App', () => {
  const apiClient = {
    llmHealth: vi.fn().mockResolvedValue({
      provider: 'fake',
      model: 'gemma4:12b',
      available: true,
      detail: 'deterministic local fake provider',
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
    }),
    listProjects: vi.fn().mockResolvedValue({ items: [] }),
    listQuestionDrafts: vi.fn().mockResolvedValue({ items: [] }),
    listWrongAnswers: vi.fn().mockResolvedValue({ items: [] }),
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    await TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: EXAM_PREP_API, useValue: apiClient }],
    }).compileComponents();
  });

  it('renders the local practice workspace', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(compiled.textContent).toContain('fake / gemma4:12b');
      expect(compiled.textContent).toContain('fake / none');
    });

    expect(compiled.querySelector('h1')?.textContent).toContain('Exam Prep');
    expect(compiled.textContent).toContain('Create project');
  });
});
