import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import type { HealthResponse } from '../domain';
import { DesktopRuntimeStore } from '../../runtime/data/desktop-runtime.store';
import { HealthStore } from '../../runtime/data/health.store';
import { RuntimeManagerPage } from '../../runtime/feature/runtime-manager/runtime-manager.page';
import { provideRouter, Router } from '@angular/router';
import { App } from './app.component';
import { appRoutes } from './app-routes.constants';
import { CERT_PREP_API } from '../data';
import {
  appDocument,
  appProject,
  editableAppQuestion,
  availableLlmHealth,
  backendHealth,
  emptyWrongAnswerSummary,
} from '../testing';
import { DesktopRuntimeBridgeService } from '../../runtime/data/desktop-runtime-bridge.service';
import type { DesktopRuntimeStatus } from '../../runtime/domain';
import { OperationStore } from '../data';
import { ProjectStore } from '../../projects/data';
import { WorkspaceFacade } from './workspace.facade';
import { provideCertPrepHttpResourceClientFake } from '../testing';

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

  it.each(['success', 'failure'])(
    'reads preference after Refresh all health settles (%s)',
    async (outcome) => {
      const fixture = TestBed.createComponent(App);
      fixture.detectChanges();
      await TestBed.inject(Router).navigateByUrl('/runtime');
      await vi.waitFor(() => {
        fixture.detectChanges();
        TestBed.tick();
        expect(apiClient.llmDevicePreference).toHaveBeenCalled();
      });
      const healthResponse = new Subject<HealthResponse>();
      apiClient.health.mockReturnValueOnce(healthResponse);
      apiClient.llmDevicePreference.mockClear();
      const button = Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
      ).find((item) => item.textContent?.includes('Refresh all'));
      expect(button).toBeDefined();
      button?.click();
      fixture.detectChanges();
      TestBed.tick();
      expect(apiClient.llmDevicePreference).not.toHaveBeenCalled();
      if (outcome === 'success') {
        healthResponse.next(backendHealth());
        healthResponse.complete();
      } else {
        healthResponse.error(new Error('offline'));
      }
      await vi.waitFor(() => {
        TestBed.tick();
        expect(apiClient.llmDevicePreference).toHaveBeenCalledTimes(1);
      });
      fixture.destroy();
    },
  );

  it('never requests preference at app startup without the runtime manager', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await vi.waitFor(() => {
      TestBed.tick();
      expect(apiClient.health).toHaveBeenCalled();
    });
    expect(apiClient.llmDevicePreference).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it.each(['route leave', 'modal close'])(
    'stops following health after %s',
    async (exit) => {
      const fixture = TestBed.createComponent(RuntimeManagerPage);
      fixture.componentRef.setInput('modal', exit === 'modal close');
      fixture.detectChanges();
      TestBed.tick();
      expect(apiClient.llmDevicePreference).toHaveBeenCalledTimes(1);
      apiClient.llmDevicePreference.mockClear();
      if (exit === 'modal close') {
        const closeRequested = vi.fn();
        fixture.componentInstance.closeRequested.subscribe(closeRequested);
        (fixture.nativeElement as HTMLElement)
          .querySelector<HTMLButtonElement>(
            '[aria-label="Close runtime manager"]',
          )
          ?.click();
        expect(closeRequested).toHaveBeenCalledTimes(1);
      } else {
        fixture.destroy();
      }
      TestBed.inject(HealthStore).refresh();
      await vi.waitFor(() => {
        TestBed.tick();
        expect(apiClient.health).toHaveBeenCalled();
        expect(TestBed.inject(HealthStore).healthSnapshotLoading()).toBe(false);
      });
      expect(apiClient.llmDevicePreference).not.toHaveBeenCalled();
      if (exit === 'modal close') fixture.destroy();
    },
  );

  it('follows one completion when overlapping health refreshes are coalesced', async () => {
    const fixture = TestBed.createComponent(RuntimeManagerPage);
    fixture.detectChanges();
    TestBed.tick();
    apiClient.llmDevicePreference.mockClear();
    const response = new Subject<HealthResponse>();
    apiClient.health.mockReturnValue(response);
    const health = TestBed.inject(HealthStore);
    health.refresh();
    TestBed.tick();
    health.refresh();
    TestBed.tick();
    expect(apiClient.llmDevicePreference).not.toHaveBeenCalled();
    response.next(backendHealth());
    response.complete();
    await vi.waitFor(() => {
      TestBed.tick();
      expect(health.healthSnapshotLoading()).toBe(false);
      expect(apiClient.llmDevicePreference).toHaveBeenCalledTimes(1);
    });
    fixture.destroy();
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
        {
          provide: DesktopRuntimeBridgeService,
          useValue: desktopRuntimeBridge,
        },
        provideRouter(appRoutes),
      ],
    });
  });

  it('reloads preference after backend becomes ready with runtime manager already open', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await TestBed.inject(Router).navigateByUrl('/runtime');
    await vi.waitFor(() => {
      fixture.detectChanges();
      TestBed.tick();
      expect(apiClient.llmDevicePreference).toHaveBeenCalled();
    });
    apiClient.llmDevicePreference.mockClear();
    const response = new Subject<HealthResponse>();
    apiClient.health.mockReturnValueOnce(response);
    const ready = {
      ...missingPythonRuntimeStatus(),
      running: true,
      available: true,
      status: 'running',
    };
    desktopRuntimeBridge.invoke.mockReturnValue(of(ready));
    TestBed.inject(DesktopRuntimeStore).status.set(ready);
    await vi.waitFor(() => {
      fixture.detectChanges();
      TestBed.tick();
      expect(apiClient.health).toHaveBeenCalled();
    });
    expect(apiClient.llmDevicePreference).not.toHaveBeenCalled();
    response.next(backendHealth());
    response.complete();
    await vi.waitFor(() => {
      TestBed.tick();
      expect(apiClient.llmDevicePreference).toHaveBeenCalledTimes(1);
    });
    fixture.destroy();
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

describe('App runtime update notice', () => {
  it('shows the startup runtime update in the shell status region before the backend is ready', () => {
    vi.clearAllMocks();
    localStorage.clear();
    const apiClient = createApiClient();
    const invoke = vi.fn((command: string) =>
      command === 'runtime_update_status'
        ? of({
            phase: 'applying',
            runtimes: ['python_backend'],
            completed: 0,
            total: 1,
            estimatedSeconds: 3,
            error: null,
          })
        : of({
            ...missingPythonRuntimeStatus(),
            status: 'running',
            detail: 'Updating the Python backend runtime.',
            unavailableReason: 'python_runtime_installing',
          }),
    );
    TestBed.configureTestingModule({
      imports: [App],
      providers: [
        { provide: CERT_PREP_API, useValue: apiClient },
        provideCertPrepHttpResourceClientFake(apiClient),
        {
          provide: DesktopRuntimeBridgeService,
          useValue: { isDesktop: vi.fn().mockReturnValue(true), invoke },
        },
        provideRouter(appRoutes),
      ],
    });

    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;

    const status = compiled.querySelector(
      'app-runtime-update-notice [role="status"]',
    );
    expect(invoke).toHaveBeenCalledWith('runtime_update_status');
    expect(status?.textContent).toContain(
      '正在套用更新：更新本機服務（約需 3 秒）',
    );
    fixture.destroy();
  });
});

describe('Runtime manager tabs', () => {
  let apiClient: ReturnType<typeof createApiClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    apiClient = createApiClient();

    TestBed.configureTestingModule({
      imports: [App, RuntimeManagerPage],
      providers: [
        { provide: CERT_PREP_API, useValue: apiClient },
        provideCertPrepHttpResourceClientFake(apiClient),
        provideRouter(appRoutes),
      ],
    });
  });

  it('renders no tab bar and shows existing content with the fake provider', async () => {
    const fixture = TestBed.createComponent(RuntimeManagerPage);
    fixture.detectChanges();
    TestBed.tick();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[role="tablist"]')).toBeNull();
    expect(el.querySelector('[role="tab"]')).toBeNull();
    expect(el.querySelector('hlm-tabs-list')).toBeNull();
    expect(el.querySelector('[aria-label="Runtime details"]')).not.toBeNull();
    expect(el.textContent).toContain('Python backend');
    fixture.destroy();
  });

  it('renders two tabs when device is present, defaulting to 執行環境 and switching to 運算裝置', async () => {
    apiClient.llmDevicePreference.mockReturnValue(
      of({
        mode: 'adapter',
        adapter_key: 'nv4090',
        adapter_name: 'NVIDIA GeForce RTX 4090',
        status: 'active',
        choices: [
          {
            adapter_key: 'nv4090',
            name: 'NVIDIA GeForce RTX 4090',
            classification: 'dedicated',
            backend: 'cuda',
            selectable: true,
          },
        ],
      }),
    );
    const fixture = TestBed.createComponent(RuntimeManagerPage);
    fixture.detectChanges();
    TestBed.tick();

    const el = fixture.nativeElement as HTMLElement;
    const tabs = el.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs.length).toBe(2);
    expect(tabs[0].textContent).toContain('執行環境');
    expect(tabs[1].textContent).toContain('運算裝置');

    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[1].getAttribute('aria-selected')).toBe('false');

    const panelOf = (tab: HTMLButtonElement): HTMLElement | null =>
      el.querySelector<HTMLElement>(`#${tab.getAttribute('aria-controls')}`);
    const runtimePanel = panelOf(tabs[0]);
    const devicePanel = panelOf(tabs[1]);
    expect(runtimePanel).not.toBeNull();
    expect(devicePanel).not.toBeNull();
    expect(runtimePanel?.hasAttribute('hidden')).toBe(false);
    expect(devicePanel?.hasAttribute('hidden')).toBe(true);

    tabs[1].click();
    fixture.detectChanges();

    expect(tabs[0].getAttribute('aria-selected')).toBe('false');
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(runtimePanel?.hasAttribute('hidden')).toBe(true);
    expect(devicePanel?.hasAttribute('hidden')).toBe(false);
    expect(
      devicePanel?.querySelector('app-runtime-device-section'),
    ).not.toBeNull();
    fixture.destroy();
  });

  it('shows attention dot on 運算裝置 tab for pending status while on first tab and hides it on device tab', async () => {
    apiClient.llmDevicePreference.mockReturnValue(
      of({
        mode: 'adapter',
        adapter_key: 'nv4090',
        adapter_name: 'NVIDIA GeForce RTX 4090',
        status: 'pending',
        choices: [
          {
            adapter_key: 'nv4090',
            name: 'NVIDIA GeForce RTX 4090',
            classification: 'dedicated',
            backend: 'cuda',
            selectable: true,
          },
        ],
      }),
    );
    const fixture = TestBed.createComponent(RuntimeManagerPage);
    fixture.detectChanges();
    TestBed.tick();

    const el = fixture.nativeElement as HTMLElement;
    const tabs = el.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs.length).toBe(2);

    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    const dot = tabs[1].querySelector('.runtime-tab-attention-dot');
    expect(dot).not.toBeNull();
    expect(tabs[1].textContent).toContain('需要注意');

    tabs[1].click();
    fixture.detectChanges();

    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(tabs[1].querySelector('.runtime-tab-attention-dot')).toBeNull();
    fixture.destroy();
  });

  it('still requests preference on route Refresh all after opening and closing the modal', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await TestBed.inject(Router).navigateByUrl('/runtime');
    await vi.waitFor(() => {
      fixture.detectChanges();
      TestBed.tick();
      expect(apiClient.llmDevicePreference).toHaveBeenCalled();
    });

    const shell = fixture.nativeElement as HTMLElement;
    openRuntimeManagerFromTopbar(shell);
    await vi.waitFor(() => {
      fixture.detectChanges();
      TestBed.tick();
      expect(shell.querySelectorAll('app-runtime-manager-page').length).toBe(2);
    });

    closeRuntimeManagerModal(shell);
    await vi.waitFor(() => {
      fixture.detectChanges();
      TestBed.tick();
      expect(shell.querySelectorAll('app-runtime-manager-page').length).toBe(1);
    });

    apiClient.llmDevicePreference.mockClear();

    const button = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ).find((item) => item.textContent?.includes('Refresh all'));
    expect(button).toBeDefined();
    button?.click();
    fixture.detectChanges();
    TestBed.tick();

    await vi.waitFor(() => {
      TestBed.tick();
      expect(apiClient.llmDevicePreference).toHaveBeenCalledTimes(1);
    });
    fixture.destroy();
  });

  it('assigns unique element ids and instance-scoped aria-controls when modal opens over route', async () => {
    apiClient.llmDevicePreference.mockReturnValue(
      of({
        mode: 'adapter',
        adapter_key: 'nv4090',
        adapter_name: 'NVIDIA GeForce RTX 4090',
        status: 'active',
        choices: [
          {
            adapter_key: 'nv4090',
            name: 'NVIDIA GeForce RTX 4090',
            classification: 'dedicated',
            backend: 'cuda',
            selectable: true,
          },
        ],
      }),
    );
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await TestBed.inject(Router).navigateByUrl('/runtime');
    await vi.waitFor(() => {
      fixture.detectChanges();
      TestBed.tick();
      expect(apiClient.llmDevicePreference).toHaveBeenCalled();
    });

    const root = fixture.nativeElement as HTMLElement;
    openRuntimeManagerFromTopbar(root);
    await vi.waitFor(() => {
      fixture.detectChanges();
      TestBed.tick();
      expect(root.querySelectorAll('app-runtime-manager-page').length).toBe(2);
      expect(root.querySelectorAll('[role="tab"]').length).toBe(4);
    });
    const allIds = Array.from(root.querySelectorAll<HTMLElement>('[id]')).map(
      (el) => el.id,
    );
    const uniqueIds = new Set(allIds);
    expect(allIds.length).toBe(uniqueIds.size);

    const runtimePages = root.querySelectorAll('app-runtime-manager-page');
    expect(runtimePages.length).toBe(2);

    for (const page of runtimePages) {
      const tabs = page.querySelectorAll<HTMLButtonElement>('[role="tab"]');
      expect(tabs.length).toBe(2);
      for (const tab of tabs) {
        const controlsId = tab.getAttribute('aria-controls');
        expect(controlsId).toBeTruthy();
        const panel = page.querySelector(`#${controlsId}`);
        expect(panel).not.toBeNull();
      }
    }
    fixture.destroy();
  });
});

function openRuntimeManagerFromTopbar(root: HTMLElement): void {
  const button = Array.from(root.querySelectorAll('button')).find((item) =>
    item.textContent?.includes('Manage runtime'),
  );
  expect(button).toBeDefined();
  button?.click();
}

function closeRuntimeManagerModal(root: HTMLElement): void {
  const button = root.querySelector<HTMLButtonElement>(
    '[aria-label="Close runtime manager"]',
  );
  expect(button).not.toBeNull();
  button?.click();
}

function createApiClient() {
  return {
    health: vi.fn().mockReturnValue(of(backendHealth())),
    llmHealth: vi.fn().mockReturnValue(of(availableLlmHealth())),
    llmDevicePreference: vi
      .fn()
      .mockReturnValue(
        throwError(() => new Error('Device preference unavailable')),
      ),
    runtimeRequirements: vi.fn().mockReturnValue(of({ items: [] })),
    startRuntimeInstallation: vi.fn(),
    getRuntimeInstallation: vi.fn(),
    listProjects: vi.fn().mockReturnValue(of({ items: [appProject] })),
    listDocuments: vi.fn().mockReturnValue(of({ items: [appDocument] })),
    getDocument: vi.fn().mockReturnValue(of(appDocument)),
    listDocumentChunks: vi.fn().mockReturnValue(of({ items: [] })),
    listQuestionDrafts: vi
      .fn()
      .mockReturnValue(of({ items: [editableAppQuestion] })),
    listActivePracticeSessions: vi.fn().mockReturnValue(of({ items: [] })),
    listWrongAnswers: vi.fn().mockReturnValue(of({ items: [] })),
    summarizeWrongAnswers: vi
      .fn()
      .mockReturnValue(of(emptyWrongAnswerSummary())),
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
