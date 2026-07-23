import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { provideRouter, Router } from '@angular/router';
import { App } from './app.component';
import { appRoutes } from '../../constants/app-routes.constants';
import { CERT_PREP_API } from '../../constants/cert-prep-api.constants';
import {
  appDocument,
  appProject,
  buttonByText,
  editableAppQuestion,
  availableLlmHealth,
  availableOcrHealth,
  backendHealth,
  emptyWrongAnswerSummary,
} from '../../testing/app.spec-helpers';
import { OperationStore } from '../../stores/operation.store';
import { provideCertPrepHttpResourceClientFake } from '../../testing/cert-prep-http-resource-client.fake';

describe('App', () => {
  let apiClient: ReturnType<typeof createApiClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    apiClient = createApiClient();

    TestBed.configureTestingModule({
      imports: [App],
      providers: [
        { provide: CERT_PREP_API, useValue: apiClient },
        provideCertPrepHttpResourceClientFake(apiClient),
        provideRouter(appRoutes),
      ],
    });
  });

  it('renders compact runtime status and route-backed page navigation', () => {
    const fixture = TestBed.createComponent(App);
    const router = TestBed.inject(Router);
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('Cert Prep');
    expect(compiled.textContent).toContain('Create project');
    expect(linkByText(compiled, 'Build')).not.toBeNull();
    expect(linkByText(compiled, 'Full Exam')).not.toBeNull();
    expect(linkByText(compiled, 'Random Quiz')).not.toBeNull();
    expect(linkByText(compiled, 'Dashboard')).not.toBeNull();
    expect(linkByText(compiled, 'Review')).not.toBeNull();

    router.navigateByUrl('/build');
    fixture.detectChanges();
    TestBed.tick();
    return vi
      .waitFor(() => {
        fixture.detectChanges();
        expect(compiled.textContent).toContain('Python 3.13.5');
        expect(compiled.textContent).toContain('Reasoning model: reasoner:7b');
        expect(compiled.textContent).toContain('fake');
        expect(compiled.textContent).toContain('Source files');
        expect(compiled.textContent).toContain('Mock Exam Items');
        expect(compiled.textContent).not.toContain('Wrong Answers');
      })
      .then(() => {
        router.navigateByUrl('/full-exam');
        fixture.detectChanges();
        TestBed.tick();
        return vi.waitFor(() => {
          fixture.detectChanges();
          expect(compiled.textContent).toContain('Source Document');
          expect(compiled.textContent).toContain('security.pdf');
          expect(compiled.textContent).toContain('Start full exam');
          expect(compiled.textContent).not.toContain('Source files');
        });
      })
      .then(() => {
        router.navigateByUrl('/random-quiz');
        fixture.detectChanges();
        TestBed.tick();
        return vi.waitFor(() => {
          fixture.detectChanges();
          expect(compiled.textContent).toContain('Random Draw');
          expect(compiled.textContent).toContain('Start random quiz');
        });
      })
      .then(() => {
        router.navigateByUrl('/dashboard');
        fixture.detectChanges();
        TestBed.tick();
        return vi.waitFor(() => {
          fixture.detectChanges();
          expect(compiled.textContent).toContain('Project weakness analysis');
          expect(compiled.textContent).not.toContain('Wrong Answers');
        });
      })
      .then(() => {
        router.navigateByUrl('/review');
        fixture.detectChanges();
        TestBed.tick();
        return vi.waitFor(() => {
          fixture.detectChanges();
          expect(compiled.textContent).toContain('Wrong Answers');
        });
      });
  });

  it('does not render routine operation success as a global strip', () => {
    const fixture = TestBed.createComponent(App);
    const operations = TestBed.inject(OperationStore);
    operations.status.set('Project saved');
    fixture.detectChanges();

    const status = (fixture.nativeElement as HTMLElement).querySelector(
      '[role="status"]',
    );
    expect(status).toBeNull();
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain(
      'Project saved',
    );
  });

  it('keeps shell placeholder controls disabled and exposes packaged legal links', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(buttonByLabel(compiled, 'Settings')?.disabled).toBe(true);
    expect(buttonByLabel(compiled, 'Account')?.disabled).toBe(true);

    const footerLinks = Array.from(
      compiled.querySelectorAll<HTMLAnchorElement>('.workbench-footer-link'),
    );
    expect(footerLinks.map((link) => link.textContent?.trim())).toEqual([
      'Documentation',
      'Privacy Policy',
      'License',
      'Third-Party Notices',
      'Changelog',
    ]);
    for (const link of footerLinks) {
      expect(link.getAttribute('href')).toMatch(/^legal\//);
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener');
    }
  });

  it('identifies the unsigned public alpha and exposes verification guidance', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    const aboutButton = buttonByLabel(compiled, 'About Cert Prep');
    expect(aboutButton?.disabled).toBe(false);
    aboutButton?.click();
    fixture.detectChanges();

    const dialog = compiled.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain('unsigned_public_alpha');
    expect(dialog?.textContent).toContain('Cert Prep 0.1.0-alpha.1');
    expect(dialog?.textContent).toContain('SmartScreen');
    expect(dialog?.textContent).toContain('SHA-256');
    expect(dialog?.textContent).toContain(
      'Source files, generated questions, practice answers',
    );
    if (dialog === null) {
      throw new Error('Expected the About dialog to be open.');
    }

    buttonByLabel(dialog, 'Close About Cert Prep')?.click();
    fixture.detectChanges();
    expect(compiled.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders the runtime route before a project exists', () => {
    apiClient.listProjects.mockReturnValueOnce(of({ items: [] }));
    const fixture = TestBed.createComponent(App);
    const router = TestBed.inject(Router);
    const compiled = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();

    router.navigateByUrl('/runtime');
    fixture.detectChanges();
    TestBed.tick();
    return vi.waitFor(() => {
      fixture.detectChanges();
      expect(compiled.textContent).toContain('Manage runtime');
      expect(compiled.textContent).toContain('Python backend');
      expect(
        compiled.querySelector('[aria-label="Close runtime manager"]'),
      ).toBeNull();
      expect(buttonByText(compiled, 'Cancel')).toBeNull();
      expect(compiled.textContent).not.toContain('Select or create a project.');
    });
  });

  it('opens the topbar runtime manager as an accessible modal dialog', () => {
    const fixture = TestBed.createComponent(App);
    const compiled = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();

    const manageRuntimeButton = buttonByText(compiled, 'Manage runtime');
    expect(manageRuntimeButton).not.toBeNull();

    manageRuntimeButton?.focus();
    manageRuntimeButton?.click();
    fixture.detectChanges();
    TestBed.tick();
    return vi.waitFor(() => {
      const dialog = compiled.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog).not.toBeNull();
      expect(dialog?.getAttribute('aria-modal')).toBe('true');
      expect(dialog?.getAttribute('aria-labelledby')).toBe(
        'runtime-manager-modal-title',
      );
      expect(compiled.querySelector('#runtime-manager-modal-title')?.textContent)
        .toContain('Manage runtime');
      expect(document.activeElement).toBe(
        dialog?.querySelector('[aria-label="Close runtime manager"]'),
      );
      expect(
        dialog
          ?.querySelector('.runtime-manager-backdrop')
          ?.getAttribute('tabindex'),
      ).toBe('-1');
    }).then(() => {
      const dialog = compiled.querySelector<HTMLElement>('[role="dialog"]');
      dialog?.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }),
      );
      fixture.detectChanges();
      expect(compiled.querySelector('[role="dialog"]')).toBeNull();
    });
  });
});

function linkByText(root: ParentNode, text: string): HTMLAnchorElement | null {
  return (
    Array.from(root.querySelectorAll('a')).find((link) =>
      link.textContent?.includes(text),
    ) ?? null
  );
}

function buttonByLabel(root: ParentNode, label: string): HTMLButtonElement | null {
  return root.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
}

function createApiClient() {
  return {
    health: vi.fn().mockReturnValue(of({
      ...backendHealth(),
    })),
    llmHealth: vi.fn().mockReturnValue(of(availableLlmHealth())),
    ocrHealth: vi.fn().mockReturnValue(of(availableOcrHealth())),
    runtimeRequirements: vi.fn().mockReturnValue(of({ items: [] })),
    startRuntimeInstallation: vi.fn(),
    getRuntimeInstallation: vi.fn(),
    listProjects: vi.fn().mockReturnValue(of({ items: [appProject] })),
    listDocuments: vi.fn().mockReturnValue(of({ items: [appDocument] })),
    getDocument: vi.fn().mockReturnValue(of(appDocument)),
    listDocumentChunks: vi.fn().mockReturnValue(of({ items: [] })),
    listQuestionDrafts: vi.fn().mockReturnValue(of({ items: [editableAppQuestion] })),
    listWrongAnswers: vi.fn().mockReturnValue(of({ items: [] })),
    summarizeWrongAnswers: vi.fn().mockReturnValue(of(emptyWrongAnswerSummary())),
  };
}
