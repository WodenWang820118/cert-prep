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
    decideFastflowlmTerms: ReturnType<typeof vi.fn>;
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
          hardware_compatible: false,
          requires_terms_acceptance: false,
          terms_version: null,
          terms_url: null,
          runtime_requirement_kind: 'ollama',
          model_requirement_kind: 'ollama_model',
        }),
      ),
      decideFastflowlmTerms: vi.fn(),
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

  it('keeps FastFlow install blocked until the exact publisher terms are accepted', async () => {
    const fixture = TestBed.createComponent(RuntimeConsentDialogsComponent);
    const health = TestBed.inject(HealthStore);
    const fastFlowSelection = providerSelection();
    health.providerSelection.set(fastFlowSelection);
    health.llmHealth.set({
      ...missingModelHealth(),
      provider: 'fastflowlm',
      model: 'qwen3.5:4b',
      detail: 'FastFlowLM is not installed.',
      unavailable_reason: 'fastflowlm_missing',
    });
    health.runtimeRequirements.set([
      {
        kind: 'fastflowlm',
        label: 'FastFlowLM',
        available: false,
        detail: 'FastFlowLM is not installed.',
        unavailable_reason: 'fastflowlm_missing',
      },
    ]);
    apiClient.decideFastflowlmTerms.mockResolvedValue({
      ...fastFlowSelection,
      terms_accepted: true,
    });
    apiClient.startRuntimeInstallation.mockResolvedValue(
      runtimeInstallation({
        kind: 'fastflowlm',
        provider: 'fastflowlm',
        model: 'qwen3.5:4b',
        status: 'succeeded',
        completed: 100,
      }),
    );

    health.openFastFlowInstallConsent();
    fixture.detectChanges();
    await fixture.whenStable();

    const termsLink = document.body.querySelector<HTMLAnchorElement>(
      'a.fastflow-terms-link',
    );
    const checkbox = document.body.querySelector<HTMLInputElement>(
      '#fastflow-runtime-terms',
    );
    const install = lastButtonByText(document.body, 'Install');
    expect(termsLink?.href).toContain(
      '/FastFlowLM/FastFlowLM/v0.9.43/src/inno/terms.txt',
    );
    expect(checkbox?.checked).toBe(false);
    expect(install?.disabled).toBe(true);

    checkbox?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(lastButtonByText(document.body, 'Install')?.disabled).toBe(false);
    lastButtonByText(document.body, 'Install')?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    await vi.waitFor(() => {
      expect(apiClient.decideFastflowlmTerms).toHaveBeenCalledWith({
        decision: 'accepted',
        terms_version: '0.9.43',
      });
      expect(apiClient.startRuntimeInstallation).toHaveBeenCalledWith(
        'fastflowlm',
        { fastflowlm_terms_accepted_version: '0.9.43' },
      );
    });
  });

  it('persists a FastFlow decline and opens Ollama onboarding', async () => {
    const fixture = TestBed.createComponent(RuntimeConsentDialogsComponent);
    const health = TestBed.inject(HealthStore);
    const fastFlowSelection = providerSelection();
    const ollamaSelection = providerSelection({
      selected_provider: 'ollama',
      effective_provider: 'ollama',
      selection_reason: 'Auto-selected Ollama because FastFlowLM terms were declined.',
      fallback_reason: 'FastFlowLM terms were declined.',
      requires_terms_acceptance: false,
      terms_accepted: false,
      terms_version: null,
      terms_url: null,
      runtime_requirement_kind: 'ollama',
      model_requirement_kind: 'ollama_model',
    });
    health.providerSelection.set(fastFlowSelection);
    health.llmHealth.set({
      ...missingModelHealth(),
      provider: 'fastflowlm',
      detail: 'FastFlowLM is not installed.',
      unavailable_reason: 'fastflowlm_missing',
    });
    health.runtimeRequirements.set([
      {
        kind: 'fastflowlm',
        label: 'FastFlowLM',
        available: false,
        detail: 'FastFlowLM is not installed.',
        unavailable_reason: 'fastflowlm_missing',
      },
      {
        kind: 'ollama',
        label: 'Ollama',
        available: false,
        detail: 'Ollama is not installed.',
        unavailable_reason: 'ollama_missing',
      },
    ]);
    apiClient.decideFastflowlmTerms.mockResolvedValue(ollamaSelection);
    apiClient.llmProviderSelection.mockResolvedValue(ollamaSelection);
    apiClient.runtimeRequirements.mockResolvedValue({
      items: health.runtimeRequirements(),
    });

    health.openFastFlowInstallConsent();
    fixture.detectChanges();
    await fixture.whenStable();

    buttonByText(document.body, 'Decline and use Ollama')?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    await vi.waitFor(() => {
      expect(apiClient.decideFastflowlmTerms).toHaveBeenCalledWith({
        decision: 'declined',
        terms_version: '0.9.43',
      });
      expect(health.providerSelection()?.selected_provider).toBe('ollama');
      expect(health.runtimeInstallConsentKind()).toBe('ollama');
    });
    expect(apiClient.startRuntimeInstallation).not.toHaveBeenCalled();
    fixture.detectChanges();
    expect(document.body.textContent).toContain(
      'Install Ollama for local AI generation?',
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

function lastButtonByText(
  root: ParentNode,
  text: string,
): HTMLButtonElement | null {
  return (
    Array.from(root.querySelectorAll('button'))
      .reverse()
      .find((button) => button.textContent?.includes(text)) ?? null
  );
}
