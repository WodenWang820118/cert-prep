import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { EXAM_PREP_API } from './exam-prep-api';
import {
  appDocument,
  appProject,
  editableAppQuestion,
  availableLlmHealth,
  availableOcrHealth,
  backendHealth,
  buttonByText,
} from './app.spec-helpers';

describe('App', () => {
  let apiClient: ReturnType<typeof createApiClient>;

  beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    apiClient = createApiClient();

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

    expect(compiled.textContent).toContain('Questions');
    expect(compiled.textContent).toContain('Start random quiz');

    buttonByText(compiled, 'Review')?.click();
    fixture.detectChanges();

    expect(compiled.textContent).toContain('Wrong Answers');
  });
});

function createApiClient() {
  return {
    health: vi.fn().mockResolvedValue({
      ...backendHealth(),
    }),
    llmHealth: vi.fn().mockResolvedValue(availableLlmHealth()),
    ocrHealth: vi.fn().mockResolvedValue(availableOcrHealth()),
    runtimeRequirements: vi.fn().mockResolvedValue({ items: [] }),
    startRuntimeInstallation: vi.fn(),
    getRuntimeInstallation: vi.fn(),
    listProjects: vi.fn().mockResolvedValue({ items: [appProject] }),
    listDocuments: vi.fn().mockResolvedValue({ items: [appDocument] }),
    getDocument: vi.fn().mockResolvedValue(appDocument),
    listDocumentChunks: vi.fn().mockResolvedValue({ items: [] }),
    listQuestionDrafts: vi.fn().mockResolvedValue({ items: [editableAppQuestion] }),
    listWrongAnswers: vi.fn().mockResolvedValue({ items: [] }),
  };
}
