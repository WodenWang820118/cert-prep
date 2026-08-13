import { TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import type { DocumentRead } from '@cert-prep/api';
import { CAPTURE_RUNTIME_VERSION } from '@cert-prep/capture-runtime-version';
import { of, Subject } from 'rxjs';
import type { CaptureCompletedEvent } from '@gx-capture/capture-workbench';
import { ProjectStore } from '../../stores/project.store';
import { SourceImportStore } from '../../stores/source-import/source-import.store';
import { DesktopRuntimeStore } from '../../stores/desktop-runtime/desktop-runtime.store';
import { DesktopRuntimeBridgeService } from '../../stores/desktop-runtime/desktop-runtime-bridge.service';
import { CertPrepRuntimeConfig } from '../../services/cert-prep-api.service';
import { CertPrepCaptureClient } from './cert-prep-capture-client';
import { CaptureWorkbenchTrialPage } from './capture-workbench-trial.page';

describe('CaptureWorkbenchTrialPage', () => {
  const activeDocument = signal<DocumentRead | null>(null);
  const selectedProjectId = signal<string | null>(null);
  let captureClient: {
    documentIdForSourceSha256: ReturnType<typeof vi.fn>;
    getDocumentMarkdown: ReturnType<typeof vi.fn>;
  };
  let refreshUploadedDocument: ReturnType<typeof vi.fn>;
  let loadLatestDocument: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    activeDocument.set(null);
    selectedProjectId.set(null);
    captureClient = {
      documentIdForSourceSha256: vi.fn().mockReturnValue(null),
      getDocumentMarkdown: vi.fn().mockReturnValue(of(new Blob(['# scan']))),
    };
    refreshUploadedDocument = vi.fn();
    loadLatestDocument = vi.fn();
    TestBed.configureTestingModule({
      imports: [CaptureWorkbenchTrialPage],
      providers: [
        {
          provide: CertPrepCaptureClient,
          useValue: captureClient,
        },
        {
          provide: ProjectStore,
          useValue: { selectedProjectId },
        },
        {
          provide: SourceImportStore,
          useValue: {
            activeDocument,
            refreshUploadedDocument,
            loadLatestDocument,
          },
        },
      ],
    });
  });

  it('renders the Capture Workbench surface with the real client contract', async () => {
    const fixture = TestBed.createComponent(CaptureWorkbenchTrialPage);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(
      'Capture Workbench trial',
    );
    expect(
      fixture.nativeElement.querySelector('capture-workbench'),
    ).not.toBeNull();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain('Element registered');
    });
    expect(
      fixture.nativeElement.querySelector('capture-workbench').config,
    ).toMatchObject({
      enabledSources: ['pdf', 'image', 'audio'],
      structuringMode: 'host',
      hostStructuringOwner: 'component',
      hostManagedHandshake: true,
      showRuntimeSetup: false,
    });
    expect(
      fixture.nativeElement.querySelector('capture-workbench')
        .structuringProvider,
    ).toBe(captureClient);
    expect(fixture.nativeElement.textContent).toContain(
      'PDF, image, and audio sources are processed',
    );
    expect(fixture.nativeElement.textContent).not.toContain('in-memory');
  });

  it('waits for the custom element view before configuring a defined component', async () => {
    const ready = signal(false);
    TestBed.overrideProvider(DesktopRuntimeStore, {
      useValue: {
        isDesktop: signal(true),
        captureRuntimeStatus: signal(captureRuntimeStatus('running')),
        isCaptureRuntimeReady: ready,
        canInstallCaptureRuntime: signal(false),
        canStartCaptureRuntime: signal(false),
        isCaptureRuntimeInstallActive: signal(false),
        loadCaptureRuntime: vi
          .fn()
          .mockReturnValue(of(captureRuntimeStatus('running'))),
      },
    });
    const fixture = TestBed.createComponent(CaptureWorkbenchTrialPage);
    const page = fixture.componentInstance as unknown as {
      registerCaptureWorkbench(): void;
      registrationState(): string;
    };

    page.registerCaptureWorkbench();
    await fixture.whenStable();
    expect(page.registrationState()).toBe('registering');

    ready.set(true);
    fixture.detectChanges();

    expect(page.registrationState()).toBe('ready');
    expect(
      fixture.nativeElement.querySelector('capture-workbench').config,
    ).toMatchObject({
      enabledSources: ['pdf', 'image', 'audio'],
      showRuntimeSetup: false,
    });
  });

  it('waits for an explicit Capture Runtime install before configuring the desktop capture client', () => {
    const captureRuntimeStatus = signal({
      kind: 'capture_runtime',
      label: 'Capture Runtime',
      available: false,
      running: false,
      status: 'missing',
      detail: 'Capture Runtime is not installed.',
      unavailableReason: 'capture_runtime_missing',
      version: null,
      installedPath: null,
      baseUrl: null,
      token: null,
      jobId: null,
      completed: null,
      total: null,
      error: null,
    });
    const installCaptureRuntime = vi.fn();
    TestBed.overrideProvider(DesktopRuntimeStore, {
      useValue: {
        isDesktop: signal(true),
        captureRuntimeStatus,
        isCaptureRuntimeReady: computed(() => false),
        canInstallCaptureRuntime: computed(() => true),
        canStartCaptureRuntime: computed(() => false),
        captureRuntimeInstallStarting: signal(false),
        isCaptureRuntimeInstallActive: signal(false),
        loadCaptureRuntime: vi.fn().mockReturnValue(of(captureRuntimeStatus())),
        installCaptureRuntime,
      },
    });
    const fixture = TestBed.createComponent(CaptureWorkbenchTrialPage);

    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(
      'Capture Runtime is not installed.',
    );
    const root = fixture.nativeElement as HTMLElement;
    const install = Array.from(
      root.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Install Capture Runtime'));
    expect(install).toBeDefined();
    expect(root.querySelector('capture-workbench')).toBeNull();
    install?.click();
    expect(installCaptureRuntime).toHaveBeenCalledTimes(1);
  });

  it('does not mount or configure Capture Workbench while desktop status is pending', () => {
    const pendingStatus = new Subject();
    const invoke = vi.fn().mockReturnValue(pendingStatus);
    TestBed.overrideProvider(DesktopRuntimeBridgeService, {
      useValue: {
        isDesktop: () => true,
        invoke,
      },
    });
    TestBed.overrideProvider(CertPrepRuntimeConfig, {
      useValue: { invalidateBackendConfig: vi.fn() },
    });
    const fixture = TestBed.createComponent(CaptureWorkbenchTrialPage);

    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(invoke).toHaveBeenCalledWith('capture_runtime_status');
    expect(root.textContent).toContain(
      'Checking Capture Runtime availability.',
    );
    expect(root.querySelector('capture-workbench')).toBeNull();
    expect(root.querySelector('button')).toBeNull();
  });

  it('shows and downloads Markdown only after the saved PDF is ready', async () => {
    activeDocument.set({
      id: 'document-1',
      project_id: 'project-1',
      filename: 'scan.pdf',
      status: 'ready',
      source_kind: 'pdf',
      chunks_count: 46,
    } as DocumentRead);
    const fixture = TestBed.createComponent(CaptureWorkbenchTrialPage);
    const page = fixture.componentInstance as unknown as {
      lastCompleted: { set(value: CaptureCompletedEvent): void };
      downloadMarkdown(): void;
    };
    page.lastCompleted.set({
      taskId: 'task-1',
      document: {
        source: { fileName: 'scan.pdf', bytes: 4 },
        schemaVersion: '1',
        blocks: [],
      },
    } as unknown as CaptureCompletedEvent);
    fixture.detectChanges();

    const createObjectUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:markdown');
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL');
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    expect(fixture.nativeElement.textContent).toContain('Download Markdown');
    page.downloadMarkdown();
    await fixture.whenStable();

    expect(captureClient.getDocumentMarkdown).toHaveBeenCalledWith(
      'project-1',
      'document-1',
    );
    expect(createObjectUrl).toHaveBeenCalledWith(expect.any(Blob));
    expect(anchorClick).toHaveBeenCalled();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:markdown');
  });

  it('refreshes the saved document after Capture Workbench completion', () => {
    selectedProjectId.set('project-1');
    captureClient.documentIdForSourceSha256.mockReturnValue('document-1');
    const fixture = TestBed.createComponent(CaptureWorkbenchTrialPage);
    const page = fixture.componentInstance as unknown as {
      onCompleted(event: Event): void;
    };

    page.onCompleted(
      new CustomEvent('capture-completed', {
        detail: {
          taskId: 'task-1',
          document: {
            source: {
              sha256: 'a'.repeat(64),
              fileName: 'scan.pdf',
            },
          },
        },
      }),
    );

    expect(refreshUploadedDocument).toHaveBeenCalledWith(
      'project-1',
      'document-1',
    );
    expect(loadLatestDocument).toHaveBeenCalledWith('project-1');
  });
});

function captureRuntimeStatus(status: 'missing' | 'running') {
  const running = status === 'running';
  return {
    kind: 'capture_runtime',
    label: 'Capture Runtime',
    available: running,
    running,
    status,
    detail: `Capture Runtime is ${status}.`,
    unavailableReason: running ? null : 'capture_runtime_missing',
    version: CAPTURE_RUNTIME_VERSION,
    installedPath: null,
    baseUrl: null,
    token: null,
    jobId: null,
    completed: null,
    total: null,
    error: null,
  };
}
