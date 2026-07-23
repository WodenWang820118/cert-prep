import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { CERT_PREP_API } from '../../constants/cert-prep-api.constants';
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

  beforeEach(() => {
    vi.clearAllMocks();

    apiClient = {
      getModelDownload: vi.fn(),
      getRuntimeInstallation: vi.fn(),
      health: vi.fn().mockReturnValue(of(systemHealth())),
      llmHealth: vi.fn().mockReturnValue(of(missingModelHealth())),
      llmProviderSelection: vi.fn().mockReturnValue(
        of(providerSelection({
          selected_provider: 'ollama',
          effective_provider: 'ollama',
          selection_reason: 'Auto-selected Ollama for this device.',
          runtime_requirement_kind: 'ollama',
          model_requirement_kind: 'ollama_model',
        })),
      ),
      ocrHealth: vi.fn().mockReturnValue(of(ocrHealth())),
      runtimeRequirements: vi.fn().mockReturnValue(of({ items: [] })),
      startModelDownload: vi.fn().mockReturnValue(
        of(modelDownload({
          status: 'succeeded',
          detail: 'model download complete',
          completed: 100,
        })),
      ),
      startRuntimeInstallation: vi.fn().mockReturnValue(
        of(runtimeInstallation({
          status: 'succeeded',
          detail: 'runtime installation complete',
          completed: 100,
        })),
      ),
    };
    desktopRuntimeBridge = {
      isDesktop: vi.fn().mockReturnValue(true),
      invoke: vi.fn().mockReturnValue(of(pythonRuntimeInstallation())),
    };

    TestBed.configureTestingModule({
      imports: [RuntimeConsentDialogsComponent],
      providers: [
        { provide: CERT_PREP_API, useValue: apiClient },
        {
          provide: DesktopRuntimeBridgeService,
          useValue: desktopRuntimeBridge,
        },
      ],
    });
  });

  it('binds the Python runtime consent dialog and install actions', () => {
    const fixture = TestBed.createComponent(RuntimeConsentDialogsComponent);
    const desktopRuntime = TestBed.inject(DesktopRuntimeStore);
    desktopRuntime.status.set(missingPythonRuntimeStatus());
    desktopRuntime.openInstallConsent();
    fixture.detectChanges();
    TestBed.tick();

    expect(desktopRuntime.installConsentVisible()).toBe(true);
    expect(document.body.textContent).toContain(
      'Download the packaged Python backend runtime?',
    );

    buttonByText(document.body, 'Cancel')?.click();
    fixture.detectChanges();
    TestBed.tick();

    expect(desktopRuntime.installConsentVisible()).toBe(false);
    expect(desktopRuntimeBridge.invoke).not.toHaveBeenCalled();

    desktopRuntime.openInstallConsent();
    fixture.detectChanges();
    TestBed.tick();

    buttonByText(document.body, 'Install')?.click();
    fixture.detectChanges();
    TestBed.tick();

    expect(desktopRuntimeBridge.invoke).toHaveBeenCalledWith(
      'start_python_runtime_installation',
    );
    expect(desktopRuntime.installConsentVisible()).toBe(false);
  });

  it('binds the model download consent dialog and download actions', () => {
    const fixture = TestBed.createComponent(RuntimeConsentDialogsComponent);
    const health = TestBed.inject(HealthStore);
    health.llmHealth.set(missingModelHealth());
    health.openModelDownloadConsent();
    fixture.detectChanges();
    TestBed.tick();

    expect(health.modelDownloadConsentVisible()).toBe(true);
    expect(document.body.textContent).toContain(
      'Download reasoner:7b with Ollama?',
    );

    buttonByText(document.body, 'Cancel')?.click();
    fixture.detectChanges();
    TestBed.tick();

    expect(health.modelDownloadConsentVisible()).toBe(false);
    expect(apiClient.startModelDownload).not.toHaveBeenCalled();

    health.openModelDownloadConsent();
    fixture.detectChanges();
    TestBed.tick();

    buttonByText(document.body, 'Download')?.click();
    fixture.detectChanges();
    TestBed.tick();

    return vi.waitFor(() => {
      expect(apiClient.startModelDownload).toHaveBeenCalledTimes(1);
      expect(health.modelDownloadConsentVisible()).toBe(false);
    });
  });

  it('binds the runtime install consent dialog and install actions', () => {
    const fixture = TestBed.createComponent(RuntimeConsentDialogsComponent);
    const health = TestBed.inject(HealthStore);
    health.llmHealth.set({
      ...missingModelHealth(),
      detail: 'Ollama is not installed.',
      unavailable_reason: 'ollama_missing',
    });
    health.openOllamaInstallConsent();
    fixture.detectChanges();
    TestBed.tick();

    expect(health.runtimeInstallConsentVisible()).toBe(true);
    expect(document.body.textContent).toContain(
      'Install Ollama for local AI generation?',
    );

    buttonByText(document.body, 'Cancel')?.click();
    fixture.detectChanges();
    TestBed.tick();

    expect(health.runtimeInstallConsentVisible()).toBe(false);
    expect(apiClient.startRuntimeInstallation).not.toHaveBeenCalled();

    health.openOllamaInstallConsent();
    fixture.detectChanges();
    TestBed.tick();

    buttonByText(document.body, 'Install')?.click();
    fixture.detectChanges();
    TestBed.tick();

    return vi.waitFor(() => {
      expect(apiClient.startRuntimeInstallation).toHaveBeenCalledWith('ollama');
      expect(health.runtimeInstallConsentVisible()).toBe(false);
    });
  });

  it('describes OCR runtime installation for scanned PDFs and images', () => {
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
    TestBed.tick();

    expect(document.body.textContent).toContain(
      'Install the WindowsML OCR runtime for scanned PDFs and images?',
    );
  });

  it('describes both consent-gated Whisper models and starts their download', () => {
    const fixture = TestBed.createComponent(RuntimeConsentDialogsComponent);
    const health = TestBed.inject(HealthStore);
    health.runtimeRequirements.set([
      {
        kind: 'whisper_models',
        label: 'Whisper speech models',
        available: false,
        detail: 'Whisper speech models require download.',
        unavailable_reason: 'whisper_models_missing',
        version: 'large-v3-turbo + small',
      },
    ]);
    apiClient.startRuntimeInstallation.mockReturnValue(
      of(runtimeInstallation({
        kind: 'whisper_models',
        provider: 'faster-whisper',
        model: 'large-v3-turbo + small',
      })),
    );

    health.openWhisperModelsConsent();
    fixture.detectChanges();
    TestBed.tick();

    expect(document.body.textContent).toContain(
      'Download Whisper large-v3-turbo and the CPU small fallback',
    );
    expect(document.body.textContent).toContain(
      'not included in the installer',
    );

    buttonByText(document.body, 'Download')?.click();
    fixture.detectChanges();
    TestBed.tick();

    expect(apiClient.startRuntimeInstallation).toHaveBeenCalledWith(
      'whisper_models',
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
