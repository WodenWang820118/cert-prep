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
    llmProviderSelection: ReturnType<typeof vi.fn>;
    decideFastflowlmTerms: ReturnType<typeof vi.fn>;
    llmHealth: ReturnType<typeof vi.fn>;
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
      llmProviderSelection: vi.fn().mockResolvedValue(fastFlowSelection()),
      decideFastflowlmTerms: vi
        .fn()
        .mockResolvedValue(fastFlowSelection({ terms_accepted: true })),
      llmHealth: vi.fn().mockResolvedValue(missingModelHealth()),
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
        { provide: DesktopRuntimeBridgeService, useValue: desktopRuntimeBridge },
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

    expect(apiClient.startModelDownload).toHaveBeenCalledTimes(1);
    expect(health.modelDownloadConsentVisible()).toBe(false);
  });

  it('requires explicit acknowledgement before accepting pinned FastFlowLM terms', async () => {
    const fixture = TestBed.createComponent(RuntimeConsentDialogsComponent);
    const health = TestBed.inject(HealthStore);
    health.runtimeRequirements.set([
      fastFlowRuntimeAvailableRequirement(),
      fastFlowModelRequirement('fastflowlm_terms_required'),
    ]);

    await health.openFastFlowTermsConsent();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(health.fastFlowTermsConsentVisible()).toBe(true);
    expect(document.body.textContent).toContain('FastFlowLM v0.9.43 terms');
    expect(document.body.textContent).toContain('Powered by FastFlowLM');
    const termsLink = Array.from(document.body.querySelectorAll('a')).find(
      (link) => link.textContent?.includes('official FastFlowLM terms'),
    );
    expect(termsLink?.getAttribute('href')).toBe(FASTFLOW_TERMS_URL);

    const acceptButton = buttonByText(document.body, 'Accept FastFlowLM terms');
    expect(acceptButton?.disabled).toBe(true);

    const acknowledgement = document.body.querySelector<HTMLInputElement>(
      '#fastflowlm-terms-acknowledgement',
    );
    acknowledgement?.click();
    fixture.detectChanges();

    expect(health.fastFlowTermsAcknowledged()).toBe(true);
    expect(acceptButton?.disabled).toBe(false);

    apiClient.llmHealth.mockResolvedValueOnce(fastFlowNotRunningHealth());
    apiClient.runtimeRequirements.mockResolvedValueOnce({
      items: [
        fastFlowRuntimeAvailableRequirement(),
        fastFlowModelRequirement('model_missing'),
      ],
    });

    acceptButton?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(apiClient.decideFastflowlmTerms).toHaveBeenCalledWith({
      decision: 'accepted',
      terms_version: '0.9.43',
    });
    await vi.waitFor(() => {
      expect(health.fastFlowTermsConsentVisible()).toBe(false);
      expect(health.modelDownloadConsentVisible()).toBe(true);
    });
  });

  it('wires an explicit FastFlowLM decline to Ollama selection', async () => {
    const fixture = TestBed.createComponent(RuntimeConsentDialogsComponent);
    const health = TestBed.inject(HealthStore);
    health.runtimeRequirements.set([
      fastFlowRuntimeAvailableRequirement(),
      fastFlowModelRequirement('fastflowlm_terms_required'),
    ]);
    apiClient.decideFastflowlmTerms.mockResolvedValueOnce(
      fastFlowSelection({
        selected_provider: 'ollama',
        effective_provider: 'ollama',
        requires_terms_acceptance: false,
        terms_version: null,
        terms_url: null,
        runtime_requirement_kind: 'ollama',
        model_requirement_kind: 'ollama_model',
      }),
    );
    apiClient.llmHealth.mockResolvedValueOnce({
      ...missingModelHealth(),
      detail: 'Ollama is not installed.',
      unavailable_reason: 'ollama_missing',
    });
    apiClient.runtimeRequirements.mockResolvedValueOnce({
      items: [
        {
          kind: 'ollama',
          label: 'Ollama',
          available: false,
          detail: 'Ollama is not installed.',
          unavailable_reason: 'ollama_missing',
        },
      ],
    });

    await health.openFastFlowTermsConsent();
    fixture.detectChanges();
    await fixture.whenStable();

    buttonByText(document.body, 'Decline and use Ollama')?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(apiClient.decideFastflowlmTerms).toHaveBeenCalledWith({
      decision: 'declined',
      terms_version: '0.9.43',
    });
    await vi.waitFor(() => {
      expect(health.fastFlowTermsConsentVisible()).toBe(false);
      expect(health.runtimeInstallConsentKind()).toBe('ollama');
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

    expect(apiClient.startRuntimeInstallation).toHaveBeenCalledWith('ollama');
    expect(health.runtimeInstallConsentVisible()).toBe(false);
  });

  it('shows the verified official-installer copy for FastFlowLM', async () => {
    const fixture = TestBed.createComponent(RuntimeConsentDialogsComponent);
    const health = TestBed.inject(HealthStore);
    health.llmHealth.set({
      ...missingModelHealth(),
      provider: 'fastflowlm',
      model: 'qwen3.5:4b',
      detail: 'FastFlowLM is not installed.',
      unavailable_reason: 'fastflowlm_missing',
    });
    health.runtimeRequirements.set([
      fastFlowRuntimeMissingRequirement('fastflowlm_missing'),
    ]);
    apiClient.startRuntimeInstallation.mockResolvedValueOnce(
      runtimeInstallation({
        kind: 'fastflowlm',
        provider: 'fastflowlm',
        model: 'fastflowlm',
        status: 'succeeded',
        detail: 'FastFlowLM installation completed',
        completed: 100,
      }),
    );

    health.openFastFlowInstallConsent();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(document.body.textContent).toContain(
      'Install FastFlowLM for local AI generation?',
    );
    expect(document.body.textContent).toContain('SHA-256');
    expect(document.body.textContent).toContain('Authenticode');

    buttonByText(document.body, 'Install')?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(apiClient.startRuntimeInstallation).toHaveBeenCalledWith(
      'fastflowlm',
    );
  });
});

const FASTFLOW_TERMS_URL =
  'https://raw.githubusercontent.com/FastFlowLM/FastFlowLM/v0.9.43/src/inno/terms.txt';

function fastFlowSelection(overrides: Record<string, unknown> = {}) {
  return {
    preference: 'auto',
    selected_provider: 'fastflowlm',
    effective_provider: 'fastflowlm',
    configured_model: 'qwen3.5:4b',
    effective_model: 'qwen3.5:4b',
    selection_reason: 'Compatible XDNA2 hardware detected.',
    fallback_reason: null,
    hardware_compatible: true,
    requires_terms_acceptance: true,
    terms_accepted: false,
    terms_version: '0.9.43',
    terms_url: FASTFLOW_TERMS_URL,
    runtime_requirement_kind: 'fastflowlm',
    model_requirement_kind: 'fastflowlm_model',
    ...overrides,
  };
}

function fastFlowRuntimeMissingRequirement(unavailableReason: string) {
  return {
    kind: 'fastflowlm',
    label: 'FastFlowLM',
    available: false,
    detail: 'FastFlowLM setup is required.',
    unavailable_reason: unavailableReason,
    version: '0.9.43',
    bytes: 18_577_840,
    installed_path: null,
  };
}

function fastFlowRuntimeAvailableRequirement() {
  return {
    ...fastFlowRuntimeMissingRequirement('fastflowlm_missing'),
    available: true,
    detail: 'FastFlowLM 0.9.43 is installed.',
    unavailable_reason: null,
    installed_path: 'C:\\Program Files\\flm\\flm.exe',
  };
}

function fastFlowModelRequirement(unavailableReason: string) {
  return {
    kind: 'fastflowlm_model',
    label: 'FastFlowLM model',
    available: false,
    detail: 'FastFlowLM model setup is required.',
    unavailable_reason: unavailableReason,
    version: 'qwen3.5:4b',
    bytes: null,
    installed_path: null,
  };
}

function fastFlowNotRunningHealth() {
  return {
    provider: 'fastflowlm',
    model: 'qwen3.5:4b',
    available: false,
    detail: 'FastFlowLM server is not running.',
    unavailable_reason: 'fastflowlm_not_running',
    configured_model: 'qwen3.5:4b',
    effective_model: null,
    fallback_models: ['qwen3.5:2b'],
    fallback_reason: null,
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
