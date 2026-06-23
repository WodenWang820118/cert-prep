import { inject, Injectable } from '@angular/core';
import type { RuntimeRequirementKind } from '../../cert-prep-api';
import type {
  DownloadPhase,
  ModelDownloadView,
  ModelDownloadViewContext,
  RuntimeInstallationView,
  RuntimeInstallationViewContext,
  RuntimeJobRecord,
  RuntimeKind,
} from './contracts/health-runtime.contracts';
import { RuntimeHealthDerivationService } from './runtime-health-derivation.service';

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
  windowsml_ocr: 'WindowsML OCR runtime',
};

@Injectable({ providedIn: 'root' })
export class RuntimeJobViewService {
  private readonly derivation = inject(RuntimeHealthDerivationService);

  toModelDownloadView(
    response: unknown,
    fallbackPhase: DownloadPhase,
    context: ModelDownloadViewContext,
  ): ModelDownloadView {
    const record = this.asRecord(response);
    const status =
      this.readString(record, 'status') ??
      this.readString(record, 'state') ??
      this.readString(record, 'phase') ??
      fallbackPhase;
    const error = this.readString(record, 'error');
    const phase = this.phaseFrom(
      record,
      this.derivation.normalizedCode(status),
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
        context.currentJobId,
      model: this.readString(record, 'model') ?? context.modelName ?? 'model',
      phase,
      status,
      progress,
      message,
      error,
    };
  }

  toRuntimeInstallationView(
    response: unknown,
    fallbackKind: RuntimeKind,
    fallbackPhase: DownloadPhase,
    context: RuntimeInstallationViewContext,
  ): RuntimeInstallationView {
    const record = this.asRecord(response);
    const kind = this.runtimeKindFrom(record, fallbackKind);
    const status =
      this.readString(record, 'status') ??
      this.readString(record, 'state') ??
      this.readString(record, 'phase') ??
      fallbackPhase;
    const error = this.readString(record, 'error');
    const phase = this.phaseFrom(
      record,
      this.derivation.normalizedCode(status),
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
        context.currentJobId,
      kind,
      label: this.runtimeLabel(kind),
      phase,
      status,
      progress,
      message,
      error,
    };
  }

  startingDownload(modelName: string | null): ModelDownloadView {
    return {
      jobId: null,
      model: modelName ?? 'model',
      phase: 'starting',
      status: 'starting',
      progress: null,
      message: 'Starting model download...',
      error: null,
    };
  }

  startingRuntimeInstall(kind: RuntimeKind): RuntimeInstallationView {
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

  failedDownload(
    message: string,
    current: ModelDownloadView | null,
    modelName: string | null | undefined,
  ): ModelDownloadView {
    return {
      jobId: current?.jobId ?? null,
      model: modelName ?? 'model',
      phase: 'failed',
      status: 'failed',
      progress: current?.progress ?? null,
      message,
      error: message,
    };
  }

  failedRuntimeInstall(
    kind: RuntimeKind,
    message: string,
    current: RuntimeInstallationView | null,
  ): RuntimeInstallationView {
    return {
      jobId: current?.jobId ?? null,
      kind,
      label: this.runtimeLabel(kind),
      phase: 'failed',
      status: 'failed',
      progress: current?.progress ?? null,
      message,
      error: message,
    };
  }

  runtimeLabel(kind: RuntimeRequirementKind | RuntimeKind | null): string {
    if (kind === null) {
      return 'Runtime';
    }

    return RUNTIME_KIND_LABELS[kind] ?? 'Runtime';
  }

  errorMessage(error: unknown): string {
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

  private phaseFrom(
    record: RuntimeJobRecord,
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
    record: RuntimeJobRecord,
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
    const percentValue = value > 0 && value <= 1 ? value * 100 : value;
    return Math.max(0, Math.min(100, Math.round(percentValue)));
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

  private asRecord(value: unknown): RuntimeJobRecord {
    if (typeof value === 'object' && value !== null) {
      return value as RuntimeJobRecord;
    }

    return {};
  }

  private readString(
    record: RuntimeJobRecord,
    key: keyof RuntimeJobRecord,
  ): string | null {
    const value = record[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  private readNumber(
    record: RuntimeJobRecord,
    key: keyof RuntimeJobRecord,
  ): number | null {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private readBoolean(
    record: RuntimeJobRecord,
    key: keyof RuntimeJobRecord,
  ): boolean {
    return record[key] === true;
  }

  private runtimeKindFrom(
    record: RuntimeJobRecord,
    fallbackKind: RuntimeKind,
  ): RuntimeKind {
    const kind = this.derivation.normalizedCode(
      this.readString(record, 'kind') ?? fallbackKind,
    );
    return kind === 'ollama' ||
      kind === 'ollama_model' ||
      kind === 'paddle_ocr' ||
      kind === 'windowsml_ocr'
      ? kind
      : fallbackKind;
  }
}
