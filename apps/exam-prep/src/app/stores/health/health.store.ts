import { computed, inject, Injectable, signal } from '@angular/core';
import {
  HealthResponse,
  LLMHealthRead,
  OCRHealthRead,
  RuntimeRequirementRead,
} from '../../exam-prep-api';
import type {
  DownloadPhase,
  HealthSnapshot,
  ModelDownloadView,
  OcrHealthPhase,
  RuntimeInstallationView,
  RuntimeKind,
} from './contracts/health-runtime.contracts';
import { HealthSnapshotService } from './health-snapshot.service';
import { RuntimeApiClientsService } from './runtime-api-clients.service';
import { RuntimeHealthDerivationService } from './runtime-health-derivation.service';
import { RuntimeJobViewService } from './runtime-job-view.service';
import { OperationStore } from '../operation.store';

const RUNTIME_JOB_POLL_INTERVAL_MS = 1500;

@Injectable({ providedIn: 'root' })
export class HealthStore {
  private readonly operations = inject(OperationStore);
  private readonly snapshots = inject(HealthSnapshotService);
  private readonly runtimeApi = inject(RuntimeApiClientsService);
  private readonly runtimeHealth = inject(RuntimeHealthDerivationService);
  private readonly jobView = inject(RuntimeJobViewService);
  private modelDownloadPollTimer: ReturnType<typeof setTimeout> | null = null;
  private runtimeInstallPollTimer: ReturnType<typeof setTimeout> | null = null;
  private healthSnapshotLoadCount = 0;

  readonly llmHealth = signal<LLMHealthRead | null>(null);
  readonly systemHealth = signal<HealthResponse | null>(null);
  readonly ocrHealth = signal<OCRHealthRead | null>(null);
  readonly healthSnapshotLoading = signal(false);
  private readonly ocrHealthLoadFailed = signal(false);
  private readonly ocrHealthRefreshPending = signal(false);
  private readonly ocrHealthStale = signal(false);
  readonly runtimeRequirements = signal<RuntimeRequirementRead[]>([]);
  readonly modelDownloadConsentVisible = signal(false);
  readonly modelDownloadStarting = signal(false);
  readonly modelDownload = signal<ModelDownloadView | null>(null);
  readonly runtimeInstallConsentKind = signal<RuntimeKind | null>(null);
  readonly runtimeInstallStarting = signal(false);
  readonly runtimeInstall = signal<RuntimeInstallationView | null>(null);

  /**
   * Derived from read-only LLM health data; starting a download remains gated by
   * explicit user consent in the component dialog.
   */
  readonly isModelMissing = computed(() =>
    this.runtimeHealth.isModelMissing(this.llmHealth()),
  );
  readonly isConfiguredModelMissing = computed(() =>
    this.runtimeHealth.isConfiguredModelMissing(this.llmHealth()),
  );
  readonly isModelFallbackActive = computed(() =>
    this.runtimeHealth.isModelFallbackActive(this.llmHealth()),
  );

  /**
   * Includes both the optimistic start flag and the last job phase so buttons
   * stay disabled across the async start-to-first-poll transition.
   */
  readonly isModelDownloadActive = computed(() => {
    const phase = this.modelDownload()?.phase;
    return (
      this.modelDownloadStarting() ||
      phase === 'starting' ||
      phase === 'running'
    );
  });

  /**
   * Treats Windows confirmation as active so the user cannot start a second
   * runtime installation while the installer waits outside the web UI.
   */
  readonly isRuntimeInstallActive = computed(() => {
    const phase = this.runtimeInstall()?.phase;
    return (
      this.runtimeInstallStarting() ||
      phase === 'starting' ||
      phase === 'running' ||
      phase === 'waiting_for_user'
    );
  });

  readonly isOllamaMissing = computed(() =>
    this.runtimeHealth.isOllamaMissing(
      this.llmHealth(),
      this.runtimeRequirements(),
    ),
  );
  readonly isOcrRuntimeMissing = computed(() =>
    this.runtimeHealth.isOcrRuntimeMissing(
      this.ocrHealth(),
      this.runtimeRequirements(),
    ),
  );
  readonly ocrPhase = computed<OcrHealthPhase>(() => {
    const health = this.ocrHealth();
    const install = this.runtimeInstall();
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
  readonly canDownloadModel = computed(
    () => this.isConfiguredModelMissing() && !this.isModelDownloadActive(),
  );
  readonly canInstallOllama = computed(
    () => this.isOllamaMissing() && !this.isRuntimeInstallActive(),
  );
  readonly canInstallOcrRuntime = computed(
    () => this.isOcrRuntimeMissing() && !this.isRuntimeInstallActive(),
  );
  readonly runtimeInstallConsentVisible = computed(
    () => this.runtimeInstallConsentKind() !== null,
  );
  readonly configuredModelName = computed(() =>
    this.runtimeHealth.configuredModelName(
      this.llmHealth(),
      this.modelDownload()?.model,
    ),
  );
  readonly effectiveModelName = computed(() =>
    this.runtimeHealth.effectiveModelName(
      this.llmHealth(),
      this.modelDownload()?.model,
    ),
  );

  async load(): Promise<void> {
    this.beginHealthSnapshotLoad();
    try {
      const snapshot = await this.snapshots.load((partial) =>
        this.applyHealthSnapshot(partial),
      );
      this.applyHealthSnapshot(snapshot);
      this.recordOcrHealthResult(snapshot);
    } catch (error) {
      this.recordOcrHealthResult({});
      throw error;
    } finally {
      this.endHealthSnapshotLoad();
    }
  }

  async refresh(): Promise<void> {
    this.beginHealthSnapshotLoad();
    try {
      const health = await this.operations.run(
        'health',
        'Runtime health refreshed',
        async () =>
          this.snapshots.load((snapshot) =>
            this.applyHealthSnapshot(snapshot),
          ),
      );
      if (health !== null) {
        this.applyHealthSnapshot(health);
        this.recordOcrHealthResult(health);
      } else {
        this.recordOcrHealthResult({});
      }
    } finally {
      this.endHealthSnapshotLoad();
    }
  }

  openModelDownloadConsent(): void {
    if (this.canDownloadModel()) {
      this.modelDownloadConsentVisible.set(true);
    }
  }

  setModelDownloadConsentVisible(visible: boolean): void {
    if (visible) {
      this.openModelDownloadConsent();
      return;
    }

    this.cancelModelDownloadConsent();
  }

  cancelModelDownloadConsent(): void {
    if (!this.modelDownloadStarting()) {
      this.modelDownloadConsentVisible.set(false);
    }
  }

  async confirmModelDownload(): Promise<void> {
    if (!this.canDownloadModel() || this.modelDownloadStarting()) {
      return;
    }

    const client = this.runtimeApi.modelDownloadClient();
    if (client === null) {
      const message = 'Model download API is unavailable.';
      this.modelDownloadConsentVisible.set(false);
      this.modelDownload.set(this.failedDownload(message));
      this.operations.fail(message);
      return;
    }

    this.clearModelDownloadPollTimer();
    this.modelDownloadStarting.set(true);
    this.modelDownload.set(
      this.jobView.startingDownload(this.configuredModelName()),
    );

    try {
      const response = await client.startModelDownload();
      const status = this.toModelDownloadView(response, 'running');
      this.modelDownload.set(status);
      this.modelDownloadConsentVisible.set(false);
      this.continueModelDownload(status);
    } catch (error) {
      const message = this.jobView.errorMessage(error);
      this.modelDownload.set(this.failedDownload(message));
      this.operations.fail(message);
    } finally {
      this.modelDownloadStarting.set(false);
    }
  }

  openRuntimeInstallConsent(kind: RuntimeKind): void {
    if (this.canInstallRuntime(kind)) {
      this.runtimeInstallConsentKind.set(kind);
    }
  }

  openOcrRuntimeInstallConsent(): void {
    if (!this.isRuntimeInstallActive()) {
      this.runtimeInstallConsentKind.set(
        this.runtimeHealth.ocrRuntimeKind(
          this.ocrHealth(),
          this.runtimeRequirements(),
        ),
      );
    }
  }

  openOllamaInstallConsent(): void {
    this.openRuntimeInstallConsent('ollama');
  }

  setRuntimeInstallConsentVisible(visible: boolean): void {
    if (!visible) {
      this.cancelRuntimeInstallConsent();
    }
  }

  cancelRuntimeInstallConsent(): void {
    if (!this.runtimeInstallStarting()) {
      this.runtimeInstallConsentKind.set(null);
    }
  }

  async confirmRuntimeInstallation(): Promise<void> {
    const kind = this.runtimeInstallConsentKind();
    if (
      kind === null ||
      !this.canInstallRuntime(kind) ||
      this.runtimeInstallStarting()
    ) {
      return;
    }

    const client = this.runtimeApi.runtimeInstallationClient();
    if (client === null) {
      const message = 'Runtime installation API is unavailable.';
      this.runtimeInstallConsentKind.set(null);
      this.runtimeInstall.set(this.failedRuntimeInstall(kind, message));
      this.operations.fail(message);
      return;
    }

    this.clearRuntimeInstallPollTimer();
    this.runtimeInstallStarting.set(true);
    this.runtimeInstall.set(this.jobView.startingRuntimeInstall(kind));

    try {
      const response = await client.startRuntimeInstallation(kind);
      const status = this.toRuntimeInstallationView(response, kind, 'running');
      this.runtimeInstall.set(status);
      this.runtimeInstallConsentKind.set(null);
      this.continueRuntimeInstallation(status);
    } catch (error) {
      const message = this.jobView.errorMessage(error);
      this.runtimeInstall.set(this.failedRuntimeInstall(kind, message));
      this.operations.fail(message);
    } finally {
      this.runtimeInstallStarting.set(false);
    }
  }

  async refreshRuntimeInstallation(): Promise<void> {
    const current = this.runtimeInstall();
    if (current === null || current.jobId === null) {
      return;
    }

    const client = this.runtimeApi.runtimeInstallationClient();
    if (client === null) {
      const message = 'Runtime installation API is unavailable.';
      this.runtimeInstall.set({ ...current, phase: 'failed', error: message });
      this.operations.fail(message);
      return;
    }

    this.clearRuntimeInstallPollTimer();

    try {
      const response = await client.getRuntimeInstallation(current.jobId);
      const status = this.toRuntimeInstallationView(
        response,
        current.kind,
        current.phase,
      );
      this.runtimeInstall.set(status);
      this.continueRuntimeInstallation(status);
    } catch (error) {
      const message = this.jobView.errorMessage(error);
      this.runtimeInstall.set({
        ...current,
        phase: 'failed',
        status: 'failed',
        message,
        error: message,
      });
      this.operations.fail(message);
    }
  }

  async refreshModelDownload(): Promise<void> {
    const current = this.modelDownload();
    if (current === null || current.jobId === null) {
      return;
    }

    const client = this.runtimeApi.modelDownloadClient();
    if (client === null) {
      const message = 'Model download API is unavailable.';
      this.modelDownload.set({ ...current, phase: 'failed', error: message });
      this.operations.fail(message);
      return;
    }

    this.clearModelDownloadPollTimer();

    try {
      const response = await client.getModelDownload(current.jobId);
      const status = this.toModelDownloadView(response, current.phase);
      this.modelDownload.set(status);
      this.continueModelDownload(status);
    } catch (error) {
      const message = this.jobView.errorMessage(error);
      this.modelDownload.set({
        ...current,
        phase: 'failed',
        status: 'failed',
        message,
        error: message,
      });
      this.operations.fail(message);
    }
  }

  private continueModelDownload(status: ModelDownloadView): void {
    if (status.phase === 'succeeded') {
      void this.refreshHealthAfterRuntimeChange();
      return;
    }

    if (status.phase === 'failed') {
      this.operations.fail(status.error ?? status.message);
      return;
    }

    this.scheduleModelDownloadPoll();
  }

  private continueRuntimeInstallation(status: RuntimeInstallationView): void {
    if (status.phase === 'succeeded') {
      void this.refreshHealthAfterRuntimeChange();
      return;
    }

    if (status.phase === 'failed') {
      this.operations.fail(status.error ?? status.message);
      return;
    }

    if (status.phase === 'waiting_for_user') {
      return;
    }

    this.scheduleRuntimeInstallPoll();
  }

  private async refreshHealthAfterRuntimeChange(): Promise<void> {
    try {
      await this.load();
    } catch (error) {
      this.operations.fail(this.jobView.errorMessage(error));
    }
  }

  /**
   * Schedules the next model-download read after the current read has settled.
   * The timer is cleared before every manual or automatic refresh to avoid
   * overlapping backend polls.
   */
  private scheduleModelDownloadPoll(): void {
    this.clearModelDownloadPollTimer();
    this.modelDownloadPollTimer = setTimeout(() => {
      this.modelDownloadPollTimer = null;
      void this.refreshModelDownload();
    }, RUNTIME_JOB_POLL_INTERVAL_MS);
  }

  /**
   * Schedules runtime-installation polling only for running jobs. Jobs waiting
   * for external Windows confirmation are left for explicit user refresh.
   */
  private scheduleRuntimeInstallPoll(): void {
    this.clearRuntimeInstallPollTimer();
    this.runtimeInstallPollTimer = setTimeout(() => {
      this.runtimeInstallPollTimer = null;
      void this.refreshRuntimeInstallation();
    }, RUNTIME_JOB_POLL_INTERVAL_MS);
  }

  private clearModelDownloadPollTimer(): void {
    if (this.modelDownloadPollTimer !== null) {
      clearTimeout(this.modelDownloadPollTimer);
      this.modelDownloadPollTimer = null;
    }
  }

  private clearRuntimeInstallPollTimer(): void {
    if (this.runtimeInstallPollTimer !== null) {
      clearTimeout(this.runtimeInstallPollTimer);
      this.runtimeInstallPollTimer = null;
    }
  }

  private beginHealthSnapshotLoad(): void {
    this.healthSnapshotLoadCount += 1;
    this.healthSnapshotLoading.set(true);
    this.ocrHealthLoadFailed.set(false);
    this.ocrHealthRefreshPending.set(true);
  }

  private endHealthSnapshotLoad(): void {
    this.healthSnapshotLoadCount = Math.max(
      0,
      this.healthSnapshotLoadCount - 1,
    );
    if (this.healthSnapshotLoadCount === 0) {
      this.healthSnapshotLoading.set(false);
    }
  }

  private applyHealthSnapshot(snapshot: Partial<HealthSnapshot>): void {
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

  private recordOcrHealthResult(snapshot: Partial<HealthSnapshot>): void {
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

  private canInstallRuntime(kind: RuntimeKind): boolean {
    if (this.isRuntimeInstallActive()) {
      return false;
    }

    if (kind === 'ollama') {
      return this.isOllamaMissing();
    }

    if (this.isOcrRuntimeKind(kind)) {
      return (
        this.isOcrRuntimeMissing() ||
        this.runtimeInstallConsentKind() === kind
      );
    }

    return false;
  }

  private toModelDownloadView(
    response: unknown,
    fallbackPhase: DownloadPhase,
  ): ModelDownloadView {
    return this.jobView.toModelDownloadView(response, fallbackPhase, {
      currentJobId: this.modelDownload()?.jobId ?? null,
      modelName: this.configuredModelName(),
    });
  }

  private toRuntimeInstallationView(
    response: unknown,
    fallbackKind: RuntimeKind,
    fallbackPhase: DownloadPhase,
  ): RuntimeInstallationView {
    return this.jobView.toRuntimeInstallationView(
      response,
      fallbackKind,
      fallbackPhase,
      {
        currentJobId: this.runtimeInstall()?.jobId ?? null,
      },
    );
  }

  private failedDownload(message: string): ModelDownloadView {
    return this.jobView.failedDownload(
      message,
      this.modelDownload(),
      this.configuredModelName(),
    );
  }

  private failedRuntimeInstall(
    kind: RuntimeKind,
    message: string,
  ): RuntimeInstallationView {
    return this.jobView.failedRuntimeInstall(
      kind,
      message,
      this.runtimeInstall(),
    );
  }

  private isOcrRuntimeKind(kind: RuntimeKind | null | undefined): boolean {
    return (
      kind === 'paddle_ocr' ||
      kind === 'windowsml_ocr'
    );
  }
}
