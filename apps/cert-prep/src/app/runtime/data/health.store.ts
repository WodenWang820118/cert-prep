import {
  computed,
  effect,
  inject,
  Injectable,
  signal,
  untracked,
} from '@angular/core';
import { from, Subject } from 'rxjs';
import { CertPrepHttpResourceClient } from '../../core/data';
import type { LLMRequirementKind } from '../../core/domain';
import { HealthStatusStore } from './health-status.store';
import { LLMInstallationActionsStore } from './llm-installation-actions.store';
import { LLMApiClientsService } from './llm-api-clients.service';
import { OperationStore } from '../../core/data';

@Injectable({ providedIn: 'root' })
export class HealthStore {
  private readonly operations = inject(OperationStore);
  private readonly resources = inject(CertPrepHttpResourceClient);
  private readonly status = inject(HealthStatusStore);
  private readonly actions = inject(LLMInstallationActionsStore);
  private readonly runtimeApi = inject(LLMApiClientsService);
  private readonly healthRequested = signal(false);
  private readonly systemHealthResource = this.resources.health(() =>
    this.healthRequested(),
  );
  private readonly llmHealthResource = this.resources.llmHealth(() =>
    this.healthRequested(),
  );
  private readonly providerSelectionResource = this.resources.providerSelection(
    () => this.healthRequested(),
  );
  private readonly llmRequirementsResource =
    this.resources.llmRequirements(() => this.healthRequested());
  private healthReloadPending = false;
  private readonly healthRefreshFinished = new Subject<void>();
  // Emitted after all snapshot resources settle, including failed requests.
  readonly healthRefreshFinished$ = this.healthRefreshFinished.asObservable();
  private readonly resourceSync = effect(() => this.syncHealthResources());

  readonly llmHealth = this.status.llmHealth;
  readonly systemHealth = this.status.systemHealth;
  readonly providerSelection = this.status.providerSelection;
  readonly healthSnapshotLoading = this.status.healthSnapshotLoading;
  readonly llmRequirements = this.status.llmRequirements;
  readonly modelDownloadConsentVisible =
    this.actions.modelDownloadConsentVisible;
  readonly modelDownloadStarting = this.actions.modelDownloadStarting;
  readonly modelDownloadCanceling = this.actions.modelDownloadCanceling;
  readonly modelDownload = this.actions.modelDownload;
  readonly modelDownloadStreamError = this.actions.modelDownloadStreamError;
  readonly llmEngineInstallConsentKind = this.actions.llmEngineInstallConsentKind;
  readonly llmEngineInstallStarting = this.actions.llmEngineInstallStarting;
  readonly llmEngineInstallCanceling = this.actions.llmEngineInstallCanceling;
  readonly llmEngineInstall = this.actions.llmEngineInstall;
  readonly llmEngineInstallStreamError = this.actions.llmEngineInstallStreamError;
  readonly isModelMissing = this.status.isModelMissing;
  readonly isConfiguredModelMissing = this.status.isConfiguredModelMissing;
  readonly isModelDownloadActive = this.actions.isModelDownloadActive;
  readonly isLLMEngineInstallActive = this.actions.isLLMEngineInstallActive;
  readonly canCancelModelDownload = this.actions.canCancelModelDownload;
  readonly canCancelLLMEngineInstallation =
    this.actions.canCancelLLMEngineInstallation;
  readonly isOllamaMissing = this.status.isOllamaMissing;
  readonly isLlmRuntimeMissing = this.status.isLlmRuntimeMissing;
  readonly llmProviderLabel = this.status.llmProviderLabel;
  readonly selectedProviderLabel = this.status.selectedProviderLabel;
  readonly effectiveProviderLabel = this.status.effectiveProviderLabel;
  readonly configuredModelName = this.status.configuredModelName;
  readonly effectiveModelName = this.status.effectiveModelName;

  readonly canDownloadModel = computed(() => {
    const selectedModelMissing =
      this.providerSelection()?.model_requirement_kind;
    const requirementMissing =
      selectedModelMissing !== null && selectedModelMissing !== undefined
        ? this.llmRequirements().some(
            (item) =>
              item.kind === selectedModelMissing && item.available === false,
          )
        : false;
    return (
      !this.isLlmRuntimeMissing() &&
      (this.isConfiguredModelMissing() || requirementMissing) &&
      !this.isModelDownloadActive()
    );
  });

  readonly canInstallOllama = computed(
    () =>
      this.providerAllows('ollama') &&
      this.isOllamaMissing() &&
      !this.isLLMEngineInstallActive(),
  );

  readonly llmEngineInstallConsentVisible =
    this.actions.llmEngineInstallConsentVisible;

  load(): void {
    if (!this.healthReloadPending) this.status.beginHealthSnapshotLoad();
    this.healthReloadPending = true;
    if (!this.healthRequested()) {
      this.healthRequested.set(true);
      return;
    }
    this.reloadHealthResources();
  }

  refresh(): void {
    if (!this.healthReloadPending) this.status.beginHealthSnapshotLoad();
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
    this.actions.setModelDownloadConsentVisible(
      visible,
      this.canDownloadModel(),
    );
  }

  cancelModelDownloadConsent(): void {
    this.actions.cancelModelDownloadConsent();
  }
  confirmModelDownload(): void {
    this.actions.confirmModelDownload(this.llmInstallationActionContext());
  }

  openLLMEngineInstallConsent(kind: LLMRequirementKind): void {
    this.actions.openLLMEngineInstallConsent(kind, this.canInstallLLMEngine(kind));
  }

  openOllamaInstallConsent(): void {
    this.openLLMEngineInstallConsent('ollama');
  }
  refreshLLMRequirements(): void {
    this.llmRequirementsResource.reload();
  }

  loadLLMRequirementsForUpload(): void {
    from(
      this.runtimeApi.llmInstallationClient().llmRequirements(),
    ).subscribe({
      next: (response) => {
        this.llmRequirementsResource.set(response.items);
        this.status.applyHealthSnapshot({
          llmRequirements: response.items,
        });
      },
      error: () =>
        this.operations.fail(
          'Capture Runtime requirements could not be loaded.',
        ),
    });
  }

  setLLMEngineInstallConsentVisible(visible: boolean): void {
    this.actions.setLLMEngineInstallConsentVisible(visible);
  }
  cancelLLMEngineInstallConsent(): void {
    this.actions.cancelLLMEngineInstallConsent();
  }
  confirmLLMEngineInstallation(): void {
    this.actions.confirmLLMEngineInstallation(this.llmInstallationActionContext());
  }
  refreshLLMEngineInstallation(): void {
    this.actions.refreshLLMEngineInstallation(this.llmInstallationActionContext());
  }
  refreshModelDownload(): void {
    this.actions.refreshModelDownload(this.llmInstallationActionContext());
  }
  cancelModelDownload(): void {
    this.actions.cancelModelDownload(this.llmInstallationActionContext());
  }
  cancelLLMEngineInstallation(): void {
    this.actions.cancelLLMEngineInstallation(this.llmInstallationActionContext());
  }

  private llmInstallationActionContext() {
    return {
      canDownloadModel: () => this.canDownloadModel(),
      canInstallLLMEngine: (kind: LLMRequirementKind) => this.canInstallLLMEngine(kind),
      configuredModelName: () => this.configuredModelName(),
      refreshHealthAfterLLMInstallation: (): void => this.load(),
    };
  }

  private canInstallLLMEngine(kind: LLMRequirementKind): boolean {
    if (this.isLLMEngineInstallActive()) return false;
    return (
      kind === 'ollama' &&
      (this.isOllamaMissing() || this.llmEngineInstallConsentKind() === kind)
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
    this.providerSelectionResource.reload();
    this.llmRequirementsResource.reload();
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
      if (value !== null)
        this.status.applyHealthSnapshot({ providerSelection: value });
    }
    if (this.isResolved(this.llmRequirementsResource.status())) {
      this.status.applyHealthSnapshot({
        llmRequirements: this.llmRequirementsResource.value(),
      });
    }
    const healthResources = [
      this.systemHealthResource,
      this.llmHealthResource,
      this.providerSelectionResource,
      this.llmRequirementsResource,
    ];
    if (
      this.healthReloadPending &&
      healthResources.every((resource) => resource.status() !== 'idle') &&
      !healthResources.some((resource) => resource.isLoading())
    ) {
      this.healthReloadPending = false;
      this.status.endHealthSnapshotLoad();
      untracked(() => this.healthRefreshFinished.next());
    }
  }

  private isResolved(status: string): boolean {
    return status === 'resolved' || status === 'local';
  }
}
