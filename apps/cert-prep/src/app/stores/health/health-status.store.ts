import { computed, inject, Injectable, signal } from '@angular/core';
import {
  HealthResponse,
  LLMHealthRead,
  OCRHealthRead,
  RuntimeRequirementRead,
} from '../../cert-prep-api';
import type {
  HealthSnapshot,
  OcrHealthPhase,
  RuntimeKind,
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
  readonly ocrHealth = signal<OCRHealthRead | null>(null);
  readonly healthSnapshotLoading = signal(false);
  private readonly ocrHealthLoadFailed = signal(false);
  private readonly ocrHealthRefreshPending = signal(false);
  private readonly ocrHealthStale = signal(false);
  readonly runtimeRequirements = signal<RuntimeRequirementRead[]>([]);

  readonly isModelMissing = computed(() =>
    this.runtimeHealth.isModelMissing(this.llmHealth()),
  );
  readonly isConfiguredModelMissing = computed(() =>
    this.runtimeHealth.isConfiguredModelMissing(this.llmHealth()),
  );
  readonly isModelFallbackActive = computed(() =>
    this.runtimeHealth.isModelFallbackActive(this.llmHealth()),
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
    ),
  );
  readonly llmProviderLabel = computed(() =>
    this.runtimeHealth.llmProviderLabel(this.llmHealth()),
  );
  readonly isOcrRuntimeMissing = computed(() =>
    this.runtimeHealth.isOcrRuntimeMissing(
      this.ocrHealth(),
      this.runtimeRequirements(),
    ),
  );
  readonly ocrPhase = computed<OcrHealthPhase>(() => {
    const health = this.ocrHealth();
    const install = this.actions.runtimeInstall();
    const installingOcr =
      install !== null &&
      this.isOcrRuntimeKind(install?.kind) &&
      ['starting', 'running', 'waiting_for_user'].includes(install.phase);
    if (installingOcr && health === null) {
      return 'warming';
    }
    if (this.healthSnapshotLoading()) {
      if (health === null) {
        return 'checking';
      }
      return this.ocrHealthRefreshPending()
        ? 'stale'
        : health.available
          ? 'ready'
          : 'failed';
    }
    if (health !== null && this.ocrHealthStale()) {
      return 'stale';
    }
    if (health === null) {
      return this.ocrHealthLoadFailed() || this.isOcrRuntimeMissing()
        ? 'failed'
        : 'waiting';
    }
    return health.available ? 'ready' : 'failed';
  });
  readonly isOcrHealthLoading = computed(() =>
    ['checking', 'warming'].includes(this.ocrPhase()),
  );
  readonly configuredModelName = computed(() =>
    this.runtimeHealth.configuredModelName(
      this.llmHealth(),
      this.actions.modelDownload()?.model,
    ),
  );
  readonly effectiveModelName = computed(() =>
    this.runtimeHealth.effectiveModelName(
      this.llmHealth(),
      this.actions.modelDownload()?.model,
    ),
  );

  beginHealthSnapshotLoad(): void {
    this.healthSnapshotLoadCount += 1;
    this.healthSnapshotLoading.set(true);
    this.ocrHealthLoadFailed.set(false);
    this.ocrHealthRefreshPending.set(true);
  }

  endHealthSnapshotLoad(): void {
    this.healthSnapshotLoadCount = Math.max(
      0,
      this.healthSnapshotLoadCount - 1,
    );
    if (this.healthSnapshotLoadCount === 0) {
      this.healthSnapshotLoading.set(false);
    }
  }

  applyHealthSnapshot(snapshot: Partial<HealthSnapshot>): void {
    if (snapshot.system !== undefined) {
      this.systemHealth.set(snapshot.system);
    }
    if (snapshot.llm !== undefined) {
      this.llmHealth.set(snapshot.llm);
    }
    if (snapshot.ocr !== undefined) {
      this.ocrHealth.set(snapshot.ocr);
      this.ocrHealthLoadFailed.set(false);
      this.ocrHealthRefreshPending.set(false);
      this.ocrHealthStale.set(false);
    }
    if (snapshot.runtimeRequirements !== undefined) {
      this.runtimeRequirements.set(snapshot.runtimeRequirements);
    }
  }

  recordOcrHealthResult(snapshot: Partial<HealthSnapshot>): void {
    if (snapshot.ocr !== undefined) {
      return;
    }
    this.ocrHealthRefreshPending.set(false);
    if (this.ocrHealth() === null) {
      this.ocrHealthLoadFailed.set(true);
    } else {
      this.ocrHealthStale.set(true);
    }
  }

  ocrRuntimeKind(): Extract<RuntimeKind, 'paddle_ocr' | 'windowsml_ocr'> {
    return this.runtimeHealth.ocrRuntimeKind(
      this.ocrHealth(),
      this.runtimeRequirements(),
    );
  }

  private isOcrRuntimeKind(kind: RuntimeKind | null | undefined): boolean {
    return kind === 'paddle_ocr' || kind === 'windowsml_ocr';
  }
}
