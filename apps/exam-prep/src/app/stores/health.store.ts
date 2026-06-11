import { computed, inject, Injectable, signal } from '@angular/core';
import {
  EXAM_PREP_API,
  ExamPrepGeneratedClient,
  LLMHealthRead,
  ModelDownloadRead,
  OCRHealthRead,
} from '../exam-prep-api';
import { OperationStore } from './operation.store';

const MODEL_DOWNLOAD_POLL_INTERVAL_MS = 1500;
const MODEL_MISSING_REASON_CODES = new Set([
  'model_missing',
  'missing_model',
  'ollama_model_missing',
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

type DownloadPhase = 'starting' | 'running' | 'succeeded' | 'failed';

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

export interface ModelDownloadView {
  readonly jobId: string | null;
  readonly model: string;
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

  readonly llmHealth = signal<LLMHealthRead | null>(null);
  readonly ocrHealth = signal<OCRHealthRead | null>(null);
  readonly modelDownloadConsentVisible = signal(false);
  readonly modelDownloadStarting = signal(false);
  readonly modelDownload = signal<ModelDownloadView | null>(null);
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
  readonly canDownloadModel = computed(
    () => this.isModelMissing() && !this.isModelDownloadActive(),
  );
  readonly modelDownloadActionLabel = computed(() =>
    this.modelDownload()?.phase === 'failed' ? 'Retry download' : 'Download model',
  );

  async load(): Promise<void> {
    const [llmHealth, ocrHealth] = await Promise.all([
      this.api.llmHealth(),
      this.api.ocrHealth(),
    ]);
    this.llmHealth.set(llmHealth);
    this.ocrHealth.set(ocrHealth);
  }

  async refresh(): Promise<void> {
    const health = await this.operations.run(
      'health',
      'Runtime health refreshed',
      async () => ({
        llm: await this.api.llmHealth(),
        ocr: await this.api.ocrHealth(),
      }),
    );
    if (health !== null) {
      this.llmHealth.set(health.llm);
      this.ocrHealth.set(health.ocr);
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

  private scheduleModelDownloadPoll(): void {
    this.clearModelDownloadPollTimer();
    this.modelDownloadPollTimer = setTimeout(() => {
      this.modelDownloadPollTimer = null;
      void this.refreshModelDownload();
    }, MODEL_DOWNLOAD_POLL_INTERVAL_MS);
  }

  private clearModelDownloadPollTimer(): void {
    if (this.modelDownloadPollTimer !== null) {
      clearTimeout(this.modelDownloadPollTimer);
      this.modelDownloadPollTimer = null;
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
    const phase = this.phaseFrom(record, normalizedStatus, fallbackPhase, error);
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
      model: this.readString(record, 'model') ?? this.llmHealth()?.model ?? 'model',
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

    if (this.readBoolean(record, 'done') || MODEL_DOWNLOAD_DONE_STATUSES.has(status)) {
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
      this.readNumber(record, 'total') ?? this.readNumber(record, 'total_bytes');
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

  private defaultDownloadMessage(phase: DownloadPhase): string {
    if (phase === 'succeeded') {
      return 'Model download completed.';
    }

    if (phase === 'failed') {
      return 'Model download failed.';
    }

    return 'Model download is running.';
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
      ? value.trim().toLowerCase().replace(/[\s-]+/g, '_')
      : '';
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
