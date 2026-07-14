import { computed, inject, Injectable } from '@angular/core';
import type {
  FastFlowTermsConsent,
  LLMProviderSelectionRead,
  RuntimeKind,
} from './contracts/health-runtime.contracts';
import { HealthSnapshotService } from './health-snapshot.service';
import { HealthStatusStore } from './health-status.store';
import { RuntimeActionsStore } from './runtime-actions.store';
import { OperationStore } from '../operation.store';

@Injectable({ providedIn: 'root' })
export class HealthStore {
  private readonly operations = inject(OperationStore);
  private readonly snapshots = inject(HealthSnapshotService);
  private readonly status = inject(HealthStatusStore);
  private readonly actions = inject(RuntimeActionsStore);

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
  readonly fastFlowTermsAcknowledged =
    this.actions.fastFlowTermsAcknowledged;
  readonly fastFlowTermsDecisionPending =
    this.actions.fastFlowTermsDecisionPending;

  readonly isModelMissing = this.status.isModelMissing;
  readonly isConfiguredModelMissing = this.status.isConfiguredModelMissing;
  readonly isModelFallbackActive = this.status.isModelFallbackActive;
  readonly isModelDownloadActive = this.actions.isModelDownloadActive;
  readonly isRuntimeInstallActive = this.actions.isRuntimeInstallActive;
  readonly canCancelModelDownload = this.actions.canCancelModelDownload;
  readonly canCancelRuntimeInstallation =
    this.actions.canCancelRuntimeInstallation;
  readonly isOllamaMissing = this.status.isOllamaMissing;
  readonly isFastFlowRuntimeMissing = this.status.isFastFlowRuntimeMissing;
  readonly isLlmRuntimeMissing = this.status.isLlmRuntimeMissing;
  readonly llmProviderLabel = this.status.llmProviderLabel;
  readonly selectedProviderLabel = this.status.selectedProviderLabel;
  readonly effectiveProviderLabel = this.status.effectiveProviderLabel;
  readonly isFastFlowSelected = this.status.isFastFlowSelected;
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
  readonly canInstallFastFlow = computed(
    () =>
      this.isFastFlowSelected() &&
      this.isFastFlowRuntimeMissing() &&
      !this.isRuntimeInstallActive(),
  );
  readonly canInstallOcrRuntime = computed(
    () => this.isOcrRuntimeMissing() && !this.isRuntimeInstallActive(),
  );
  readonly runtimeInstallConsentVisible =
    this.actions.runtimeInstallConsentVisible;
  readonly configuredModelName = this.status.configuredModelName;
  readonly effectiveModelName = this.status.effectiveModelName;
  readonly fastFlowTerms = computed<FastFlowTermsConsent | null>(() => {
    const selection = this.providerSelection();
    const version = selection?.terms_version?.trim();
    const url = selection?.terms_url?.trim();
    if (!version || !url) {
      return null;
    }
    return { version, url };
  });
  readonly fastFlowTermsConsentRequired = computed(() => {
    const runtimeKind = this.runtimeInstallConsentKind();
    return (
      (this.modelDownloadConsentVisible() && this.isFastFlowSelected()) ||
      runtimeKind === 'fastflowlm' ||
      runtimeKind === 'fastflowlm_model'
    );
  });
  readonly canConfirmFastFlowTerms = computed(
    () =>
      !this.fastFlowTermsConsentRequired() ||
      (this.fastFlowTerms() !== null &&
        this.fastFlowTermsAcknowledged() &&
        !this.fastFlowTermsDecisionPending()),
  );

  async load(): Promise<void> {
    this.status.beginHealthSnapshotLoad();
    try {
      const snapshot = await this.snapshots.load((partial) =>
        this.status.applyHealthSnapshot(partial),
      );
      this.status.applyHealthSnapshot(snapshot);
      this.status.recordOcrHealthResult(snapshot);
    } catch (error) {
      this.status.recordOcrHealthResult({});
      throw error;
    } finally {
      this.status.endHealthSnapshotLoad();
    }
  }

  async refresh(): Promise<void> {
    this.status.beginHealthSnapshotLoad();
    try {
      const health = await this.operations.run(
        'health',
        'Runtime health refreshed',
        async () =>
          this.snapshots.load((snapshot) =>
            this.status.applyHealthSnapshot(snapshot),
          ),
      );
      if (health !== null) {
        this.status.applyHealthSnapshot(health);
        this.status.recordOcrHealthResult(health);
      } else {
        this.status.recordOcrHealthResult({});
      }
    } finally {
      this.status.endHealthSnapshotLoad();
    }
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
    this.actions.openRuntimeInstallConsent(
      kind,
      this.canInstallRuntime(kind),
    );
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

  openFastFlowInstallConsent(): void {
    this.openRuntimeInstallConsent('fastflowlm');
  }

  setFastFlowTermsAcknowledged(acknowledged: boolean): void {
    this.actions.setFastFlowTermsAcknowledged(acknowledged);
  }

  async declineFastFlowTerms(): Promise<void> {
    const declined = await this.actions.declineFastFlowTerms(
      this.runtimeActionContext(),
    );
    if (!declined) {
      return;
    }

    try {
      await this.load();
    } catch {
      // The persisted selection returned by the decision endpoint remains the
      // source of truth even if an optional health refresh is unavailable.
    }

    if (!this.providerAllows('ollama')) {
      return;
    }
    if (this.runtimeRequirementMissing('ollama')) {
      this.actions.openRuntimeInstallConsent('ollama', true);
      return;
    }
    if (
      this.runtimeRequirementMissing('ollama_model') ||
      this.canDownloadModel()
    ) {
      this.actions.openModelDownloadConsent(true);
    }
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
      fastFlowModelSelected: () => this.isFastFlowSelected(),
      fastFlowTerms: () => this.fastFlowTerms(),
      applyProviderSelection: (selection: LLMProviderSelectionRead) =>
        this.status.applyProviderSelection(selection),
      refreshHealthAfterRuntimeChange: () => this.load(),
    };
  }

  private canInstallRuntime(kind: RuntimeKind): boolean {
    if (this.isRuntimeInstallActive()) {
      return false;
    }

    if (kind === 'ollama') {
      return this.isOllamaMissing();
    }

    if (kind === 'fastflowlm') {
      return this.canInstallFastFlow();
    }

    if (kind === 'fastflowlm_model') {
      return this.isFastFlowSelected() && this.selectedModelRequirementMissing();
    }

    if (this.isOcrRuntimeKind(kind)) {
      return (
        this.isOcrRuntimeMissing() ||
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

  private providerAllows(provider: string): boolean {
    const selection = this.providerSelection();
    return (
      selection === null ||
      selection.selected_provider.trim().toLowerCase() === provider
    );
  }
}
