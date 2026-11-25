import { inject, Injectable } from '@angular/core';
import type { LLMRequirementKind } from '../../core/domain';
import type {
  DownloadPhase,
  ModelDownloadView,
  ModelDownloadViewContext,
  LLMInstallationView,
  LLMInstallationViewContext,
  LLMJobRecord,
} from '../domain';
import { RuntimeHealthDerivationService } from './runtime-health-derivation.service';
import { LLM_REQUIREMENT_LABELS } from '../domain';
import { requestErrorMessage } from '../../core/domain';

@Injectable({ providedIn: 'root' })
export class LLMJobViewService {
  private readonly derivation = inject(RuntimeHealthDerivationService);

  toModelDownloadView(
    response: unknown,
    fallbackPhase: DownloadPhase,
    context: ModelDownloadViewContext,
  ): ModelDownloadView {
    const record = this.asRecord(response);
    const { status, error, phase, progress } = this.readJobProgress(
      record,
      fallbackPhase,
    );
    const message =
      error ??
      this.readString(record, 'detail') ??
      this.defaultDownloadMessage(phase);

    return {
      jobId: this.readString(record, 'id') ?? context.currentJobId,
      model: this.readString(record, 'model') ?? context.modelName ?? 'model',
      phase,
      status,
      progress,
      message,
      error,
      cancellable: this.readBoolean(record, 'cancellable'),
    };
  }

  toLLMInstallationView(
    response: unknown,
    fallbackKind: LLMRequirementKind,
    fallbackPhase: DownloadPhase,
    context: LLMInstallationViewContext,
  ): LLMInstallationView {
    const record = this.asRecord(response);
    const kind = this.runtimeKindFrom(record, fallbackKind);
    const { status, error, phase, progress } = this.readJobProgress(
      record,
      fallbackPhase,
    );
    const message =
      error ??
      this.readString(record, 'detail') ??
      this.defaultLLMEngineInstallMessage(kind, phase);

    return {
      jobId: this.readString(record, 'id') ?? context.currentJobId,
      kind,
      label: this.requirementLabel(kind),
      phase,
      status,
      progress,
      message,
      error,
      cancellable: this.readBoolean(record, 'cancellable'),
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
      cancellable: false,
    };
  }

  startingLLMEngineInstall(kind: LLMRequirementKind): LLMInstallationView {
    return {
      jobId: null,
      kind,
      label: this.requirementLabel(kind),
      phase: 'starting',
      status: 'starting',
      progress: null,
      message: `Starting ${this.requirementLabel(kind)} installation...`,
      error: null,
      cancellable: false,
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
      cancellable: false,
    };
  }

  failedLLMEngineInstall(
    kind: LLMRequirementKind,
    message: string,
    current: LLMInstallationView | null,
  ): LLMInstallationView {
    return {
      jobId: current?.jobId ?? null,
      kind,
      label: this.requirementLabel(kind),
      phase: 'failed',
      status: 'failed',
      progress: current?.progress ?? null,
      message,
      error: message,
      cancellable: false,
    };
  }

  requirementLabel(kind: LLMRequirementKind | null): string {
    if (kind === null) {
      return 'Runtime';
    }

    return LLM_REQUIREMENT_LABELS[kind] ?? 'Runtime';
  }

  errorMessage(error: unknown): string {
    return requestErrorMessage(error, 'The model download did not complete.');
  }

  private readJobProgress(
    record: LLMJobRecord,
    fallbackPhase: DownloadPhase,
  ): {
    status: string;
    error: string | null;
    phase: DownloadPhase;
    progress: number | null;
  } {
    const status =
      this.readString(record, 'status') ??
      this.readString(record, 'phase') ??
      fallbackPhase;
    const error = this.readString(record, 'error');
    const phase = this.phaseFrom(
      this.derivation.normalizedCode(status),
      fallbackPhase,
      error,
    );
    return { status, error, phase, progress: this.progressFrom(record, phase) };
  }

  private phaseFrom(
    status: string,
    fallbackPhase: DownloadPhase,
    error: string | null,
  ): DownloadPhase {
    if (status === 'canceled') {
      return 'canceled';
    }

    if (status === 'cancel_requested') {
      return 'cancel_requested';
    }

    if (error !== null || status === 'failed') {
      return 'failed';
    }

    if (status === 'waiting_for_user') {
      return 'waiting_for_user';
    }

    if (status === 'succeeded') {
      return 'succeeded';
    }

    return fallbackPhase === 'starting' ? 'starting' : 'running';
  }

  private progressFrom(
    record: LLMJobRecord,
    phase: DownloadPhase,
  ): number | null {
    const direct = this.readNumber(record, 'progress');
    if (direct !== null) {
      return this.percent(direct);
    }

    const completed = this.readNumber(record, 'completed');
    const total = this.readNumber(record, 'total');
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

    if (phase === 'canceled') {
      return 'Model download canceled.';
    }

    if (phase === 'cancel_requested') {
      return 'Canceling model download.';
    }

    return 'Model download is running.';
  }

  private defaultLLMEngineInstallMessage(
    kind: LLMRequirementKind,
    phase: DownloadPhase,
  ): string {
    if (phase === 'succeeded') {
      return `${this.requirementLabel(kind)} installation completed.`;
    }

    if (phase === 'failed') {
      return `${this.requirementLabel(kind)} installation failed.`;
    }

    if (phase === 'canceled') {
      return `${this.requirementLabel(kind)} installation canceled.`;
    }

    if (phase === 'cancel_requested') {
      return `Canceling ${this.requirementLabel(kind)} installation.`;
    }

    if (phase === 'waiting_for_user') {
      return `${this.requirementLabel(kind)} needs confirmation in Windows.`;
    }

    return `${this.requirementLabel(kind)} installation is running.`;
  }

  private asRecord(value: unknown): LLMJobRecord {
    if (typeof value === 'object' && value !== null) {
      return value as LLMJobRecord;
    }

    return {};
  }

  private readString(
    record: LLMJobRecord,
    key: keyof LLMJobRecord,
  ): string | null {
    const value = record[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  private readNumber(
    record: LLMJobRecord,
    key: keyof LLMJobRecord,
  ): number | null {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private readBoolean(
    record: LLMJobRecord,
    key: keyof LLMJobRecord,
  ): boolean {
    return record[key] === true;
  }

  private runtimeKindFrom(
    record: LLMJobRecord,
    fallbackKind: LLMRequirementKind,
  ): LLMRequirementKind {
    const kind = this.derivation.normalizedCode(
      this.readString(record, 'kind') ?? fallbackKind,
    );
    return kind === 'ollama' || kind === 'ollama_model' ? kind : fallbackKind;
  }
}
