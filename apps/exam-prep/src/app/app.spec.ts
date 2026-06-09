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
    });

    expect(compiled.querySelector('h1')?.textContent).toContain('Exam Prep');
    expect(compiled.textContent).toContain('Create project');
  });
});
