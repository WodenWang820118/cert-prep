import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { CertPrepHttpResourceClient } from '../../cert-prep-http-resource-client';
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
  private readonly systemHealthResource = this.resources.health(() =>
    this.healthRequested(),
  );
  private readonly llmHealthResource = this.resources.llmHealth(() =>
    this.healthRequested(),
  );
  private readonly ocrHealthResource = this.resources.ocrHealth(() =>
    this.healthRequested(),
  );
  private readonly providerSelectionResource =
    this.resources.providerSelection(() => this.healthRequested());
  private readonly runtimeRequirementsResource =
    this.resources.runtimeRequirements(() => this.healthRequested());
  private healthReloadPending = false;
  private lastOcrResourceStatus: string | null = null;
  private readonly resourceSync = effect(() => {
    this.syncHealthResources();
  });

  readonly llmHealth = this.status.llmHealth;
  readonly systemHealth = this.status.systemHealth;
  readonly ocrHealth = this.status.ocrHealth;
  readonly providerSelection = this.status.providerSelection;
  readonly healthSnapshotLoading = this.status.healthSnapshotLoading;
  readonly runtimeRequirements = this.status.runtimeRequirements;
  readonly modelDownloadConsentVisible =
    this.actions.modelDownloadConsentVisible;
  readonly modelDownloadStarting = this.actions.modelDownloadStarting;
  readonly modelDownloadCanceling = this.actions.modelDownloadCanceling;
  readonly modelDownload = this.actions.modelDownload;
  readonly runtimeInstallConsentKind = this.actions.runtimeInstallConsentKind;
  readonly runtimeInstallStarting = this.actions.runtimeInstallStarting;
  readonly runtimeInstallCanceling = this.actions.runtimeInstallCanceling;
  readonly runtimeInstall = this.actions.runtimeInstall;

  readonly isModelMissing = this.status.isModelMissing;
  readonly isConfiguredModelMissing = this.status.isConfiguredModelMissing;
  readonly isModelDownloadActive = this.actions.isModelDownloadActive;
  readonly isRuntimeInstallActive = this.actions.isRuntimeInstallActive;
  readonly canCancelModelDownload = this.actions.canCancelModelDownload;
  readonly canCancelRuntimeInstallation =
    this.actions.canCancelRuntimeInstallation;
  readonly isOllamaMissing = this.status.isOllamaMissing;
  readonly isLlmRuntimeMissing = this.status.isLlmRuntimeMissing;
  readonly llmProviderLabel = this.status.llmProviderLabel;
  readonly selectedProviderLabel = this.status.selectedProviderLabel;
  readonly effectiveProviderLabel = this.status.effectiveProviderLabel;
  readonly isOcrRuntimeMissing = this.status.isOcrRuntimeMissing;
  readonly ocrPhase = this.status.ocrPhase;
  readonly isOcrHealthLoading = this.status.isOcrHealthLoading;
  readonly canDownloadModel = computed(() => {
    const modelRequirementMissing = this.selectedModelRequirementMissing();
    return (
      !this.isLlmRuntimeMissing() &&
      (this.isConfiguredModelMissing() || modelRequirementMissing) &&
      !this.isModelDownloadActive()
    );
  });
  readonly canInstallOllama = computed(
    () =>
      this.providerAllows('ollama') &&
      this.isOllamaMissing() &&
      !this.isRuntimeInstallActive(),
  );
  readonly canInstallOcrRuntime = computed(
    () => this.isOcrRuntimeMissing() && !this.isRuntimeInstallActive(),
  );
  readonly whisperModelsRequirement = computed(
    () => this.runtimeRequirement('whisper_models'),
  );
  readonly areWhisperModelsReady = computed(
    () => this.whisperModelsRequirement()?.available === true,
  );
  readonly areWhisperModelsMissing = computed(
    () => this.whisperModelsRequirement()?.available === false,
  );
  readonly canInstallWhisperModels = computed(
    () => this.areWhisperModelsMissing() && !this.isRuntimeInstallActive(),
  );
  readonly runtimeInstallConsentVisible =
    this.actions.runtimeInstallConsentVisible;
  readonly configuredModelName = this.status.configuredModelName;
  readonly effectiveModelName = this.status.effectiveModelName;

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
      this.operations.status.set('Runtime health refreshed');
      return;
    }
    this.reloadHealthResources();
    this.operations.status.set('Runtime health refreshed');
  }

  openModelDownloadConsent(): void {
    this.actions.openModelDownloadConsent(this.canDownloadModel());
  }

  setModelDownloadConsentVisible(visible: boolean): void {
    this.actions.setModelDownloadConsentVisible(
      visible,
      this.canDownloadModel(),
    );
  }

  cancelModelDownloadConsent(): void {
    this.actions.cancelModelDownloadConsent();
  }

  async confirmModelDownload(): Promise<void> {
    await this.actions.confirmModelDownload(this.runtimeActionContext());
  }

  openRuntimeInstallConsent(kind: RuntimeKind): void {
    this.actions.openRuntimeInstallConsent(kind, this.canInstallRuntime(kind));
  }

  openOcrRuntimeInstallConsent(): void {
    this.actions.openOcrRuntimeInstallConsent(
      this.status.ocrRuntimeKind(),
      this.isRuntimeInstallActive(),
    );
  }

  openOllamaInstallConsent(): void {
    this.openRuntimeInstallConsent('ollama');
  }

  openWhisperModelsConsent(): void {
    this.openRuntimeInstallConsent('whisper_models');
  }

  refreshRuntimeRequirements(): void {
    this.runtimeRequirementsResource.reload();
  }

  async loadRuntimeRequirementsForUpload(): Promise<void> {
    const response =
      await this.runtimeApi.runtimeInstallationClient().runtimeRequirements();
    this.runtimeRequirementsResource.set(response.items);
    this.status.applyHealthSnapshot({ runtimeRequirements: response.items });
  }

  setRuntimeInstallConsentVisible(visible: boolean): void {
    this.actions.setRuntimeInstallConsentVisible(visible);
  }

  cancelRuntimeInstallConsent(): void {
    this.actions.cancelRuntimeInstallConsent();
  }

  async confirmRuntimeInstallation(): Promise<void> {
    await this.actions.confirmRuntimeInstallation(this.runtimeActionContext());
  }

  async refreshRuntimeInstallation(): Promise<void> {
    await this.actions.refreshRuntimeInstallation(this.runtimeActionContext());
  }

  async refreshModelDownload(): Promise<void> {
    await this.actions.refreshModelDownload(this.runtimeActionContext());
  }

  async cancelModelDownload(): Promise<void> {
    await this.actions.cancelModelDownload(this.runtimeActionContext());
  }

  async cancelRuntimeInstallation(): Promise<void> {
    await this.actions.cancelRuntimeInstallation(this.runtimeActionContext());
  }

  private runtimeActionContext() {
    return {
      canDownloadModel: () => this.canDownloadModel(),
      canInstallRuntime: (kind: RuntimeKind) => this.canInstallRuntime(kind),
      configuredModelName: () => this.configuredModelName(),
      refreshHealthAfterRuntimeChange: (): void => this.load(),
    };
  }

  private canInstallRuntime(kind: RuntimeKind): boolean {
    if (this.isRuntimeInstallActive()) {
      return false;
    }

    if (kind === 'ollama') {
      return this.isOllamaMissing();
    }

    if (this.isOcrRuntimeKind(kind)) {
      return (
        this.isOcrRuntimeMissing() || this.runtimeInstallConsentKind() === kind
      );
    }

    if (kind === 'whisper_models') {
      return (
        this.areWhisperModelsMissing() ||
        this.runtimeInstallConsentKind() === kind
      );
    }

    return false;
  }

  private isOcrRuntimeKind(kind: RuntimeKind | null | undefined): boolean {
    return kind === 'paddle_ocr' || kind === 'windowsml_ocr';
  }

  private selectedModelRequirementMissing(): boolean {
    const kind = this.providerSelection()?.model_requirement_kind;
    return kind !== null && kind !== undefined
      ? this.runtimeRequirementMissing(kind)
      : false;
  }

  private runtimeRequirementMissing(kind: string): boolean {
    return this.runtimeRequirements().some(
      (requirement) =>
        requirement.kind === kind && requirement.available === false,
    );
  }

  private runtimeRequirement(kind: string) {
    return (
      this.runtimeRequirements().find(
        (requirement) => requirement.kind === kind,
      ) ?? null
    );
  }

  private providerAllows(provider: string): boolean {
    const selection = this.providerSelection();
    return (
      selection === null ||
      selection.selected_provider.trim().toLowerCase() === provider
    );
  }

  private reloadHealthResources(): void {
    this.systemHealthResource.reload();
    this.llmHealthResource.reload();
    this.ocrHealthResource.reload();
    this.providerSelectionResource.reload();
    this.runtimeRequirementsResource.reload();
  }

  private syncHealthResources(): void {
    if (this.isResolved(this.systemHealthResource.status())) {
      const health = this.systemHealthResource.value();
      if (health !== null) {
        this.status.applyHealthSnapshot({ system: health });
      }
    }

    if (this.isResolved(this.llmHealthResource.status())) {
      const health = this.llmHealthResource.value();
      if (health !== null) {
        this.status.applyHealthSnapshot({ llm: health });
      }
    }

    const ocrStatus = this.ocrHealthResource.status();
    if (this.isResolved(ocrStatus)) {
      const health = this.ocrHealthResource.value();
      if (health !== null) {
        this.status.applyHealthSnapshot({ ocr: health });
      }
    }
    if (ocrStatus !== this.lastOcrResourceStatus) {
      this.lastOcrResourceStatus = ocrStatus;
      if (ocrStatus === 'error') {
        this.status.recordOcrHealthResult({});
      }
    }

    if (this.isResolved(this.providerSelectionResource.status())) {
      const selection = this.providerSelectionResource.value();
      if (selection !== null) {
        this.status.applyHealthSnapshot({ providerSelection: selection });
      }
    }

    if (this.isResolved(this.runtimeRequirementsResource.status())) {
      this.status.applyHealthSnapshot({
        runtimeRequirements: this.runtimeRequirementsResource.value(),
      });
    }

    const healthResources = [
      this.systemHealthResource,
      this.llmHealthResource,
      this.ocrHealthResource,
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
