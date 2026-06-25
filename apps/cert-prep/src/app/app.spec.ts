import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { App } from './app';
import { appRoutes } from './app.routes';
import { CERT_PREP_API } from './cert-prep-api';
import {
  appDocument,
  appProject,
  editableAppQuestion,
  availableLlmHealth,
  availableOcrHealth,
  backendHealth,
} from './app.spec-helpers';

describe('App', () => {
  let apiClient: ReturnType<typeof createApiClient>;

  beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    apiClient = createApiClient();

    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        { provide: CERT_PREP_API, useValue: apiClient },
        provideRouter(appRoutes),
      ],
    }).compileComponents();
  });

  it('renders compact runtime status and route-backed page navigation', async () => {
    const fixture = TestBed.createComponent(App);
    const router = TestBed.inject(Router);
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(compiled.textContent).toContain('Python 3.13.5');
      expect(compiled.textContent).toContain('Reasoning model: reasoner:7b');
      expect(compiled.textContent).toContain('fake');
    });

    expect(compiled.querySelector('h1')?.textContent).toContain('Cert Prep');
    expect(compiled.textContent).toContain('Create project');
    expect(linkByText(compiled, 'Build')).not.toBeNull();
    expect(linkByText(compiled, 'Full Exam')).not.toBeNull();
    expect(linkByText(compiled, 'Random Quiz')).not.toBeNull();
    expect(linkByText(compiled, 'Review')).not.toBeNull();

    await router.navigateByUrl('/build');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(compiled.textContent).toContain('Source PDF');
    expect(compiled.textContent).toContain('Mock Exam Items');
    expect(compiled.textContent).not.toContain('Wrong Answers');

    await router.navigateByUrl('/full-exam');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(compiled.textContent).toContain('Parsed document');
    expect(compiled.textContent).toContain('security.pdf');
    expect(compiled.textContent).toContain('Start full exam');
    expect(compiled.textContent).not.toContain('Source PDF');

    await router.navigateByUrl('/random-quiz');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(compiled.textContent).toContain('Questions');
    expect(compiled.textContent).toContain('Start random quiz');

    await router.navigateByUrl('/review');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(compiled.textContent).toContain('Wrong Answers');
  });

  it('renders the runtime route before a project exists', async () => {
    apiClient.listProjects.mockResolvedValueOnce({ items: [] });
    const fixture = TestBed.createComponent(App);
    const router = TestBed.inject(Router);
    const compiled = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();

    await router.navigateByUrl('/runtime');
    fixture.detectChanges();
    await fixture.whenStable();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(compiled.textContent).toContain('Manage runtime');
      expect(compiled.textContent).toContain('Python backend');
    });
    expect(compiled.textContent).not.toContain('Select or create a project.');
  });
});

function linkByText(root: ParentNode, text: string): HTMLAnchorElement | null {
  return (
    Array.from(root.querySelectorAll('a')).find((link) =>
      link.textContent?.includes(text),
    ) ?? null
  );
}

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
