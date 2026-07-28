import { computed, inject, Injectable, signal } from '@angular/core';
import {
  HealthResponse,
  LLMHealthRead,
  RuntimeRequirementRead,
} from '../../contracts/api.contracts';
import type {
  HealthSnapshot,
  LLMProviderSelectionRead,
} from './contracts/health-runtime.contracts';
import { RuntimeActionsStore } from './runtime-actions.store';
import { RuntimeHealthDerivationService } from './runtime-health-derivation.service';

@Injectable({ providedIn: 'root' })
export class HealthStatusStore {
  private readonly actions = inject(RuntimeActionsStore);
  private readonly runtimeHealth = inject(RuntimeHealthDerivationService);
  private healthSnapshotLoadCount = 0;

  readonly llmHealth = signal<LLMHealthRead | null>(null);
  readonly systemHealth = signal<HealthResponse | null>(null);
  readonly providerSelection = signal<LLMProviderSelectionRead | null>(null);
  readonly healthSnapshotLoading = signal(false);
  readonly runtimeRequirements = signal<RuntimeRequirementRead[]>([]);

  readonly isModelMissing = computed(() =>
    this.runtimeHealth.isModelMissing(this.llmHealth(), this.runtimeRequirements()),
  );
  readonly isConfiguredModelMissing = computed(() =>
    this.runtimeHealth.isConfiguredModelMissing(
      this.llmHealth(),
      this.providerSelection(),
    ),
  );
  readonly isOllamaMissing = computed(() =>
    this.runtimeHealth.isOllamaMissing(
      this.llmHealth(),
      this.runtimeRequirements(),
    ),
  );
  readonly isLlmRuntimeMissing = computed(() =>
    this.runtimeHealth.isLlmRuntimeMissing(
      this.llmHealth(),
      this.runtimeRequirements(),
      this.providerSelection(),
    ),
  );
  readonly llmProviderLabel = computed(() =>
    this.runtimeHealth.llmProviderLabel(
      this.llmHealth(),
      this.providerSelection(),
    ),
  );
  readonly selectedProviderLabel = computed(() =>
    this.runtimeHealth.providerLabel(this.providerSelection()?.selected_provider),
  );
  readonly effectiveProviderLabel = computed(() =>
    this.runtimeHealth.providerLabel(this.providerSelection()?.effective_provider),
  );
  readonly configuredModelName = computed(() =>
    this.runtimeHealth.configuredModelName(
      this.llmHealth(),
      this.actions.modelDownload()?.model,
      this.providerSelection(),
    ),
  );
  readonly effectiveModelName = computed(() =>
    this.runtimeHealth.effectiveModelName(
      this.llmHealth(),
      this.actions.modelDownload()?.model,
      this.providerSelection(),
    ),
  );

  beginHealthSnapshotLoad(): void {
    this.healthSnapshotLoadCount += 1;
    this.healthSnapshotLoading.set(true);
  }

  endHealthSnapshotLoad(): void {
    this.healthSnapshotLoadCount = Math.max(0, this.healthSnapshotLoadCount - 1);
    if (this.healthSnapshotLoadCount === 0) {
      this.healthSnapshotLoading.set(false);
    }
  }

  applyHealthSnapshot(snapshot: Partial<HealthSnapshot>): void {
    if (snapshot.system !== undefined) this.systemHealth.set(snapshot.system);
    if (snapshot.llm !== undefined) this.llmHealth.set(snapshot.llm);
    if (snapshot.providerSelection !== undefined) {
      this.providerSelection.set(snapshot.providerSelection);
    }
    if (snapshot.runtimeRequirements !== undefined) {
      this.runtimeRequirements.set(snapshot.runtimeRequirements);
    }
  }

  applyProviderSelection(selection: LLMProviderSelectionRead): void {
    this.providerSelection.set(selection);
  }
}
