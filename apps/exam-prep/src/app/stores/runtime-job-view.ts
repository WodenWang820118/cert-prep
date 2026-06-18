import type { RuntimeRequirementKind } from '../exam-prep-api';
import type {
  DownloadPhase,
  ModelDownloadView,
  RuntimeInstallationView,
  RuntimeKind,
} from './health-runtime.models';
import { normalizedCode } from './runtime-health-derivation';

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

type RuntimeJobRecord = Record<string, unknown>;

interface ModelDownloadViewContext {
  readonly currentJobId: string | null;
  readonly modelName: string | null | undefined;
}

interface RuntimeInstallationViewContext {
  readonly currentJobId: string | null;
}

export function toModelDownloadView(
  response: unknown,
  fallbackPhase: DownloadPhase,
  context: ModelDownloadViewContext,
): ModelDownloadView {
  const record = asRecord(response);
  const status =
    readString(record, 'status') ??
    readString(record, 'state') ??
    readString(record, 'phase') ??
    fallbackPhase;
  const error = readString(record, 'error');
  const phase = phaseFrom(record, normalizedCode(status), fallbackPhase, error);
  const progress = progressFrom(record, phase);
  const message =
    error ??
    readString(record, 'message') ??
    readString(record, 'detail') ??
    defaultDownloadMessage(phase);

  return {
    jobId:
      readString(record, 'job_id') ??
      readString(record, 'jobId') ??
      readString(record, 'id') ??
      context.currentJobId,
    model: readString(record, 'model') ?? context.modelName ?? 'model',
    phase,
    status,
    progress,
    message,
    error,
  };
}

export function toRuntimeInstallationView(
  response: unknown,
  fallbackKind: RuntimeKind,
  fallbackPhase: DownloadPhase,
  context: RuntimeInstallationViewContext,
): RuntimeInstallationView {
  const record = asRecord(response);
  const kind = runtimeKindFrom(record, fallbackKind);
  const status =
    readString(record, 'status') ??
    readString(record, 'state') ??
    readString(record, 'phase') ??
    fallbackPhase;
  const error = readString(record, 'error');
  const phase = phaseFrom(record, normalizedCode(status), fallbackPhase, error);
  const progress = progressFrom(record, phase);
  const message =
    error ??
    readString(record, 'message') ??
    readString(record, 'detail') ??
    defaultRuntimeInstallMessage(kind, phase);

  return {
    jobId:
      readString(record, 'job_id') ??
      readString(record, 'jobId') ??
      readString(record, 'id') ??
      context.currentJobId,
    kind,
    label: runtimeLabel(kind),
    phase,
    status,
    progress,
    message,
    error,
  };
}

export function startingDownload(modelName: string | null): ModelDownloadView {
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

export function startingRuntimeInstall(
  kind: RuntimeKind,
): RuntimeInstallationView {
  return {
    jobId: null,
    kind,
    label: runtimeLabel(kind),
    phase: 'starting',
    status: 'starting',
    progress: null,
    message: `Starting ${runtimeLabel(kind)} installation...`,
    error: null,
  };
}

export function failedDownload(
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

export function failedRuntimeInstall(
  kind: RuntimeKind,
  message: string,
  current: RuntimeInstallationView | null,
): RuntimeInstallationView {
  return {
    jobId: current?.jobId ?? null,
    kind,
    label: runtimeLabel(kind),
    phase: 'failed',
    status: 'failed',
    progress: current?.progress ?? null,
    message,
    error: message,
  };
}

export function runtimeLabel(
  kind: RuntimeRequirementKind | RuntimeKind | null,
): string {
  if (kind === null) {
    return 'Runtime';
  }

  return RUNTIME_KIND_LABELS[kind] ?? 'Runtime';
}

export function errorMessage(error: unknown): string {
  const httpError = error as { error?: unknown; message?: unknown };
  if (hasMessage(httpError.error)) {
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

function hasMessage(value: unknown): value is { message: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'message' in value &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

function phaseFrom(
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

  if (readBoolean(record, 'done') || MODEL_DOWNLOAD_DONE_STATUSES.has(status)) {
    return 'succeeded';
  }

  return fallbackPhase === 'starting' ? 'starting' : 'running';
}

function progressFrom(
  record: RuntimeJobRecord,
  phase: DownloadPhase,
): number | null {
  const direct =
    readNumber(record, 'progress') ??
    readNumber(record, 'percent') ??
    readNumber(record, 'percentage');
  if (direct !== null) {
    return percent(direct);
  }

  const completed =
    readNumber(record, 'completed') ?? readNumber(record, 'downloaded_bytes');
  const total = readNumber(record, 'total') ?? readNumber(record, 'total_bytes');
  if (completed !== null && total !== null && total > 0) {
    return percent((completed / total) * 100);
  }

  return phase === 'succeeded' ? 100 : null;
}

function percent(value: number): number {
  const percentValue = value > 0 && value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(percentValue)));
}

function defaultDownloadMessage(phase: DownloadPhase): string {
  if (phase === 'succeeded') {
    return 'Model download completed.';
  }

  if (phase === 'failed') {
    return 'Model download failed.';
  }

  return 'Model download is running.';
}

function defaultRuntimeInstallMessage(
  kind: RuntimeKind,
  phase: DownloadPhase,
): string {
  if (phase === 'succeeded') {
    return `${runtimeLabel(kind)} installation completed.`;
  }

  if (phase === 'failed') {
    return `${runtimeLabel(kind)} installation failed.`;
  }

  if (phase === 'waiting_for_user') {
    return `${runtimeLabel(kind)} needs confirmation in Windows.`;
  }

  return `${runtimeLabel(kind)} installation is running.`;
}

function asRecord(value: unknown): RuntimeJobRecord {
  if (typeof value === 'object' && value !== null) {
    return value as RuntimeJobRecord;
  }

  return {};
}

function readString(
  record: RuntimeJobRecord,
  key: keyof RuntimeJobRecord,
): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(
  record: RuntimeJobRecord,
  key: keyof RuntimeJobRecord,
): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readBoolean(record: RuntimeJobRecord, key: keyof RuntimeJobRecord) {
  return record[key] === true;
}

function runtimeKindFrom(
  record: RuntimeJobRecord,
  fallbackKind: RuntimeKind,
): RuntimeKind {
  const kind = normalizedCode(readString(record, 'kind') ?? fallbackKind);
  return kind === 'ollama' || kind === 'ollama_model' || kind === 'paddle_ocr'
    ? kind
    : fallbackKind;
}
