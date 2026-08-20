import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { from } from 'rxjs';
import { CertPrepHttpResourceClient } from '../../services/cert-prep-http-resource-client.service';
import type { RuntimeKind } from './contracts/health-runtime.contracts';
import { HealthStatusStore } from './health-status.store';
import { RuntimeActionsStore } from './runtime-actions.store';
import { RuntimeApiClientsService } from './runtime-api-clients.service';
import { OperationStore } from '../operation.store';

@Injectable({ providedIn: 'root' })
export class HealthStore {
  private readonly operations = inject(OperationStore);
  private readonly resources = inject(CertPrepHttpResourceClient);
  private readonly status = inject(HealthStatusStore);
  private readonly actions = inject(RuntimeActionsStore);
  private readonly runtimeApi = inject(RuntimeApiClientsService);
  private readonly healthRequested = signal(false);
  private readonly systemHealthResource = this.resources.health(() => this.healthRequested());
  private readonly llmHealthResource = this.resources.llmHealth(() => this.healthRequested());
  private readonly providerSelectionResource = this.resources.providerSelection(() => this.healthRequested());
  private readonly runtimeRequirementsResource = this.resources.runtimeRequirements(() => this.healthRequested());
  private healthReloadPending = false;
  private readonly resourceSync = effect(() => this.syncHealthResources());

  readonly llmHealth = this.status.llmHealth;
  readonly systemHealth = this.status.systemHealth;
  readonly providerSelection = this.status.providerSelection;
  readonly healthSnapshotLoading = this.status.healthSnapshotLoading;
  readonly runtimeRequirements = this.status.runtimeRequirements;
  readonly modelDownloadConsentVisible = this.actions.modelDownloadConsentVisible;
  readonly modelDownloadStarting = this.actions.modelDownloadStarting;
  readonly modelDownloadCanceling = this.actions.modelDownloadCanceling;
  readonly modelDownload = this.actions.modelDownload;
  readonly modelDownloadStreamError = this.actions.modelDownloadStreamError;
  readonly runtimeInstallConsentKind = this.actions.runtimeInstallConsentKind;
  readonly runtimeInstallStarting = this.actions.runtimeInstallStarting;
  readonly runtimeInstallCanceling = this.actions.runtimeInstallCanceling;
  readonly runtimeInstall = this.actions.runtimeInstall;
  readonly runtimeInstallStreamError = this.actions.runtimeInstallStreamError;
  readonly isModelMissing = this.status.isModelMissing;
  readonly isConfiguredModelMissing = this.status.isConfiguredModelMissing;
  readonly isModelDownloadActive = this.actions.isModelDownloadActive;
  readonly isRuntimeInstallActive = this.actions.isRuntimeInstallActive;
  readonly canCancelModelDownload = this.actions.canCancelModelDownload;
  readonly canCancelRuntimeInstallation = this.actions.canCancelRuntimeInstallation;
  readonly isOllamaMissing = this.status.isOllamaMissing;
  readonly isLlmRuntimeMissing = this.status.isLlmRuntimeMissing;
  readonly llmProviderLabel = this.status.llmProviderLabel;
  readonly selectedProviderLabel = this.status.selectedProviderLabel;
  readonly effectiveProviderLabel = this.status.effectiveProviderLabel;
  readonly configuredModelName = this.status.configuredModelName;
  readonly effectiveModelName = this.status.effectiveModelName;

  readonly canDownloadModel = computed(() => {
    const selectedModelMissing = this.providerSelection()?.model_requirement_kind;
    const requirementMissing = selectedModelMissing !== null && selectedModelMissing !== undefined
      ? this.runtimeRequirements().some((item) => item.kind === selectedModelMissing && item.available === false)
      : false;
    return !this.isLlmRuntimeMissing() &&
      (this.isConfiguredModelMissing() || requirementMissing) &&
      !this.isModelDownloadActive();
  });

  readonly canInstallOllama = computed(() =>
    this.providerAllows('ollama') && this.isOllamaMissing() && !this.isRuntimeInstallActive(),
  );

  readonly runtimeInstallConsentVisible = this.actions.runtimeInstallConsentVisible;

  load(): void {
    this.status.beginHealthSnapshotLoad();
    this.healthReloadPending = true;
    if (!this.healthRequested()) {
      this.healthRequested.set(true);
      return;
    }
    this.reloadHealthResources();
  }

  refresh(): void {
    this.status.beginHealthSnapshotLoad();
    this.healthReloadPending = true;
    if (!this.healthRequested()) {
      this.healthRequested.set(true);
    } else {
      this.reloadHealthResources();
    }
    this.operations.status.set('Runtime health refreshed');
  }

  openModelDownloadConsent(): void {
    this.actions.openModelDownloadConsent(this.canDownloadModel());
  }

  setModelDownloadConsentVisible(visible: boolean): void {
    this.actions.setModelDownloadConsentVisible(visible, this.canDownloadModel());
  }

  cancelModelDownloadConsent(): void { this.actions.cancelModelDownloadConsent(); }
  confirmModelDownload(): void { this.actions.confirmModelDownload(this.runtimeActionContext()); }

  openRuntimeInstallConsent(kind: RuntimeKind): void {
    this.actions.openRuntimeInstallConsent(kind, this.canInstallRuntime(kind));
  }

  openOllamaInstallConsent(): void { this.openRuntimeInstallConsent('ollama'); }
  refreshRuntimeRequirements(): void { this.runtimeRequirementsResource.reload(); }

  loadRuntimeRequirementsForUpload(): void {
    from(this.runtimeApi.runtimeInstallationClient().runtimeRequirements()).subscribe({
      next: (response) => {
        this.runtimeRequirementsResource.set(response.items);
        this.status.applyHealthSnapshot({ runtimeRequirements: response.items });
      },
      error: () => this.operations.fail('Capture Runtime requirements could not be loaded.'),
    });
  }

  setRuntimeInstallConsentVisible(visible: boolean): void {
    this.actions.setRuntimeInstallConsentVisible(visible);
  }
  cancelRuntimeInstallConsent(): void { this.actions.cancelRuntimeInstallConsent(); }
  confirmRuntimeInstallation(): void { this.actions.confirmRuntimeInstallation(this.runtimeActionContext()); }
  refreshRuntimeInstallation(): void { this.actions.refreshRuntimeInstallation(this.runtimeActionContext()); }
  refreshModelDownload(): void { this.actions.refreshModelDownload(this.runtimeActionContext()); }
  cancelModelDownload(): void { this.actions.cancelModelDownload(this.runtimeActionContext()); }
  cancelRuntimeInstallation(): void { this.actions.cancelRuntimeInstallation(this.runtimeActionContext()); }

  private runtimeActionContext() {
    return {
      canDownloadModel: () => this.canDownloadModel(),
      canInstallRuntime: (kind: RuntimeKind) => this.canInstallRuntime(kind),
      configuredModelName: () => this.configuredModelName(),
      refreshHealthAfterRuntimeChange: (): void => this.load(),
    };
  }

  private canInstallRuntime(kind: RuntimeKind): boolean {
    if (this.isRuntimeInstallActive()) return false;
    return kind === 'ollama' &&
      (this.isOllamaMissing() || this.runtimeInstallConsentKind() === kind);
  }

  private providerAllows(provider: string): boolean {
    const selection = this.providerSelection();
    return selection === null || selection.selected_provider.trim().toLowerCase() === provider;
  }

  private reloadHealthResources(): void {
    this.systemHealthResource.reload();
    this.llmHealthResource.reload();
    this.providerSelectionResource.reload();
    this.runtimeRequirementsResource.reload();
  }

  private syncHealthResources(): void {
    if (this.isResolved(this.systemHealthResource.status())) {
      const value = this.systemHealthResource.value();
      if (value !== null) this.status.applyHealthSnapshot({ system: value });
    }
    if (this.isResolved(this.llmHealthResource.status())) {
      const value = this.llmHealthResource.value();
      if (value !== null) this.status.applyHealthSnapshot({ llm: value });
    }
    if (this.isResolved(this.providerSelectionResource.status())) {
      const value = this.providerSelectionResource.value();
      if (value !== null) this.status.applyHealthSnapshot({ providerSelection: value });
    }
    if (this.isResolved(this.runtimeRequirementsResource.status())) {
      this.status.applyHealthSnapshot({ runtimeRequirements: this.runtimeRequirementsResource.value() });
    }
    const healthResources = [
      this.systemHealthResource,
      this.llmHealthResource,
      this.providerSelectionResource,
      this.runtimeRequirementsResource,
    ];
    if (
      this.healthReloadPending &&
      healthResources.every((resource) => resource.status() !== 'idle') &&
      !healthResources.some((resource) => resource.isLoading())
    ) {
      this.healthReloadPending = false;
      this.status.endHealthSnapshotLoad();
    }
  }

  private isResolved(status: string): boolean {
    return status === 'resolved' || status === 'local';
  }
}
