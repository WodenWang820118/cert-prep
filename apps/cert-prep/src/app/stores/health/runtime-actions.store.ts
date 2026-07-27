import { computed, inject, Injectable, OnDestroy, signal } from '@angular/core';
import { from, Subscription, timer } from 'rxjs';
import type {
  DownloadPhase,
  ModelDownloadView,
  RuntimeInstallationView,
  RuntimeKind,
} from './contracts/health-runtime.contracts';
import { RUNTIME_JOB_POLL_INTERVAL_MS } from './constants/health.constants';
import type { RuntimeActionContext } from './contracts/health-runtime.contracts';
import { OperationStore } from '../operation.store';
import { RuntimeApiClientsService } from './runtime-api-clients.service';
import { RuntimeJobViewService } from './runtime-job-view.service';

@Injectable({ providedIn: 'root' })
export class RuntimeActionsStore implements OnDestroy {
  private readonly operations = inject(OperationStore);
  private readonly runtimeApi = inject(RuntimeApiClientsService);
  private readonly jobView = inject(RuntimeJobViewService);
  private modelDownloadPollTimer: Subscription | null = null;
  private runtimeInstallPollTimer: Subscription | null = null;

  readonly modelDownloadConsentVisible = signal(false);
  readonly modelDownloadStarting = signal(false);
  readonly modelDownloadCanceling = signal(false);
  readonly modelDownload = signal<ModelDownloadView | null>(null);
  readonly runtimeInstallConsentKind = signal<RuntimeKind | null>(null);
  readonly runtimeInstallStarting = signal(false);
  readonly runtimeInstallCanceling = signal(false);
  readonly runtimeInstall = signal<RuntimeInstallationView | null>(null);

  readonly isModelDownloadActive = computed(() => {
    const phase = this.modelDownload()?.phase;
    return (
      this.modelDownloadStarting() ||
      phase === 'starting' ||
      phase === 'running' ||
      phase === 'cancel_requested'
    );
  });

  readonly isRuntimeInstallActive = computed(() => {
    const phase = this.runtimeInstall()?.phase;
    return (
      this.runtimeInstallStarting() ||
      phase === 'starting' ||
      phase === 'running' ||
      phase === 'cancel_requested' ||
      phase === 'waiting_for_user'
    );
  });

  readonly runtimeInstallConsentVisible = computed(
    () => this.runtimeInstallConsentKind() !== null,
  );
  readonly canCancelModelDownload = computed(() => {
    const download = this.modelDownload();
    return (
      download !== null &&
      download.jobId !== null &&
      download.cancellable &&
      this.isModelDownloadActive() &&
      !this.modelDownloadCanceling()
    );
  });
  readonly canCancelRuntimeInstallation = computed(() => {
    const install = this.runtimeInstall();
    return (
      install !== null &&
      install.jobId !== null &&
      install.cancellable &&
      this.isRuntimeInstallActive() &&
      !this.runtimeInstallCanceling()
    );
  });

  ngOnDestroy(): void {
    this.clearModelDownloadPollTimer();
    this.clearRuntimeInstallPollTimer();
  }

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

  confirmModelDownload(context: RuntimeActionContext): void {
    if (!context.canDownloadModel() || this.modelDownloadStarting()) {
      return;
    }

    const client = this.runtimeApi.modelDownloadClient();
    this.clearModelDownloadPollTimer();
    this.modelDownloadStarting.set(true);
    this.modelDownload.set(
      this.jobView.startingDownload(context.configuredModelName()),
    );

    from(client.startModelDownload()).subscribe({
      next: (response) => {
        const status = this.toModelDownloadView(response, 'running', context);
        this.modelDownload.set(status);
        this.modelDownloadConsentVisible.set(false);
        this.continueModelDownload(status, context);
        this.modelDownloadStarting.set(false);
      },
      error: (error: unknown) => {
        const message = this.jobView.errorMessage(error);
        this.modelDownload.set(this.failedDownload(message, context));
        this.operations.fail(message);
        this.modelDownloadStarting.set(false);
      },
    });
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

  confirmRuntimeInstallation(
    context: RuntimeActionContext,
  ): void {
    const kind = this.runtimeInstallConsentKind();
    if (
      kind === null ||
      !context.canInstallRuntime(kind) ||
      this.runtimeInstallStarting()
    ) {
      return;
    }

    const client = this.runtimeApi.runtimeInstallationClient();
    this.clearRuntimeInstallPollTimer();
    this.runtimeInstallStarting.set(true);
    this.runtimeInstall.set(this.jobView.startingRuntimeInstall(kind));

    from(client.startRuntimeInstallation(kind)).subscribe({
      next: (response) => {
        const status = this.toRuntimeInstallationView(response, kind, 'running');
        this.runtimeInstall.set(status);
        this.runtimeInstallConsentKind.set(null);
        this.continueRuntimeInstallation(status, context);
        this.runtimeInstallStarting.set(false);
      },
      error: (error: unknown) => {
        const message = this.jobView.errorMessage(error);
        this.runtimeInstall.set(this.failedRuntimeInstall(kind, message));
        this.operations.fail(message);
        this.runtimeInstallStarting.set(false);
      },
    });
  }

  refreshRuntimeInstallation(
    context: RuntimeActionContext,
  ): void {
    const current = this.runtimeInstall();
    if (current === null || current.jobId === null) {
      return;
    }

    const client = this.runtimeApi.runtimeInstallationClient();
    this.clearRuntimeInstallPollTimer();

    from(client.getRuntimeInstallation(current.jobId)).subscribe({
      next: (response) => {
        const status = this.toRuntimeInstallationView(response, current.kind, current.phase);
        this.runtimeInstall.set(status);
        this.continueRuntimeInstallation(status, context);
      },
      error: (error: unknown) => {
        const message = this.jobView.errorMessage(error);
        this.runtimeInstall.set({ ...current, phase: 'failed', status: 'failed', message, error: message });
        this.operations.fail(message);
      },
    });
  }

  refreshModelDownload(context: RuntimeActionContext): void {
    const current = this.modelDownload();
    if (current === null || current.jobId === null) {
      return;
    }

    const client = this.runtimeApi.modelDownloadClient();
    this.clearModelDownloadPollTimer();

    from(client.getModelDownload(current.jobId)).subscribe({
      next: (response) => {
        const status = this.toModelDownloadView(response, current.phase, context);
        this.modelDownload.set(status);
        this.continueModelDownload(status, context);
      },
      error: (error: unknown) => {
        const message = this.jobView.errorMessage(error);
        this.modelDownload.set({ ...current, phase: 'failed', status: 'failed', message, error: message });
        this.operations.fail(message);
      },
    });
  }

  cancelModelDownload(context: RuntimeActionContext): void {
    const current = this.modelDownload();
    if (
      current === null ||
      current.jobId === null ||
      !this.canCancelModelDownload()
    ) {
      return;
    }

    const client = this.runtimeApi.modelDownloadClient();
    this.clearModelDownloadPollTimer();
    this.modelDownloadCanceling.set(true);
    from(client.cancelModelDownload(current.jobId)).subscribe({
      next: (response) => {
        const status = this.toModelDownloadView(response, 'cancel_requested', context);
        this.modelDownload.set(status);
        this.continueModelDownload(status, context);
        this.modelDownloadCanceling.set(false);
      },
      error: (error: unknown) => {
        this.operations.fail(this.jobView.errorMessage(error));
        this.continueModelDownload(current, context);
        this.modelDownloadCanceling.set(false);
      },
    });
  }

  cancelRuntimeInstallation(
    context: RuntimeActionContext,
  ): void {
    const current = this.runtimeInstall();
    if (
      current === null ||
      current.jobId === null ||
      !this.canCancelRuntimeInstallation()
    ) {
      return;
    }

    const client = this.runtimeApi.runtimeInstallationClient();
    this.clearRuntimeInstallPollTimer();
    this.runtimeInstallCanceling.set(true);
    from(client.cancelRuntimeInstallation(current.jobId)).subscribe({
      next: (response) => {
        const status = this.toRuntimeInstallationView(response, current.kind, 'cancel_requested');
        this.runtimeInstall.set(status);
        this.continueRuntimeInstallation(status, context);
        this.runtimeInstallCanceling.set(false);
      },
      error: (error: unknown) => {
        this.operations.fail(this.jobView.errorMessage(error));
        this.continueRuntimeInstallation(current, context);
        this.runtimeInstallCanceling.set(false);
      },
    });
  }

  private continueModelDownload(
    status: ModelDownloadView,
    context: RuntimeActionContext,
  ): void {
    if (status.phase === 'succeeded') {
      this.refreshHealthAfterRuntimeChange(context);
      return;
    }

    if (status.phase === 'failed') {
      this.operations.fail(status.error ?? status.message);
      return;
    }

    if (status.phase === 'canceled') {
      return;
    }

    this.scheduleModelDownloadPoll(context);
  }

  private continueRuntimeInstallation(
    status: RuntimeInstallationView,
    context: RuntimeActionContext,
  ): void {
    if (status.phase === 'succeeded') {
      this.refreshHealthAfterRuntimeChange(context);
      return;
    }

    if (status.phase === 'failed') {
      this.operations.fail(status.error ?? status.message);
      return;
    }

    if (status.phase === 'canceled') {
      return;
    }

    if (status.phase === 'waiting_for_user') {
      return;
    }

    this.scheduleRuntimeInstallPoll(context);
  }

  private refreshHealthAfterRuntimeChange(
    context: RuntimeActionContext,
  ): void {
    context.refreshHealthAfterRuntimeChange();
  }

  private scheduleModelDownloadPoll(context: RuntimeActionContext): void {
    this.clearModelDownloadPollTimer();
    this.modelDownloadPollTimer = timer(RUNTIME_JOB_POLL_INTERVAL_MS).subscribe(() => {
      this.modelDownloadPollTimer = null;
      this.refreshModelDownload(context);
    });
  }

  private scheduleRuntimeInstallPoll(context: RuntimeActionContext): void {
    this.clearRuntimeInstallPollTimer();
    this.runtimeInstallPollTimer = timer(RUNTIME_JOB_POLL_INTERVAL_MS).subscribe(() => {
      this.runtimeInstallPollTimer = null;
      this.refreshRuntimeInstallation(context);
    });
  }

  private clearModelDownloadPollTimer(): void {
    if (this.modelDownloadPollTimer !== null) {
      this.modelDownloadPollTimer.unsubscribe();
      this.modelDownloadPollTimer = null;
    }
  }

  private clearRuntimeInstallPollTimer(): void {
    if (this.runtimeInstallPollTimer !== null) {
      this.runtimeInstallPollTimer.unsubscribe();
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
