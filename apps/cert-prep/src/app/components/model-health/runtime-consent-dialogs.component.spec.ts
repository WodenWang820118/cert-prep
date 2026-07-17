import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../cert-prep-api';
import type {
  DesktopRuntimeInstallation,
  DesktopRuntimeStatus,
} from '../../stores/desktop-runtime/contracts/desktop-runtime.contracts';
import { DesktopRuntimeBridgeService } from '../../stores/desktop-runtime/desktop-runtime-bridge.service';
import { DesktopRuntimeStore } from '../../stores/desktop-runtime/desktop-runtime.store';
import { HealthStore } from '../../stores/health/health.store';
import {
  modelDownload,
  providerSelection,
  runtimeInstallation,
} from '../../stores/health/health.store.spec-helpers';
import {
  buttonByText,
  missingModelHealth,
  ocrHealth,
  systemHealth,
} from './model-health.component.spec-helpers';
import { RuntimeConsentDialogsComponent } from './runtime-consent-dialogs.component';

describe('RuntimeConsentDialogsComponent', () => {
  let apiClient: {
    getModelDownload: ReturnType<typeof vi.fn>;
    getRuntimeInstallation: ReturnType<typeof vi.fn>;
    health: ReturnType<typeof vi.fn>;
    llmHealth: ReturnType<typeof vi.fn>;
    llmProviderSelection: ReturnType<typeof vi.fn>;
    ocrHealth: ReturnType<typeof vi.fn>;
    runtimeRequirements: ReturnType<typeof vi.fn>;
    startModelDownload: ReturnType<typeof vi.fn>;
    startRuntimeInstallation: ReturnType<typeof vi.fn>;
  };
  let desktopRuntimeBridge: {
    isDesktop: ReturnType<typeof vi.fn>;
    invoke: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    apiClient = {
      getModelDownload: vi.fn(),
      getRuntimeInstallation: vi.fn(),
      health: vi.fn().mockResolvedValue(systemHealth()),
      llmHealth: vi.fn().mockResolvedValue(missingModelHealth()),
      llmProviderSelection: vi.fn().mockResolvedValue(
        providerSelection({
          selected_provider: 'ollama',
          effective_provider: 'ollama',
          selection_reason: 'Auto-selected Ollama for this device.',
          runtime_requirement_kind: 'ollama',
          model_requirement_kind: 'ollama_model',
        }),
      ),
      ocrHealth: vi.fn().mockResolvedValue(ocrHealth()),
      runtimeRequirements: vi.fn().mockResolvedValue({ items: [] }),
      startModelDownload: vi.fn().mockResolvedValue(
        modelDownload({
          status: 'succeeded',
          detail: 'model download complete',
          completed: 100,
        }),
      ),
      startRuntimeInstallation: vi.fn().mockResolvedValue(
        runtimeInstallation({
          status: 'succeeded',
          detail: 'runtime installation complete',
          completed: 100,
        }),
      ),
    };
    desktopRuntimeBridge = {
      isDesktop: vi.fn().mockReturnValue(true),
      invoke: vi.fn().mockResolvedValue(pythonRuntimeInstallation()),
    };

    await TestBed.configureTestingModule({
      imports: [RuntimeConsentDialogsComponent],
      providers: [
        { provide: CERT_PREP_API, useValue: apiClient },
        {
          provide: DesktopRuntimeBridgeService,
          useValue: desktopRuntimeBridge,
        },
      ],
    }).compileComponents();
  });

  it('binds the Python runtime consent dialog and install actions', async () => {
    const fixture = TestBed.createComponent(RuntimeConsentDialogsComponent);
    const desktopRuntime = TestBed.inject(DesktopRuntimeStore);
    desktopRuntime.status.set(missingPythonRuntimeStatus());
    desktopRuntime.openInstallConsent();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(desktopRuntime.installConsentVisible()).toBe(true);
    expect(document.body.textContent).toContain(
      'Download the packaged Python backend runtime?',
    );

    buttonByText(document.body, 'Cancel')?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(desktopRuntime.installConsentVisible()).toBe(false);
    expect(desktopRuntimeBridge.invoke).not.toHaveBeenCalled();

    desktopRuntime.openInstallConsent();
    fixture.detectChanges();
    await fixture.whenStable();

    buttonByText(document.body, 'Install')?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(desktopRuntimeBridge.invoke).toHaveBeenCalledWith(
      'start_python_runtime_installation',
    );
    expect(desktopRuntime.installConsentVisible()).toBe(false);
  });

  it('binds the model download consent dialog and download actions', async () => {
    const fixture = TestBed.createComponent(RuntimeConsentDialogsComponent);
    const health = TestBed.inject(HealthStore);
    health.llmHealth.set(missingModelHealth());
    health.openModelDownloadConsent();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(health.modelDownloadConsentVisible()).toBe(true);
    expect(document.body.textContent).toContain(
      'Download reasoner:7b with Ollama?',
    );

    buttonByText(document.body, 'Cancel')?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(health.modelDownloadConsentVisible()).toBe(false);
    expect(apiClient.startModelDownload).not.toHaveBeenCalled();

    health.openModelDownloadConsent();
    fixture.detectChanges();
    await fixture.whenStable();

    buttonByText(document.body, 'Download')?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    await vi.waitFor(() => {
      expect(apiClient.startModelDownload).toHaveBeenCalledTimes(1);
      expect(health.modelDownloadConsentVisible()).toBe(false);
    });
  });

  it('binds the runtime install consent dialog and install actions', async () => {
    const fixture = TestBed.createComponent(RuntimeConsentDialogsComponent);
    const health = TestBed.inject(HealthStore);
    health.llmHealth.set({
      ...missingModelHealth(),
      detail: 'Ollama is not installed.',
      unavailable_reason: 'ollama_missing',
    });
    health.openOllamaInstallConsent();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(health.runtimeInstallConsentVisible()).toBe(true);
    expect(document.body.textContent).toContain(
      'Install Ollama for local AI generation?',
    );

    buttonByText(document.body, 'Cancel')?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(health.runtimeInstallConsentVisible()).toBe(false);
    expect(apiClient.startRuntimeInstallation).not.toHaveBeenCalled();

    health.openOllamaInstallConsent();
    fixture.detectChanges();
    await fixture.whenStable();

    buttonByText(document.body, 'Install')?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    await vi.waitFor(() => {
      expect(apiClient.startRuntimeInstallation).toHaveBeenCalledWith('ollama');
      expect(health.runtimeInstallConsentVisible()).toBe(false);
    });
  });

  it('describes OCR runtime installation for scanned PDFs and images', async () => {
    const fixture = TestBed.createComponent(RuntimeConsentDialogsComponent);
    const health = TestBed.inject(HealthStore);
    health.ocrHealth.set({
      ...ocrHealth(),
      provider: 'windowsml',
      engine: 'onnxruntime-windowsml',
      available: false,
      detail: 'WindowsML OCR runtime is not installed.',
      selected_device: null,
      unavailable_reason: 'windowsml_runtime_missing',
    });
    health.openOcrRuntimeInstallConsent();

    fixture.detectChanges();
    await fixture.whenStable();

    expect(document.body.textContent).toContain(
      'Install the WindowsML OCR runtime for scanned PDFs and images?',
    );
  });
});

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

function pythonRuntimeInstallation(): DesktopRuntimeInstallation {
  return {
    id: 'python-runtime-1',
    kind: 'python_backend',
    provider: 'pyinstaller',
    model: 'cert-prep-backend',
    status: 'succeeded',
    detail: 'Python backend runtime installation complete.',
    completed: 100,
    total: 100,
    createdAt: '2026-06-11T00:00:00Z',
    updatedAt: '2026-06-11T00:00:00Z',
    error: null,
  };
}
