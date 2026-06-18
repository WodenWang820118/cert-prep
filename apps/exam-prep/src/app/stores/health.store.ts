import { computed, inject, Injectable, signal } from '@angular/core';
import {
  EXAM_PREP_API,
  ExamPrepGeneratedClient,
  HealthResponse,
  LLMHealthRead,
  ModelDownloadRead,
  OCRHealthRead,
  RuntimeInstallationRead,
  RuntimeRequirementKind,
  RuntimeRequirementRead,
  RuntimeRequirementsRead,
} from '../exam-prep-api';
import { OperationStore } from './operation.store';

const MODEL_DOWNLOAD_POLL_INTERVAL_MS = 1500;
const MODEL_MISSING_REASON_CODES = new Set([
  'model_missing',
  'missing_model',
  'ollama_model_missing',
]);
const MODEL_DOWNLOAD_WAITING_STATUSES = new Set([
  'waiting',
  'waiting_for_user',
  'user_action_required',
]);
const MODEL_DOWNLOAD_DONE_STATUSES = new Set([
  'complete',
  'completed',
  'done',
  'success',
  'succeeded',
]);
const MODEL_DOWNLOAD_FAILED_STATUSES = new Set([
  'cancelled',
  'canceled',
  'error',
  'failed',
]);
const RUNTIME_KIND_LABELS: Record<string, string> = {
  ollama: 'Ollama',
  ollama_model: 'Ollama model',
  paddle_ocr: 'PaddleOCR runtime',
};

type DownloadPhase =
  | 'starting'
  | 'running'
  | 'waiting_for_user'
  | 'succeeded'
  | 'failed';
type RuntimeKind = 'ollama' | 'ollama_model' | 'paddle_ocr';

type LLMHealthWithMissingReason = LLMHealthRead &
  Partial<{
    code: string;
    error_code: string;
    reason: string;
    unavailable_reason: string;
  }>;

type ModelDownloadRecord = Record<string, unknown>;

interface ModelDownloadApiClient {
  startModelDownload(): Promise<ModelDownloadRead>;
  getModelDownload(jobId: string): Promise<ModelDownloadRead>;
}

interface RuntimeInstallationApiClient {
  runtimeRequirements(): Promise<RuntimeRequirementsRead>;
  startRuntimeInstallation(kind: string): Promise<RuntimeInstallationRead>;
  getRuntimeInstallation(jobId: string): Promise<RuntimeInstallationRead>;
}

export interface ModelDownloadView {
  readonly jobId: string | null;
  readonly model: string;
  readonly phase: DownloadPhase;
  readonly status: string;
  readonly progress: number | null;
  readonly message: string;
  readonly error: string | null;
}

export interface RuntimeInstallationView {
  readonly jobId: string | null;
  readonly kind: RuntimeKind;
  readonly label: string;
  readonly phase: DownloadPhase;
  readonly status: string;
  readonly progress: number | null;
  readonly message: string;
  readonly error: string | null;
}

@Injectable({ providedIn: 'root' })
export class HealthStore {
  private readonly api = inject(EXAM_PREP_API);
  private readonly operations = inject(OperationStore);
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
  readonly isModelMissing = computed(() => {
    const health = this.llmHealth();
    return (
      health !== null &&
      health.available === false &&
      this.hasModelMissingReason(health)
    );
  });
  readonly isModelDownloadActive = computed(() => {
    const phase = this.modelDownload()?.phase;
    return (
      this.modelDownloadStarting() ||
      phase === 'starting' ||
      phase === 'running'
    );
  });
  readonly isRuntimeInstallActive = computed(() => {
    const phase = this.runtimeInstall()?.phase;
    return (
      this.runtimeInstallStarting() ||
      phase === 'starting' ||
      phase === 'running' ||
      phase === 'waiting_for_user'
    );
  });
  readonly isOllamaMissing = computed(
    () =>
      this.unavailableReason(this.llmHealth()) === 'ollama_missing' ||
      this.runtimeUnavailableReason('ollama') === 'ollama_missing',
  );
  readonly isOcrRuntimeMissing = computed(
    () =>
      this.unavailableReason(this.ocrHealth()) === 'paddle_runtime_missing' ||
      this.runtimeUnavailableReason('paddle_ocr') === 'paddle_runtime_missing',
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
  readonly modelDownloadActionLabel = computed(() =>
    this.modelDownload()?.phase === 'failed'
      ? 'Retry download'
      : 'Download model',
  );
  readonly runtimeInstallActionLabel = computed(() =>
    this.runtimeInstall()?.phase === 'failed' ? 'Retry install' : 'Install',
  );
  readonly runtimeInstallConsentVisible = computed(
    () => this.runtimeInstallConsentKind() !== null,
  );
  readonly runtimeInstallConsentLabel = computed(() =>
    this.runtimeLabel(this.runtimeInstallConsentKind()),
  );
  readonly configuredModelName = computed(
    () => this.llmHealth()?.model ?? this.modelDownload()?.model ?? 'configured model',
  );

  async load(): Promise<void> {
    const [systemHealth, llmHealth, ocrHealth, runtimeRequirements] =
      await Promise.all([
        this.api.health(),
        this.api.llmHealth(),
        this.api.ocrHealth(),
        this.loadRuntimeRequirements(),
      ]);
    this.systemHealth.set(systemHealth);
    this.llmHealth.set(llmHealth);
    this.ocrHealth.set(ocrHealth);
    this.runtimeRequirements.set(runtimeRequirements);
  }

  async refresh(): Promise<void> {
    const health = await this.operations.run(
      'health',
      'Runtime health refreshed',
      async () => ({
        system: await this.api.health(),
        llm: await this.api.llmHealth(),
        ocr: await this.api.ocrHealth(),
        runtimeRequirements: await this.loadRuntimeRequirements(),
      }),
    );
    if (health !== null) {
      this.systemHealth.set(health.system);
      this.llmHealth.set(health.llm);
      this.ocrHealth.set(health.ocr);
      this.runtimeRequirements.set(health.runtimeRequirements);
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

    const client = this.modelDownloadClient();
    if (client === null) {
      const message = 'Model download API is unavailable.';
      this.modelDownloadConsentVisible.set(false);
      this.modelDownload.set(this.failedDownload(message));
      this.operations.fail(message);
      return;
    }

    this.clearModelDownloadPollTimer();
    this.modelDownloadStarting.set(true);
    this.modelDownload.set(this.startingDownload());

    try {
      const response = await client.startModelDownload();
      const status = this.toModelDownloadView(response, 'running');
      this.modelDownload.set(status);
      this.modelDownloadConsentVisible.set(false);
      this.continueModelDownload(status);
    } catch (error) {
      const message = this.errorMessage(error);
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

    const client = this.runtimeInstallationClient();
    if (client === null) {
      const message = 'Runtime installation API is unavailable.';
      this.runtimeInstallConsentKind.set(null);
      this.runtimeInstall.set(this.failedRuntimeInstall(kind, message));
      this.operations.fail(message);
      return;
    }

    this.clearRuntimeInstallPollTimer();
    this.runtimeInstallStarting.set(true);
    this.runtimeInstall.set(this.startingRuntimeInstall(kind));

    try {
      const response = await client.startRuntimeInstallation(kind);
      const status = this.toRuntimeInstallationView(response, kind, 'running');
      this.runtimeInstall.set(status);
      this.runtimeInstallConsentKind.set(null);
      this.continueRuntimeInstallation(status);
    } catch (error) {
      const message = this.errorMessage(error);
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

    const client = this.runtimeInstallationClient();
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
      const message = this.errorMessage(error);
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

    const client = this.modelDownloadClient();
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
      const message = this.errorMessage(error);
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
      void this.load();
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
      void this.load();
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

  private scheduleModelDownloadPoll(): void {
    this.clearModelDownloadPollTimer();
    this.modelDownloadPollTimer = setTimeout(() => {
      this.modelDownloadPollTimer = null;
      void this.refreshModelDownload();
    }, MODEL_DOWNLOAD_POLL_INTERVAL_MS);
  }

  private scheduleRuntimeInstallPoll(): void {
    this.clearRuntimeInstallPollTimer();
    this.runtimeInstallPollTimer = setTimeout(() => {
      this.runtimeInstallPollTimer = null;
      void this.refreshRuntimeInstallation();
    }, MODEL_DOWNLOAD_POLL_INTERVAL_MS);
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

  private modelDownloadClient(): ModelDownloadApiClient | null {
    const client = this.api as ExamPrepGeneratedClient &
      Partial<ModelDownloadApiClient>;
    if (
      typeof client.startModelDownload !== 'function' ||
      typeof client.getModelDownload !== 'function'
    ) {
      return null;
    }

    return {
      startModelDownload: () => client.startModelDownload(),
      getModelDownload: (jobId) => client.getModelDownload(jobId),
    };
  }

  private runtimeInstallationClient(): RuntimeInstallationApiClient | null {
    const client = this.api as ExamPrepGeneratedClient &
      Partial<RuntimeInstallationApiClient>;
    if (
      typeof client.runtimeRequirements !== 'function' ||
      typeof client.startRuntimeInstallation !== 'function' ||
      typeof client.getRuntimeInstallation !== 'function'
    ) {
      return null;
    }

    return {
      runtimeRequirements: () => client.runtimeRequirements(),
      startRuntimeInstallation: (kind) => client.startRuntimeInstallation(kind),
      getRuntimeInstallation: (jobId) => client.getRuntimeInstallation(jobId),
    };
  }

  private async loadRuntimeRequirements(): Promise<RuntimeRequirementRead[]> {
    const client = this.runtimeInstallationClient();
    if (client === null) {
      return [];
    }

    return (await client.runtimeRequirements()).items;
  }

  private hasModelMissingReason(health: LLMHealthRead): boolean {
    const extended = health as LLMHealthWithMissingReason;
    const reason = [
      extended.code,
      extended.error_code,
      extended.reason,
      extended.unavailable_reason,
    ]
      .map((value) => this.normalizedCode(value))
      .find((value) => value.length > 0);

    if (reason !== undefined && MODEL_MISSING_REASON_CODES.has(reason)) {
      return true;
    }

    return /\bmodel\b.*\b(missing|not found)\b/i.test(health.detail);
  }

  private toModelDownloadView(
    response: unknown,
    fallbackPhase: DownloadPhase,
  ): ModelDownloadView {
    const record = this.asRecord(response);
    const status =
      this.readString(record, 'status') ??
      this.readString(record, 'state') ??
      this.readString(record, 'phase') ??
      fallbackPhase;
    const normalizedStatus = this.normalizedCode(status);
    const error = this.readString(record, 'error');
    const phase = this.phaseFrom(
      record,
      normalizedStatus,
      fallbackPhase,
      error,
    );
    const progress = this.progressFrom(record, phase);
    const message =
      error ??
      this.readString(record, 'message') ??
      this.readString(record, 'detail') ??
      this.defaultDownloadMessage(phase);

    return {
      jobId:
        this.readString(record, 'job_id') ??
        this.readString(record, 'jobId') ??
        this.readString(record, 'id') ??
        this.modelDownload()?.jobId ??
        null,
      model:
        this.readString(record, 'model') ?? this.llmHealth()?.model ?? 'model',
      phase,
      status,
      progress,
      message,
      error,
    };
  }

  private toRuntimeInstallationView(
    response: unknown,
    fallbackKind: RuntimeKind,
    fallbackPhase: DownloadPhase,
  ): RuntimeInstallationView {
    const record = this.asRecord(response);
    const kind = this.runtimeKindFrom(record, fallbackKind);
    const status =
      this.readString(record, 'status') ??
      this.readString(record, 'state') ??
      this.readString(record, 'phase') ??
      fallbackPhase;
    const normalizedStatus = this.normalizedCode(status);
    const error = this.readString(record, 'error');
    const phase = this.phaseFrom(
      record,
      normalizedStatus,
      fallbackPhase,
      error,
    );
    const progress = this.progressFrom(record, phase);
    const message =
      error ??
      this.readString(record, 'message') ??
      this.readString(record, 'detail') ??
      this.defaultRuntimeInstallMessage(kind, phase);

    return {
      jobId:
        this.readString(record, 'job_id') ??
        this.readString(record, 'jobId') ??
        this.readString(record, 'id') ??
        this.runtimeInstall()?.jobId ??
        null,
      kind,
      label: this.runtimeLabel(kind),
      phase,
      status,
      progress,
      message,
      error,
    };
  }

  private phaseFrom(
    record: ModelDownloadRecord,
    status: string,
    fallbackPhase: DownloadPhase,
    error: string | null,
  ): DownloadPhase {
    if (error !== null || MODEL_DOWNLOAD_FAILED_STATUSES.has(status)) {
      return 'failed';
    }

    if (MODEL_DOWNLOAD_WAITING_STATUSES.has(status)) {
      return 'waiting_for_user';
    }

    if (
      this.readBoolean(record, 'done') ||
      MODEL_DOWNLOAD_DONE_STATUSES.has(status)
    ) {
      return 'succeeded';
    }

    return fallbackPhase === 'starting' ? 'starting' : 'running';
  }

  private progressFrom(
    record: ModelDownloadRecord,
    phase: DownloadPhase,
  ): number | null {
    const direct =
      this.readNumber(record, 'progress') ??
      this.readNumber(record, 'percent') ??
      this.readNumber(record, 'percentage');
    if (direct !== null) {
      return this.percent(direct);
    }

    const completed =
      this.readNumber(record, 'completed') ??
      this.readNumber(record, 'downloaded_bytes');
    const total =
      this.readNumber(record, 'total') ??
      this.readNumber(record, 'total_bytes');
    if (completed !== null && total !== null && total > 0) {
      return this.percent((completed / total) * 100);
    }

    return phase === 'succeeded' ? 100 : null;
  }

  private percent(value: number): number {
    const percent = value > 0 && value <= 1 ? value * 100 : value;
    return Math.max(0, Math.min(100, Math.round(percent)));
  }

  private startingDownload(): ModelDownloadView {
    return {
      jobId: null,
      model: this.llmHealth()?.model ?? 'model',
      phase: 'starting',
      status: 'starting',
      progress: null,
      message: 'Starting model download...',
      error: null,
    };
  }

  private startingRuntimeInstall(kind: RuntimeKind): RuntimeInstallationView {
    return {
      jobId: null,
      kind,
      label: this.runtimeLabel(kind),
      phase: 'starting',
      status: 'starting',
      progress: null,
      message: `Starting ${this.runtimeLabel(kind)} installation...`,
      error: null,
    };
  }

  private failedDownload(message: string): ModelDownloadView {
    return {
      jobId: this.modelDownload()?.jobId ?? null,
      model: this.llmHealth()?.model ?? 'model',
      phase: 'failed',
      status: 'failed',
      progress: this.modelDownload()?.progress ?? null,
      message,
      error: message,
    };
  }

  private failedRuntimeInstall(
    kind: RuntimeKind,
    message: string,
  ): RuntimeInstallationView {
    return {
      jobId: this.runtimeInstall()?.jobId ?? null,
      kind,
      label: this.runtimeLabel(kind),
      phase: 'failed',
      status: 'failed',
      progress: this.runtimeInstall()?.progress ?? null,
      message,
      error: message,
    };
  }

  private defaultDownloadMessage(phase: DownloadPhase): string {
    if (phase === 'succeeded') {
      return 'Model download completed.';
    }

    if (phase === 'failed') {
      return 'Model download failed.';
    }

    return 'Model download is running.';
  }

  private defaultRuntimeInstallMessage(
    kind: RuntimeKind,
    phase: DownloadPhase,
  ): string {
    if (phase === 'succeeded') {
      return `${this.runtimeLabel(kind)} installation completed.`;
    }

    if (phase === 'failed') {
      return `${this.runtimeLabel(kind)} installation failed.`;
    }

    if (phase === 'waiting_for_user') {
      return `${this.runtimeLabel(kind)} needs confirmation in Windows.`;
    }

    return `${this.runtimeLabel(kind)} installation is running.`;
  }

  private asRecord(value: unknown): ModelDownloadRecord {
    if (typeof value === 'object' && value !== null) {
      return value as ModelDownloadRecord;
    }

    return {};
  }

  private readString(
    record: ModelDownloadRecord,
    key: keyof ModelDownloadRecord,
  ): string | null {
    const value = record[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  private readNumber(
    record: ModelDownloadRecord,
    key: keyof ModelDownloadRecord,
  ): number | null {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private readBoolean(
    record: ModelDownloadRecord,
    key: keyof ModelDownloadRecord,
  ): boolean {
    return record[key] === true;
  }

  private normalizedCode(value: unknown): string {
    return typeof value === 'string'
      ? value
          .trim()
          .toLowerCase()
          .replace(/[\s-]+/g, '_')
      : '';
  }

  private unavailableReason(
    health: LLMHealthRead | OCRHealthRead | null,
  ): string {
    return this.normalizedCode(health?.unavailable_reason);
  }

  private runtimeUnavailableReason(kind: RuntimeKind): string {
    const requirement = this.runtimeRequirements().find(
      (item) => item.kind === kind,
    );
    return this.normalizedCode(requirement?.unavailable_reason);
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

  private runtimeKindFrom(
    record: ModelDownloadRecord,
    fallbackKind: RuntimeKind,
  ): RuntimeKind {
    const kind = this.normalizedCode(
      this.readString(record, 'kind') ?? fallbackKind,
    );
    return kind === 'ollama' || kind === 'ollama_model' || kind === 'paddle_ocr'
      ? kind
      : fallbackKind;
  }

  private runtimeLabel(
    kind: RuntimeRequirementKind | RuntimeKind | null,
  ): string {
    if (kind === null) {
      return 'Runtime';
    }

    return RUNTIME_KIND_LABELS[kind] ?? 'Runtime';
  }

  private errorMessage(error: unknown): string {
    const httpError = error as { error?: unknown; message?: unknown };
    if (this.hasMessage(httpError.error)) {
      return httpError.error.message;
    }

    if (typeof httpError.error === 'string' && httpError.error.length > 0) {
      return httpError.error;
    }

    if (typeof httpError.message === 'string' && httpError.message.length > 0) {
      return httpError.message;
    }

    return 'The model download did not complete.';
  }

  private hasMessage(value: unknown): value is { message: string } {
    return (
      typeof value === 'object' &&
      value !== null &&
      'message' in value &&
      typeof (value as { message?: unknown }).message === 'string'
    );
  }
}
