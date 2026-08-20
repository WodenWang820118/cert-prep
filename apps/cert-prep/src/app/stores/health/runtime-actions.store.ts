import { computed, inject, Injectable, OnDestroy, signal } from '@angular/core';
import { from, Subscription } from 'rxjs';
import type {
  DownloadPhase,
  ModelDownloadView,
  RuntimeInstallationView,
  RuntimeKind,
} from './contracts/health-runtime.contracts';
import type { RuntimeActionContext } from './contracts/health-runtime.contracts';
import { OperationStore } from '../operation.store';
import { RuntimeApiClientsService } from './runtime-api-clients.service';
import { RuntimeJobViewService } from './runtime-job-view.service';

@Injectable({ providedIn: 'root' })
export class RuntimeActionsStore implements OnDestroy {
  private readonly operations = inject(OperationStore);
  private readonly runtimeApi = inject(RuntimeApiClientsService);
  private readonly jobView = inject(RuntimeJobViewService);
  private modelDownloadStreamSubscription: Subscription | null = null;
  private runtimeInstallStreamSubscription: Subscription | null = null;

  readonly modelDownloadConsentVisible = signal(false);
  readonly modelDownloadStarting = signal(false);
  readonly modelDownloadCanceling = signal(false);
  readonly modelDownload = signal<ModelDownloadView | null>(null);
  readonly modelDownloadStreamError = signal<string | null>(null);
  readonly runtimeInstallConsentKind = signal<RuntimeKind | null>(null);
  readonly runtimeInstallStarting = signal(false);
  readonly runtimeInstallCanceling = signal(false);
  readonly runtimeInstall = signal<RuntimeInstallationView | null>(null);
  readonly runtimeInstallStreamError = signal<string | null>(null);

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
    this.clearModelDownloadStream();
    this.clearRuntimeInstallStream();
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
    this.clearModelDownloadStream();
    this.modelDownloadStreamError.set(null);
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
    this.clearRuntimeInstallStream();
    this.runtimeInstallStreamError.set(null);
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
    this.clearRuntimeInstallStream();
    this.runtimeInstallStreamError.set(null);

    from(client.getRuntimeInstallation(current.jobId)).subscribe({
      next: (response) => {
        const status = this.toRuntimeInstallationView(response, current.kind, current.phase);
        this.runtimeInstall.set(status);
        this.continueRuntimeInstallation(status, context);
      },
      error: () => {
        this.runtimeInstallStreamError.set(
          'Runtime installation status could not be refreshed. Retry refresh to reconnect.',
        );
      },
    });
  }

  refreshModelDownload(context: RuntimeActionContext): void {
    const current = this.modelDownload();
    if (current === null || current.jobId === null) {
      return;
    }

    const client = this.runtimeApi.modelDownloadClient();
    this.clearModelDownloadStream();
    this.modelDownloadStreamError.set(null);

    from(client.getModelDownload(current.jobId)).subscribe({
      next: (response) => {
        const status = this.toModelDownloadView(response, current.phase, context);
        this.modelDownload.set(status);
        this.continueModelDownload(status, context);
      },
      error: () => {
        this.modelDownloadStreamError.set(
          'Model download status could not be refreshed. Retry refresh to reconnect.',
        );
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
    this.clearModelDownloadStream();
    this.modelDownloadStreamError.set(null);
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
    this.clearRuntimeInstallStream();
    this.runtimeInstallStreamError.set(null);
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

    this.startModelDownloadStream(status, context);
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

    this.startRuntimeInstallStream(status, context);
  }

  private refreshHealthAfterRuntimeChange(
    context: RuntimeActionContext,
  ): void {
    context.refreshHealthAfterRuntimeChange();
  }

  private startModelDownloadStream(
    status: ModelDownloadView,
    context: RuntimeActionContext,
  ): void {
    if (status.jobId === null) return;
    this.clearModelDownloadStream();
    this.modelDownloadStreamError.set(null);
    this.modelDownloadStreamSubscription = this.runtimeApi
      .modelDownloadClient()
      .streamModelDownload(status.jobId)
      .subscribe({
        next: (response) => {
          const next = this.toModelDownloadView(response, status.phase, context);
          this.modelDownload.set(next);
          if (next.phase === 'succeeded') {
            this.clearModelDownloadStream();
            this.refreshHealthAfterRuntimeChange(context);
          } else if (next.phase === 'failed') {
            this.clearModelDownloadStream();
            this.operations.fail(next.error ?? next.message);
          } else if (next.phase === 'canceled') {
            this.clearModelDownloadStream();
          }
        },
        error: () => {
          this.modelDownloadStreamSubscription = null;
          this.modelDownloadStreamError.set(
            'Model download progress stream disconnected. Retry refresh to reconnect.',
          );
        },
        complete: () => {
          this.modelDownloadStreamSubscription = null;
        },
      });
  }

  private startRuntimeInstallStream(
    status: RuntimeInstallationView,
    context: RuntimeActionContext,
  ): void {
    if (status.jobId === null) return;
    this.clearRuntimeInstallStream();
    this.runtimeInstallStreamError.set(null);
    this.runtimeInstallStreamSubscription = this.runtimeApi
      .runtimeInstallationClient()
      .streamRuntimeInstallation(status.jobId)
      .subscribe({
        next: (response) => {
          const next = this.toRuntimeInstallationView(response, status.kind, status.phase);
          this.runtimeInstall.set(next);
          if (next.phase === 'succeeded') {
            this.clearRuntimeInstallStream();
            this.refreshHealthAfterRuntimeChange(context);
          } else if (next.phase === 'failed') {
            this.clearRuntimeInstallStream();
            this.operations.fail(next.error ?? next.message);
          } else if (next.phase === 'canceled') {
            this.clearRuntimeInstallStream();
          }
        },
        error: () => {
          this.runtimeInstallStreamSubscription = null;
          this.runtimeInstallStreamError.set(
            'Runtime installation progress stream disconnected. Retry refresh to reconnect.',
          );
        },
        complete: () => {
          this.runtimeInstallStreamSubscription = null;
        },
      });
  }

  private clearModelDownloadStream(): void {
    this.modelDownloadStreamSubscription?.unsubscribe();
    this.modelDownloadStreamSubscription = null;
  }

  private clearRuntimeInstallStream(): void {
    this.runtimeInstallStreamSubscription?.unsubscribe();
    this.runtimeInstallStreamSubscription = null;
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
