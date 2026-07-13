import { computed, inject, Injectable } from '@angular/core';
import type { RuntimeKind } from './contracts/health-runtime.contracts';
import { HealthSnapshotService } from './health-snapshot.service';
import { HealthStatusStore } from './health-status.store';
import { RuntimeActionsStore } from './runtime-actions.store';
import { FastFlowOnboardingStore } from './fastflow-onboarding.store';
import { OperationStore } from '../operation.store';

const SUPERSEDED_HEALTH_REFRESH_MESSAGE =
  'Runtime status changed during onboarding. Review the current status and try again.';

@Injectable({ providedIn: 'root' })
export class HealthStore {
  private healthSnapshotEpoch = 0;
  private readonly operations = inject(OperationStore);
  private readonly snapshots = inject(HealthSnapshotService);
  private readonly status = inject(HealthStatusStore);
  private readonly actions = inject(RuntimeActionsStore);
  private readonly fastFlow = inject(FastFlowOnboardingStore);

  readonly llmHealth = this.status.llmHealth;
  readonly systemHealth = this.status.systemHealth;
  readonly ocrHealth = this.status.ocrHealth;
  readonly healthSnapshotLoading = this.status.healthSnapshotLoading;
  readonly runtimeRequirements = this.status.runtimeRequirements;
  readonly modelDownloadConsentVisible =
    this.actions.modelDownloadConsentVisible;
  readonly modelDownloadStarting = this.actions.modelDownloadStarting;
  readonly modelDownload = this.actions.modelDownload;
  readonly runtimeInstallConsentKind = this.actions.runtimeInstallConsentKind;
  readonly runtimeInstallStarting = this.actions.runtimeInstallStarting;
  readonly runtimeInstall = this.actions.runtimeInstall;
  readonly fastFlowTermsConsentVisible = this.fastFlow.consentVisible;
  readonly fastFlowTermsLoading = this.fastFlow.loading;
  readonly fastFlowTermsDecisionSaving = this.fastFlow.decisionSaving;
  readonly fastFlowTermsAcknowledged = this.fastFlow.acknowledged;
  readonly fastFlowTermsVersion = this.fastFlow.termsVersion;
  readonly fastFlowTermsUrl = this.fastFlow.termsUrl;

  readonly isModelMissing = this.status.isModelMissing;
  readonly isConfiguredModelMissing = this.status.isConfiguredModelMissing;
  readonly isModelFallbackActive = this.status.isModelFallbackActive;
  readonly isModelDownloadActive = this.actions.isModelDownloadActive;
  readonly isRuntimeInstallActive = this.actions.isRuntimeInstallActive;
  readonly isOllamaMissing = this.status.isOllamaMissing;
  readonly isFastFlowTermsRequired = this.status.isFastFlowTermsRequired;
  readonly isFastFlowInstallationRequired =
    this.status.isFastFlowInstallationRequired;
  readonly isFastFlowRuntimeAvailable = this.status.isFastFlowRuntimeAvailable;
  readonly isFastFlowProvider = this.status.isFastFlowProvider;
  readonly isLlmRuntimeMissing = this.status.isLlmRuntimeMissing;
  readonly llmProviderLabel = this.status.llmProviderLabel;
  readonly isOcrRuntimeMissing = this.status.isOcrRuntimeMissing;
  readonly ocrPhase = this.status.ocrPhase;
  readonly isOcrHealthLoading = this.status.isOcrHealthLoading;
  readonly canDownloadModel = computed(
    () =>
      this.isConfiguredModelMissing() &&
      !this.isLlmRuntimeMissing() &&
      (!this.isFastFlowProvider() || this.isFastFlowRuntimeAvailable()) &&
      !this.isModelDownloadActive(),
  );
  readonly canReviewFastFlowTerms = computed(
    () =>
      this.isFastFlowTermsRequired() &&
      !this.fastFlowTermsLoading() &&
      !this.fastFlowTermsDecisionSaving(),
  );
  readonly canInstallFastFlow = computed(
    () =>
      this.isFastFlowInstallationRequired() &&
      !this.isFastFlowTermsRequired() &&
      !this.isRuntimeInstallActive(),
  );
  readonly canInstallOllama = computed(
    () => this.isOllamaMissing() && !this.isRuntimeInstallActive(),
  );
  readonly canInstallOcrRuntime = computed(
    () => this.isOcrRuntimeMissing() && !this.isRuntimeInstallActive(),
  );
  readonly runtimeInstallConsentVisible =
    this.actions.runtimeInstallConsentVisible;
  readonly configuredModelName = this.status.configuredModelName;
  readonly effectiveModelName = this.status.effectiveModelName;

  async load(): Promise<boolean> {
    const epoch = ++this.healthSnapshotEpoch;
    this.status.beginHealthSnapshotLoad();
    try {
      const snapshot = await this.snapshots.load((partial) => {
        if (epoch === this.healthSnapshotEpoch) {
          this.status.applyHealthSnapshot(partial);
        }
      });
      if (epoch !== this.healthSnapshotEpoch) {
        return false;
      }
      this.status.applyHealthSnapshot(snapshot);
      this.status.recordOcrHealthResult(snapshot);
      return true;
    } catch (error) {
      if (epoch !== this.healthSnapshotEpoch) {
        return false;
      }
      this.status.recordOcrHealthResult({});
      throw error;
    } finally {
      if (epoch === this.healthSnapshotEpoch) {
        this.status.endHealthSnapshotLoad();
      }
    }
  }

  async refresh(): Promise<void> {
    const epoch = ++this.healthSnapshotEpoch;
    this.status.beginHealthSnapshotLoad();
    try {
      const health = await this.operations.run(
        'health',
        'Runtime health refreshed',
        async () =>
          this.snapshots.load((snapshot) => {
            if (epoch === this.healthSnapshotEpoch) {
              this.status.applyHealthSnapshot(snapshot);
            }
          }),
        () => epoch === this.healthSnapshotEpoch,
      );
      if (epoch !== this.healthSnapshotEpoch) {
        return;
      }
      if (health !== null) {
        this.status.applyHealthSnapshot(health);
        this.status.recordOcrHealthResult(health);
      } else {
        this.status.recordOcrHealthResult({});
      }
    } finally {
      if (epoch === this.healthSnapshotEpoch) {
        this.status.endHealthSnapshotLoad();
      }
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

  async openFastFlowTermsConsent(): Promise<void> {
    await this.fastFlow.open(this.canReviewFastFlowTerms());
  }

  setFastFlowTermsAcknowledged(acknowledged: boolean): void {
    this.fastFlow.setAcknowledged(acknowledged);
  }

  closeFastFlowTermsConsent(): void {
    this.fastFlow.close();
  }

  async acceptFastFlowTerms(): Promise<void> {
    if (await this.fastFlow.accept(() => this.loadCurrentForOnboarding())) {
      this.openNextLlmOnboardingStep();
    }
  }

  async declineFastFlowTerms(): Promise<void> {
    if (await this.fastFlow.decline(() => this.loadCurrentForOnboarding())) {
      this.openNextLlmOnboardingStep();
    }
  }

  openFastFlowInstallConsent(): void {
    this.openRuntimeInstallConsent('fastflowlm');
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

  private runtimeActionContext() {
    return {
      canDownloadModel: () => this.canDownloadModel(),
      canInstallRuntime: (kind: RuntimeKind) => this.canInstallRuntime(kind),
      configuredModelName: () => this.configuredModelName(),
      refreshHealthAfterRuntimeChange: async (kind?: RuntimeKind) => {
        if (!(await this.load())) {
          return;
        }
        if (kind === 'fastflowlm' || kind === 'ollama') {
          this.openNextLlmOnboardingStep();
        }
      },
    };
  }

  private openNextLlmOnboardingStep(): void {
    if (this.canInstallFastFlow()) {
      this.openFastFlowInstallConsent();
      return;
    }
    if (this.canInstallOllama()) {
      this.openOllamaInstallConsent();
      return;
    }
    if (this.canDownloadModel()) {
      this.openModelDownloadConsent();
    }
  }

  private async loadCurrentForOnboarding(): Promise<void> {
    if (!(await this.load())) {
      throw new Error(SUPERSEDED_HEALTH_REFRESH_MESSAGE);
    }
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
}
