import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { provideRouter, Router } from '@angular/router';
import { App } from './app.component';
import { appRoutes } from '../../constants/app-routes.constants';
import { CERT_PREP_API } from '../../constants/cert-prep-api.constants';
import {
  appDocument,
  appProject,
  editableAppQuestion,
  availableLlmHealth,
  availableOcrHealth,
  backendHealth,
  emptyWrongAnswerSummary,
} from '../../testing/app.spec-helpers';
import { DesktopRuntimeBridgeService } from '../../stores/desktop-runtime/desktop-runtime-bridge.service';
import type { DesktopRuntimeStatus } from '../../stores/desktop-runtime/contracts/desktop-runtime.contracts';
import { OperationStore } from '../../stores/operation.store';
import { ProjectStore } from '../../stores/project.store';
import { WorkspaceFacade } from '../../stores/workspace.facade';
import { provideCertPrepHttpResourceClientFake } from '../../testing/cert-prep-http-resource-client.fake';

describe('App runtime loading', () => {
  let apiClient: ReturnType<typeof createApiClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
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

  it('reloads backend state after runtime startup becomes ready', () => {
    const fixture = TestBed.createComponent(App);
    const operations = TestBed.inject(OperationStore);
    const workspace = TestBed.inject(WorkspaceFacade);
    fixture.detectChanges();

    TestBed.tick();
    return vi
      .waitFor(() => {
        fixture.detectChanges();
        expect(workspace.hasLoadedBackendState()).toBe(true);
        expect(operations.status()).toBe('Project loaded');
      })
      .then(() => {
        vi.clearAllMocks();
        operations.status.set('Python backend runtime is required.');
        workspace.hasLoadedBackendState.set(false);
        fixture.detectChanges();

        TestBed.tick();
        return vi.waitFor(() => {
          fixture.detectChanges();
          expect(operations.status()).toBe('Project loaded');
          expect(operations.status()).not.toBe(
            'Python backend runtime is required.',
          );
          expect(apiClient.health).toHaveBeenCalledTimes(1);
          expect(apiClient.runtimeRequirements).toHaveBeenCalledTimes(1);
        });
      });
  });

  it('loads projects even when optional runtime health is temporarily unavailable', () => {
    apiClient.runtimeRequirements.mockReturnValueOnce(
      throwError(() => new Error('runtime requirements unavailable')),
    );

    const fixture = TestBed.createComponent(App);
    const projects = TestBed.inject(ProjectStore);
    const operations = TestBed.inject(OperationStore);
    fixture.detectChanges();

    TestBed.tick();
    return vi.waitFor(() => {
      fixture.detectChanges();
      expect(projects.projects()).toEqual([appProject]);
      expect(projects.selectedProjectId()).toBe(appProject.id);
      expect(operations.status()).toBe('Project loaded');
      expect(operations.status()).not.toBe(
        'Python backend runtime is required.',
      );
    });
  });
});

describe('App desktop runtime recovery routes', () => {
  let apiClient: ReturnType<typeof createApiClient>;
  let desktopRuntimeBridge: {
    isDesktop: ReturnType<typeof vi.fn>;
    invoke: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    apiClient = createApiClient();
    desktopRuntimeBridge = {
      isDesktop: vi.fn().mockReturnValue(true),
      invoke: vi.fn().mockReturnValue(of(missingPythonRuntimeStatus())),
    };

    TestBed.configureTestingModule({
      imports: [App],
      providers: [
        { provide: CERT_PREP_API, useValue: apiClient },
        provideCertPrepHttpResourceClientFake(apiClient),
        { provide: DesktopRuntimeBridgeService, useValue: desktopRuntimeBridge },
        provideRouter(appRoutes),
      ],
    });
  });

  it('redirects study routes to runtime management when the Python backend runtime is missing', () => {
    const fixture = TestBed.createComponent(App);
    const router = TestBed.inject(Router);
    const compiled = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();

    router.navigateByUrl('/build');
    fixture.detectChanges();
    TestBed.tick();
    return vi.waitFor(() => {
      fixture.detectChanges();
      expect(router.url).toBe('/runtime');
      expect(compiled.textContent).toContain('Manage runtime');
      expect(compiled.textContent).toContain('Install runtime');
      expect(compiled.textContent).toContain(
        'Python backend runtime is missing.',
      );
      expect(compiled.textContent).not.toContain('Source files');
    });
  });

  it('renders the runtime route and install action when the Python backend runtime is missing', () => {
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
      expect(compiled.textContent).toContain('Install runtime');
      expect(compiled.textContent).toContain(
        'Python backend runtime is missing.',
      );
    });
  });
});

function createApiClient() {
  return {
    health: vi.fn().mockReturnValue(of(backendHealth())),
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
    listActivePracticeSessions: vi.fn().mockReturnValue(of({ items: [] })),
    listWrongAnswers: vi.fn().mockReturnValue(of({ items: [] })),
    summarizeWrongAnswers: vi.fn().mockReturnValue(of(emptyWrongAnswerSummary())),
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
