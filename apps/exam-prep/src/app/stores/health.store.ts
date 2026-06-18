import { computed, inject, Injectable, signal } from '@angular/core';
import {
  EXAM_PREP_API,
  HealthResponse,
  LLMHealthRead,
  OCRHealthRead,
  RuntimeRequirementRead,
} from '../exam-prep-api';
import {
  DownloadPhase,
  HealthSnapshot,
  ModelDownloadView,
  RuntimeInstallationView,
  RuntimeKind,
} from './health-runtime.models';
import { HealthSnapshotService } from './health-snapshot.service';
import { OperationStore } from './operation.store';
import {
  configuredModelName,
  isModelMissing,
  isOcrRuntimeMissing,
  isOllamaMissing,
} from './runtime-health-derivation';
import {
  errorMessage,
  failedDownload,
  failedRuntimeInstall,
  startingDownload,
  startingRuntimeInstall,
  toModelDownloadView,
  toRuntimeInstallationView,
} from './runtime-job-view';
import {
  modelDownloadClient,
  runtimeInstallationClient,
} from './runtime-api-clients';

const RUNTIME_JOB_POLL_INTERVAL_MS = 1500;

@Injectable({ providedIn: 'root' })
export class HealthStore {
  private readonly api = inject(EXAM_PREP_API);
  private readonly operations = inject(OperationStore);
  private readonly snapshots = inject(HealthSnapshotService);
  private modelDownloadPollTimer: ReturnType<typeof setTimeout> | null = null;
  private runtimeInstallPollTimer: ReturnType<typeof setTimeout> | null = null;

  readonly llmHealth = signal<LLMHealthRead | null>(null);
  readonly systemHealth = signal<HealthResponse | null>(null);
  readonly ocrHealth = signal<OCRHealthRead | null>(null);
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
  readonly isModelMissing = computed(() => isModelMissing(this.llmHealth()));

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
    isOllamaMissing(this.llmHealth(), this.runtimeRequirements()),
  );
  readonly isOcrRuntimeMissing = computed(() =>
    isOcrRuntimeMissing(this.ocrHealth(), this.runtimeRequirements()),
  );
  readonly canDownloadModel = computed(
    () => this.isModelMissing() && !this.isModelDownloadActive(),
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
    configuredModelName(this.llmHealth(), this.modelDownload()?.model),
  );

  async load(): Promise<void> {
    this.applyHealthSnapshot(await this.snapshots.load());
  }

  async refresh(): Promise<void> {
    const health = await this.operations.run(
      'health',
      'Runtime health refreshed',
      async () => this.snapshots.load(),
    );
    if (health !== null) {
      this.applyHealthSnapshot(health);
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
    if (!this.isModelMissing() || this.modelDownloadStarting()) {
      return;
    }

    const client = modelDownloadClient(this.api);
    if (client === null) {
      const message = 'Model download API is unavailable.';
      this.modelDownloadConsentVisible.set(false);
      this.modelDownload.set(this.failedDownload(message));
      this.operations.fail(message);
      return;
    }

    this.clearModelDownloadPollTimer();
    this.modelDownloadStarting.set(true);
    this.modelDownload.set(startingDownload(this.llmHealth()?.model ?? null));

    try {
      const response = await client.startModelDownload();
      const status = this.toModelDownloadView(response, 'running');
      this.modelDownload.set(status);
      this.modelDownloadConsentVisible.set(false);
      this.continueModelDownload(status);
    } catch (error) {
      const message = errorMessage(error);
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
      this.runtimeInstallConsentKind.set('paddle_ocr');
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

    const client = runtimeInstallationClient(this.api);
    if (client === null) {
      const message = 'Runtime installation API is unavailable.';
      this.runtimeInstallConsentKind.set(null);
      this.runtimeInstall.set(this.failedRuntimeInstall(kind, message));
      this.operations.fail(message);
      return;
    }

    this.clearRuntimeInstallPollTimer();
    this.runtimeInstallStarting.set(true);
    this.runtimeInstall.set(startingRuntimeInstall(kind));

    try {
      const response = await client.startRuntimeInstallation(kind);
      const status = this.toRuntimeInstallationView(response, kind, 'running');
      this.runtimeInstall.set(status);
      this.runtimeInstallConsentKind.set(null);
      this.continueRuntimeInstallation(status);
    } catch (error) {
      const message = errorMessage(error);
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

    const client = runtimeInstallationClient(this.api);
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
      const message = errorMessage(error);
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

    const client = modelDownloadClient(this.api);
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
      const message = errorMessage(error);
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
      this.operations.fail(errorMessage(error));
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

  private applyHealthSnapshot(snapshot: HealthSnapshot): void {
    if (snapshot.system !== undefined) {
      this.systemHealth.set(snapshot.system);
    }
    if (snapshot.llm !== undefined) {
      this.llmHealth.set(snapshot.llm);
    }
    if (snapshot.ocr !== undefined) {
      this.ocrHealth.set(snapshot.ocr);
    }
    this.runtimeRequirements.set(snapshot.runtimeRequirements);
  }

  private canInstallRuntime(kind: RuntimeKind): boolean {
    if (this.isRuntimeInstallActive()) {
      return false;
    }

    if (kind === 'ollama') {
      return this.isOllamaMissing();
    }

    if (kind === 'paddle_ocr') {
      return (
        this.isOcrRuntimeMissing() ||
        this.runtimeInstallConsentKind() === 'paddle_ocr'
      );
    }

    return false;
  }

  private toModelDownloadView(
    response: unknown,
    fallbackPhase: DownloadPhase,
  ): ModelDownloadView {
    return toModelDownloadView(response, fallbackPhase, {
      currentJobId: this.modelDownload()?.jobId ?? null,
      modelName: this.llmHealth()?.model,
    });
  }

  private toRuntimeInstallationView(
    response: unknown,
    fallbackKind: RuntimeKind,
    fallbackPhase: DownloadPhase,
  ): RuntimeInstallationView {
    return toRuntimeInstallationView(response, fallbackKind, fallbackPhase, {
      currentJobId: this.runtimeInstall()?.jobId ?? null,
    });
  }

  private failedDownload(message: string): ModelDownloadView {
    return failedDownload(message, this.modelDownload(), this.llmHealth()?.model);
  }

  private failedRuntimeInstall(
    kind: RuntimeKind,
    message: string,
  ): RuntimeInstallationView {
    return failedRuntimeInstall(kind, message, this.runtimeInstall());
  }
}
