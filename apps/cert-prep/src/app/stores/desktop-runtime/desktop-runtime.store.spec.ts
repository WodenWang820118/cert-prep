import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import type {
  DesktopRuntimeInstallation,
  DesktopRuntimeStatus,
} from './contracts/desktop-runtime.contracts';
import { CertPrepRuntimeConfig } from '../../services/cert-prep-api.service';
import { DesktopRuntimeBridgeService } from './desktop-runtime-bridge.service';
import { DesktopRuntimeStore } from './desktop-runtime.store';

describe('DesktopRuntimeStore', () => {
  let desktop = false;
  let invoke: ReturnType<typeof vi.fn>;
  let invalidateBackendConfig: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    invoke = vi.fn();
    invalidateBackendConfig = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: DesktopRuntimeBridgeService,
          useValue: {
            isDesktop: () => desktop,
            invoke,
          },
        },
        {
          provide: CertPrepRuntimeConfig,
          useValue: { invalidateBackendConfig },
        },
      ],
    });
  });

  afterEach(() => {
    desktop = false;
    vi.useRealTimers();
  });

  it('treats browser development mode as backend-ready', () => {
    const store = TestBed.inject(DesktopRuntimeStore);

    store.load().subscribe();

    expect(store.isDesktop()).toBe(false);
    expect(store.isBackendReady()).toBe(true);
    expect(store.status().label).toBe('Developer backend');
  });

  it('keeps the desktop Capture Runtime fail-closed while its native status command is pending', () => {
    desktop = true;
    const pending = new Subject<DesktopRuntimeStatus>();
    invoke.mockReturnValue(pending);
    const store = TestBed.inject(DesktopRuntimeStore);

    expect(store.captureRuntimeStatus().status).toBe('checking');
    expect(store.captureRuntimeStatusLoaded()).toBe(false);
    expect(store.isCaptureRuntimeReady()).toBe(false);
    expect(store.canInstallCaptureRuntime()).toBe(false);
    expect(store.canStartCaptureRuntime()).toBe(false);

    store.loadCaptureRuntime().subscribe();

    expect(invoke).toHaveBeenCalledWith('capture_runtime_status');
    expect(store.isCaptureRuntimeReady()).toBe(false);
    expect(store.canInstallCaptureRuntime()).toBe(false);
  });

  it('keeps Capture Runtime stopped after an install job succeeds without invalidating backend config', () => {
    vi.useFakeTimers();
    desktop = true;
    let captureStatus = captureRuntimeStatus('missing');
    invoke.mockImplementation((command: string) => {
      if (command === 'capture_runtime_status') {
        return of(captureStatus);
      }
      if (command === 'install_capture_runtime') {
        return of(captureRuntimeInstallation('install-job', 'queued'));
      }
      if (command === 'get_capture_runtime_installation') {
        captureStatus = captureRuntimeStatus('installed');
        return of(captureRuntimeInstallation('install-job', 'succeeded'));
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const store = TestBed.inject(DesktopRuntimeStore);
    store.loadCaptureRuntime().subscribe();

    store.installCaptureRuntime();
    vi.advanceTimersByTime(1500);

    expect(store.captureRuntimeInstallation()?.status).toBe('succeeded');
    expect(store.captureRuntimeStatus().status).toBe('installed');
    expect(store.isCaptureRuntimeReady()).toBe(false);
    expect(store.canStartCaptureRuntime()).toBe(true);
    expect(invalidateBackendConfig).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('desktop_runtime_status');
  });

  it('invalidates cached backend config exactly once after a start job succeeds', () => {
    vi.useFakeTimers();
    desktop = true;
    let captureStatus = captureRuntimeStatus('installed');
    invoke.mockImplementation((command: string) => {
      if (command === 'capture_runtime_status') {
        return of(captureStatus);
      }
      if (command === 'desktop_runtime_status') {
        return of({
          ...captureRuntimeStatus('running'),
          kind: 'python_backend',
          label: 'Python backend',
        });
      }
      if (command === 'start_capture_runtime') {
        return of(captureRuntimeInstallation('start-job', 'starting'));
      }
      if (command === 'get_capture_runtime_installation') {
        captureStatus = captureRuntimeStatus('running');
        return of(captureRuntimeInstallation('start-job', 'succeeded'));
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const store = TestBed.inject(DesktopRuntimeStore);
    store.loadCaptureRuntime().subscribe();

    store.startCaptureRuntime();
    vi.advanceTimersByTime(1500);

    expect(store.captureRuntimeInstallation()?.status).toBe('succeeded');
    expect(store.captureRuntimeStatus().status).toBe('running');
    expect(store.isCaptureRuntimeReady()).toBe(true);
    expect(invalidateBackendConfig).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('desktop_runtime_status');
  });

  it('keeps a starting Capture Runtime job active and rejects duplicate starts', () => {
    vi.useFakeTimers();
    desktop = true;
    invoke.mockImplementation((command: string) => {
      if (command === 'capture_runtime_status') {
        return of(captureRuntimeStatus('installed'));
      }
      if (command === 'start_capture_runtime') {
        return of(captureRuntimeInstallation('start-job', 'starting'));
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const store = TestBed.inject(DesktopRuntimeStore);
    store.loadCaptureRuntime().subscribe();

    store.startCaptureRuntime();
    store.startCaptureRuntime();

    expect(store.isCaptureRuntimeInstallActive()).toBe(true);
    expect(store.canStartCaptureRuntime()).toBe(false);
    expect(
      invoke.mock.calls.filter(
        ([command]) => command === 'start_capture_runtime',
      ),
    ).toHaveLength(1);
  });

  it('rejects Capture Runtime actions that do not match the current lifecycle state', () => {
    desktop = true;
    let captureStatus = captureRuntimeStatus('installed');
    invoke.mockImplementation((command: string) => {
      if (command === 'capture_runtime_status') {
        return of(captureStatus);
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const store = TestBed.inject(DesktopRuntimeStore);
    store.loadCaptureRuntime().subscribe();

    store.installCaptureRuntime();
    captureStatus = captureRuntimeStatus('missing');
    store.loadCaptureRuntime().subscribe();
    store.startCaptureRuntime();

    expect(invoke).not.toHaveBeenCalledWith('install_capture_runtime');
    expect(invoke).not.toHaveBeenCalledWith('start_capture_runtime');
  });
});

function captureRuntimeStatus(
  status: 'missing' | 'installed' | 'running',
): DesktopRuntimeStatus {
  const running = status === 'running';
  const available = status !== 'missing';
  return {
    kind: 'capture_runtime',
    label: 'Capture Runtime',
    available,
    running,
    status,
    detail: `Capture Runtime is ${status}.`,
    unavailableReason: running ? null : `capture_runtime_${status}`,
    version: '0.3.11',
    installedPath: null,
    baseUrl: null,
    token: null,
    jobId: null,
    completed: null,
    total: null,
    error: null,
  };
}

function captureRuntimeInstallation(
  id: string,
  status: 'queued' | 'starting' | 'succeeded',
): DesktopRuntimeInstallation {
  return {
    id,
    kind: 'capture_runtime',
    provider: 'bundled-release',
    model: 'capture-runtime@0.3.11',
    status,
    detail: `Capture Runtime ${status}.`,
    completed: null,
    total: null,
    createdAt: '',
    updatedAt: '',
    error: null,
  };
}
