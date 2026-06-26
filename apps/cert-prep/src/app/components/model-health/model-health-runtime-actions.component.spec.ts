import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../cert-prep-api';
import { RuntimeManagerPage } from '../../pages/runtime-manager/runtime-manager.page';
import { HealthStore } from '../../stores/health/health.store';
import { RuntimeConsentDialogsComponent } from './runtime-consent-dialogs.component';
import {
  buttonByText,
  missingModelHealth,
  ocrHealth,
} from './model-health.component.spec-helpers';

describe('Runtime manager actions', () => {
  let apiClient: {
    getModelDownload: ReturnType<typeof vi.fn>;
    getRuntimeInstallation: ReturnType<typeof vi.fn>;
    health: ReturnType<typeof vi.fn>;
    llmHealth: ReturnType<typeof vi.fn>;
    ocrHealth: ReturnType<typeof vi.fn>;
    runtimeRequirements: ReturnType<typeof vi.fn>;
    startModelDownload: ReturnType<typeof vi.fn>;
    startRuntimeInstallation: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    apiClient = {
      getModelDownload: vi.fn(),
      getRuntimeInstallation: vi.fn(),
      health: vi.fn(),
      llmHealth: vi.fn(),
      ocrHealth: vi.fn(),
      runtimeRequirements: vi.fn().mockResolvedValue({ items: [] }),
      startModelDownload: vi.fn(),
      startRuntimeInstallation: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [RuntimeActionHostComponent],
      providers: [{ provide: CERT_PREP_API, useValue: apiClient }],
    }).compileComponents();
  });

  it('opens consent and cancel does not start the download', async () => {
    const fixture = TestBed.createComponent(RuntimeActionHostComponent);
    const health = TestBed.inject(HealthStore);
    health.llmHealth.set(missingModelHealth());
    health.ocrHealth.set(ocrHealth());
    fixture.detectChanges();

    buttonByText(fixture.nativeElement, 'Download reasoner:7b')?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(health.modelDownloadConsentVisible()).toBe(true);
    expect(document.body.textContent).toContain(
      'Download reasoner:7b with Ollama?',
    );

    lastButtonByText(document.body, 'Cancel')?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(health.modelDownloadConsentVisible()).toBe(false);
    expect(apiClient.startModelDownload).not.toHaveBeenCalled();
  });

  it('opens Ollama install consent for missing Ollama', async () => {
    const fixture = TestBed.createComponent(RuntimeActionHostComponent);
    const health = TestBed.inject(HealthStore);
    health.llmHealth.set({
      ...missingModelHealth(),
      detail: 'Ollama is not installed.',
      unavailable_reason: 'ollama_missing',
    });
    health.ocrHealth.set(ocrHealth());
    fixture.detectChanges();

    buttonByText(fixture.nativeElement, 'Install Ollama')?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(health.runtimeInstallConsentVisible()).toBe(true);
    expect(document.body.textContent).toContain(
      'Install Ollama for local AI generation?',
    );

    lastButtonByText(document.body, 'Cancel')?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(health.runtimeInstallConsentVisible()).toBe(false);
    expect(apiClient.startRuntimeInstallation).not.toHaveBeenCalled();
  });
});

@Component({
  imports: [RuntimeManagerPage, RuntimeConsentDialogsComponent],
  template: `
    <app-runtime-manager-page />
    <app-runtime-consent-dialogs />
  `,
})
class RuntimeActionHostComponent {}

function lastButtonByText(root: ParentNode, text: string): HTMLButtonElement | null {
  return (
    Array.from(root.querySelectorAll('button'))
      .reverse()
      .find((button) => button.textContent?.includes(text)) ?? null
  );
}
