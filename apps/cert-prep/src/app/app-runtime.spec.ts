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
  emptyWrongAnswerSummary,
} from './app.spec-helpers';
import { DesktopRuntimeBridgeService } from './stores/desktop-runtime/desktop-runtime-bridge.service';
import type { DesktopRuntimeStatus } from './stores/desktop-runtime/contracts/desktop-runtime.contracts';
import { OperationStore } from './stores/operation.store';
import { ProjectStore } from './stores/project.store';
import { WorkspaceFacade } from './stores/workspace.facade';

describe('App runtime loading', () => {
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

  it('reloads backend state after runtime startup becomes ready', async () => {
    const fixture = TestBed.createComponent(App);
    const operations = TestBed.inject(OperationStore);
    const workspace = TestBed.inject(WorkspaceFacade);
    fixture.detectChanges();

    await vi.waitFor(() => expect(workspace.hasLoadedBackendState()).toBe(true));
    await vi.waitFor(() => expect(operations.status()).toBe('Project loaded'));

    vi.clearAllMocks();
    operations.status.set('Python backend runtime is required.');
    workspace.hasLoadedBackendState.set(false);
    fixture.detectChanges();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(operations.status()).toBe('Project loaded');
    });
    expect(operations.status()).not.toBe('Python backend runtime is required.');
    expect(apiClient.health).toHaveBeenCalledTimes(1);
    expect(apiClient.runtimeRequirements).toHaveBeenCalledTimes(1);
  });

  it('loads projects even when optional runtime health is temporarily unavailable', async () => {
    apiClient.runtimeRequirements.mockRejectedValueOnce(
      new Error('runtime requirements unavailable'),
    );

    const fixture = TestBed.createComponent(App);
    const projects = TestBed.inject(ProjectStore);
    const operations = TestBed.inject(OperationStore);
    fixture.detectChanges();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(projects.projects()).toEqual([appProject]);
      expect(projects.selectedProjectId()).toBe(appProject.id);
    });

    expect(operations.status()).toBe('Project loaded');
    expect(operations.status()).not.toBe('Python backend runtime is required.');
  });
});

describe('App desktop runtime recovery routes', () => {
  let apiClient: ReturnType<typeof createApiClient>;
  let desktopRuntimeBridge: {
    isDesktop: ReturnType<typeof vi.fn>;
    invoke: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    apiClient = createApiClient();
    desktopRuntimeBridge = {
      isDesktop: vi.fn().mockReturnValue(true),
      invoke: vi.fn().mockResolvedValue(missingPythonRuntimeStatus()),
    };

    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        { provide: CERT_PREP_API, useValue: apiClient },
        { provide: DesktopRuntimeBridgeService, useValue: desktopRuntimeBridge },
        provideRouter(appRoutes),
      ],
    }).compileComponents();
  });

  it('redirects study routes to runtime management when the Python backend runtime is missing', async () => {
    const fixture = TestBed.createComponent(App);
    const router = TestBed.inject(Router);
    const compiled = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();

    await router.navigateByUrl('/build');
    fixture.detectChanges();
    await fixture.whenStable();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(router.url).toBe('/runtime');
      expect(compiled.textContent).toContain('Manage runtime');
      expect(compiled.textContent).toContain('Install runtime');
    });
    expect(compiled.textContent).toContain(
      'Python backend runtime is missing.',
    );
    expect(compiled.textContent).not.toContain('Source PDF');
  });

  it('renders the runtime route and install action when the Python backend runtime is missing', async () => {
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
      expect(compiled.textContent).toContain('Install runtime');
    });
    expect(compiled.textContent).toContain(
      'Python backend runtime is missing.',
    );
  });
});

function createApiClient() {
  return {
    health: vi.fn().mockResolvedValue(backendHealth()),
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
    summarizeWrongAnswers: vi.fn().mockResolvedValue(emptyWrongAnswerSummary()),
  };
}

function missingPythonRuntimeStatus(): DesktopRuntimeStatus {
  return {
    kind: 'python_backend',
    label: 'Python backend',
    available: false,
    running: false,
    status: 'missing',
    detail: 'Python backend runtime is missing.',
    unavailableReason: 'python_runtime_missing',
  };
}
