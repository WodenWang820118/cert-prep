import { computed, inject, Injectable, signal } from '@angular/core';
import type {
  DownloadPhase,
  ModelDownloadView,
  RuntimeInstallationView,
  RuntimeKind,
} from './contracts/health-runtime.contracts';
import { OperationStore } from '../operation.store';
import { RuntimeApiClientsService } from './runtime-api-clients.service';
import { RuntimeJobViewService } from './runtime-job-view.service';

const RUNTIME_JOB_POLL_INTERVAL_MS = 1500;

interface RuntimeActionContext {
  readonly canDownloadModel: () => boolean;
  readonly canInstallRuntime: (kind: RuntimeKind) => boolean;
  readonly configuredModelName: () => string;
  readonly refreshHealthAfterRuntimeChange: () => Promise<void>;
}

@Injectable({ providedIn: 'root' })
export class RuntimeActionsStore {
  private readonly operations = inject(OperationStore);
  private readonly runtimeApi = inject(RuntimeApiClientsService);
  private readonly jobView = inject(RuntimeJobViewService);
  private modelDownloadPollTimer: ReturnType<typeof setTimeout> | null = null;
  private runtimeInstallPollTimer: ReturnType<typeof setTimeout> | null = null;

  readonly modelDownloadConsentVisible = signal(false);
  readonly modelDownloadStarting = signal(false);
  readonly modelDownload = signal<ModelDownloadView | null>(null);
  readonly runtimeInstallConsentKind = signal<RuntimeKind | null>(null);
  readonly runtimeInstallStarting = signal(false);
  readonly runtimeInstall = signal<RuntimeInstallationView | null>(null);

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

  readonly runtimeInstallConsentVisible = computed(
    () => this.runtimeInstallConsentKind() !== null,
  );

  openModelDownloadConsent(canDownloadModel: boolean): void {
    if (canDownloadModel) {
      this.modelDownloadConsentVisible.set(true);
    }
  }

  setModelDownloadConsentVisible(
    visible: boolean,
    canDownloadModel: boolean,
  ): void {
    if (visible) {
      this.openModelDownloadConsent(canDownloadModel);
      return;
    }

    this.cancelModelDownloadConsent();
  }

  cancelModelDownloadConsent(): void {
    if (!this.modelDownloadStarting()) {
      this.modelDownloadConsentVisible.set(false);
    }
  }

  async confirmModelDownload(context: RuntimeActionContext): Promise<void> {
    if (!context.canDownloadModel() || this.modelDownloadStarting()) {
      return;
    }

    const client = this.runtimeApi.modelDownloadClient();
    if (client === null) {
      const message = 'Model download API is unavailable.';
      this.modelDownloadConsentVisible.set(false);
      this.modelDownload.set(this.failedDownload(message, context));
      this.operations.fail(message);
      return;
    }

    this.clearModelDownloadPollTimer();
    this.modelDownloadStarting.set(true);
    this.modelDownload.set(
      this.jobView.startingDownload(context.configuredModelName()),
    );

    try {
      const response = await client.startModelDownload();
      const status = this.toModelDownloadView(response, 'running', context);
      this.modelDownload.set(status);
      this.modelDownloadConsentVisible.set(false);
      this.continueModelDownload(status, context);
    } catch (error) {
      const message = this.jobView.errorMessage(error);
      this.modelDownload.set(this.failedDownload(message, context));
      this.operations.fail(message);
    } finally {
      this.modelDownloadStarting.set(false);
    }
  }

  openRuntimeInstallConsent(
    kind: RuntimeKind,
    canInstallRuntime: boolean,
  ): void {
    if (canInstallRuntime) {
      this.runtimeInstallConsentKind.set(kind);
    }
  }

  openOcrRuntimeInstallConsent(
    kind: RuntimeKind,
    runtimeInstallActive: boolean,
  ): void {
    if (!runtimeInstallActive) {
      this.runtimeInstallConsentKind.set(kind);
    }
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

  async confirmRuntimeInstallation(
    context: RuntimeActionContext,
  ): Promise<void> {
    const kind = this.runtimeInstallConsentKind();
    if (
      kind === null ||
      !context.canInstallRuntime(kind) ||
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
      const status = this.toRuntimeInstallationView(
        response,
        kind,
        'running',
      );
      this.runtimeInstall.set(status);
      this.runtimeInstallConsentKind.set(null);
      this.continueRuntimeInstallation(status, context);
    } catch (error) {
      const message = this.jobView.errorMessage(error);
      this.runtimeInstall.set(this.failedRuntimeInstall(kind, message));
      this.operations.fail(message);
    } finally {
      this.runtimeInstallStarting.set(false);
    }
  }

  async refreshRuntimeInstallation(
    context: RuntimeActionContext,
  ): Promise<void> {
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
      this.continueRuntimeInstallation(status, context);
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

  async refreshModelDownload(context: RuntimeActionContext): Promise<void> {
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
      const status = this.toModelDownloadView(
        response,
        current.phase,
        context,
      );
      this.modelDownload.set(status);
      this.continueModelDownload(status, context);
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

  private continueModelDownload(
    status: ModelDownloadView,
    context: RuntimeActionContext,
  ): void {
    if (status.phase === 'succeeded') {
      void this.refreshHealthAfterRuntimeChange(context);
      return;
    }

    if (status.phase === 'failed') {
      this.operations.fail(status.error ?? status.message);
      return;
    }

    this.scheduleModelDownloadPoll(context);
  }

  private continueRuntimeInstallation(
    status: RuntimeInstallationView,
    context: RuntimeActionContext,
  ): void {
    if (status.phase === 'succeeded') {
      void this.refreshHealthAfterRuntimeChange(context);
      return;
    }

    if (status.phase === 'failed') {
      this.operations.fail(status.error ?? status.message);
      return;
    }

    if (status.phase === 'waiting_for_user') {
      return;
    }

    this.scheduleRuntimeInstallPoll(context);
  }

  private async refreshHealthAfterRuntimeChange(
    context: RuntimeActionContext,
  ): Promise<void> {
    try {
      await context.refreshHealthAfterRuntimeChange();
    } catch (error) {
      this.operations.fail(this.jobView.errorMessage(error));
    }
  }

  private scheduleModelDownloadPoll(context: RuntimeActionContext): void {
    this.clearModelDownloadPollTimer();
    this.modelDownloadPollTimer = setTimeout(() => {
      this.modelDownloadPollTimer = null;
      void this.refreshModelDownload(context);
    }, RUNTIME_JOB_POLL_INTERVAL_MS);
  }

  private scheduleRuntimeInstallPoll(context: RuntimeActionContext): void {
    this.clearRuntimeInstallPollTimer();
    this.runtimeInstallPollTimer = setTimeout(() => {
      this.runtimeInstallPollTimer = null;
      void this.refreshRuntimeInstallation(context);
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

  private toModelDownloadView(
    response: unknown,
    fallbackPhase: DownloadPhase,
    context: RuntimeActionContext,
  ): ModelDownloadView {
    return this.jobView.toModelDownloadView(response, fallbackPhase, {
      currentJobId: this.modelDownload()?.jobId ?? null,
      modelName: context.configuredModelName(),
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

  private failedDownload(
    message: string,
    context: RuntimeActionContext,
  ): ModelDownloadView {
    return this.jobView.failedDownload(
      message,
      this.modelDownload(),
      context.configuredModelName(),
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
}
