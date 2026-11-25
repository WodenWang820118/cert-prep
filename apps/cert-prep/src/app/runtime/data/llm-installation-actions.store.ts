import type { LLMRequirementKind } from '../../core/domain';
import { computed, inject, Injectable, OnDestroy, signal } from '@angular/core';
import { from, Subscription } from 'rxjs';
import type {
  DownloadPhase,
  ModelDownloadView,
  LLMInstallationView,
} from '../domain';
import type { LLMInstallationActionContext } from '../domain';
import { OperationStore } from '../../core/data';
import { LLMApiClientsService } from './llm-api-clients.service';
import { LLMJobViewService } from './llm-job-view.service';

@Injectable({ providedIn: 'root' })
export class LLMInstallationActionsStore implements OnDestroy {
  private readonly operations = inject(OperationStore);
  private readonly runtimeApi = inject(LLMApiClientsService);
  private readonly jobView = inject(LLMJobViewService);
  private modelDownloadStreamSubscription: Subscription | null = null;
  private llmEngineInstallStreamSubscription: Subscription | null = null;

  readonly modelDownloadConsentVisible = signal(false);
  readonly modelDownloadStarting = signal(false);
  readonly modelDownloadCanceling = signal(false);
  readonly modelDownload = signal<ModelDownloadView | null>(null);
  readonly modelDownloadStreamError = signal<string | null>(null);
  readonly llmEngineInstallConsentKind = signal<LLMRequirementKind | null>(null);
  readonly llmEngineInstallStarting = signal(false);
  readonly llmEngineInstallCanceling = signal(false);
  readonly llmEngineInstall = signal<LLMInstallationView | null>(null);
  readonly llmEngineInstallStreamError = signal<string | null>(null);

  readonly isModelDownloadActive = computed(() => {
    const phase = this.modelDownload()?.phase;
    return (
      this.modelDownloadStarting() ||
      phase === 'starting' ||
      phase === 'running' ||
      phase === 'cancel_requested'
    );
  });

  readonly isLLMEngineInstallActive = computed(() => {
    const phase = this.llmEngineInstall()?.phase;
    return (
      this.llmEngineInstallStarting() ||
      phase === 'starting' ||
      phase === 'running' ||
      phase === 'cancel_requested' ||
      phase === 'waiting_for_user'
    );
  });

  readonly llmEngineInstallConsentVisible = computed(
    () => this.llmEngineInstallConsentKind() !== null,
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
  readonly canCancelLLMEngineInstallation = computed(() => {
    const install = this.llmEngineInstall();
    return (
      install !== null &&
      install.jobId !== null &&
      install.cancellable &&
      this.isLLMEngineInstallActive() &&
      !this.llmEngineInstallCanceling()
    );
  });

  ngOnDestroy(): void {
    this.clearModelDownloadStream();
    this.clearLLMEngineInstallStream();
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

  confirmModelDownload(context: LLMInstallationActionContext): void {
    if (!context.canDownloadModel() || this.modelDownloadStarting()) {
      return;
    }

    const client = this.runtimeApi.llmInstallationClient();
    this.clearModelDownloadStream();
    this.modelDownloadStreamError.set(null);
    this.modelDownloadStarting.set(true);
    this.modelDownload.set(
      this.jobView.startingDownload(context.configuredModelName()),
    );

    from(client.startLlmInstallation('ollama_model')).subscribe({
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

  openLLMEngineInstallConsent(
    kind: LLMRequirementKind,
    canInstallLLMEngine: boolean,
  ): void {
    if (canInstallLLMEngine) {
      this.llmEngineInstallConsentKind.set(kind);
    }
  }

  setLLMEngineInstallConsentVisible(visible: boolean): void {
    if (!visible) {
      this.cancelLLMEngineInstallConsent();
    }
  }

  cancelLLMEngineInstallConsent(): void {
    if (!this.llmEngineInstallStarting()) {
      this.llmEngineInstallConsentKind.set(null);
    }
  }

  confirmLLMEngineInstallation(
    context: LLMInstallationActionContext,
  ): void {
    const kind = this.llmEngineInstallConsentKind();
    if (
      kind === null ||
      !context.canInstallLLMEngine(kind) ||
      this.llmEngineInstallStarting()
    ) {
      return;
    }

    const client = this.runtimeApi.llmInstallationClient();
    this.clearLLMEngineInstallStream();
    this.llmEngineInstallStreamError.set(null);
    this.llmEngineInstallStarting.set(true);
    this.llmEngineInstall.set(this.jobView.startingLLMEngineInstall(kind));

    from(client.startLlmInstallation(kind)).subscribe({
      next: (response) => {
        const status = this.toLLMInstallationView(response, kind, 'running');
        this.llmEngineInstall.set(status);
        this.llmEngineInstallConsentKind.set(null);
        this.continueLLMEngineInstallation(status, context);
        this.llmEngineInstallStarting.set(false);
      },
      error: (error: unknown) => {
        const message = this.jobView.errorMessage(error);
        this.llmEngineInstall.set(this.failedLLMEngineInstall(kind, message));
        this.operations.fail(message);
        this.llmEngineInstallStarting.set(false);
      },
    });
  }

  refreshLLMEngineInstallation(
    context: LLMInstallationActionContext,
  ): void {
    const current = this.llmEngineInstall();
    if (current === null || current.jobId === null) {
      return;
    }

    const client = this.runtimeApi.llmInstallationClient();
    this.clearLLMEngineInstallStream();
    this.llmEngineInstallStreamError.set(null);

    from(client.getLlmInstallation(current.jobId)).subscribe({
      next: (response) => {
        const status = this.toLLMInstallationView(response, current.kind, current.phase);
        this.llmEngineInstall.set(status);
        this.continueLLMEngineInstallation(status, context);
      },
      error: () => {
        this.llmEngineInstallStreamError.set(
          'Runtime installation status could not be refreshed. Retry refresh to reconnect.',
        );
      },
    });
  }

  refreshModelDownload(context: LLMInstallationActionContext): void {
    const current = this.modelDownload();
    if (current === null || current.jobId === null) {
      return;
    }

    const client = this.runtimeApi.llmInstallationClient();
    this.clearModelDownloadStream();
    this.modelDownloadStreamError.set(null);

    from(client.getLlmInstallation(current.jobId)).subscribe({
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

  cancelModelDownload(context: LLMInstallationActionContext): void {
    const current = this.modelDownload();
    if (
      current === null ||
      current.jobId === null ||
      !this.canCancelModelDownload()
    ) {
      return;
    }

    const client = this.runtimeApi.llmInstallationClient();
    this.clearModelDownloadStream();
    this.modelDownloadStreamError.set(null);
    this.modelDownloadCanceling.set(true);
    from(client.cancelLlmInstallation(current.jobId)).subscribe({
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

  cancelLLMEngineInstallation(
    context: LLMInstallationActionContext,
  ): void {
    const current = this.llmEngineInstall();
    if (
      current === null ||
      current.jobId === null ||
      !this.canCancelLLMEngineInstallation()
    ) {
      return;
    }

    const client = this.runtimeApi.llmInstallationClient();
    this.clearLLMEngineInstallStream();
    this.llmEngineInstallStreamError.set(null);
    this.llmEngineInstallCanceling.set(true);
    from(client.cancelLlmInstallation(current.jobId)).subscribe({
      next: (response) => {
        const status = this.toLLMInstallationView(response, current.kind, 'cancel_requested');
        this.llmEngineInstall.set(status);
        this.continueLLMEngineInstallation(status, context);
        this.llmEngineInstallCanceling.set(false);
      },
      error: (error: unknown) => {
        this.operations.fail(this.jobView.errorMessage(error));
        this.continueLLMEngineInstallation(current, context);
        this.llmEngineInstallCanceling.set(false);
      },
    });
  }

  private continueModelDownload(
    status: ModelDownloadView,
    context: LLMInstallationActionContext,
  ): void {
    if (status.phase === 'succeeded') {
      this.refreshHealthAfterLLMInstallation(context);
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

  private continueLLMEngineInstallation(
    status: LLMInstallationView,
    context: LLMInstallationActionContext,
  ): void {
    if (status.phase === 'succeeded') {
      this.refreshHealthAfterLLMInstallation(context);
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

    this.startLLMEngineInstallStream(status, context);
  }

  private refreshHealthAfterLLMInstallation(
    context: LLMInstallationActionContext,
  ): void {
    context.refreshHealthAfterLLMInstallation();
  }

  private startModelDownloadStream(
    status: ModelDownloadView,
    context: LLMInstallationActionContext,
  ): void {
    if (status.jobId === null) return;
    this.clearModelDownloadStream();
    this.modelDownloadStreamError.set(null);
    this.modelDownloadStreamSubscription = this.runtimeApi
      .llmInstallationClient()
      .streamLlmInstallation(status.jobId)
      .subscribe({
        next: (response) => {
          const next = this.toModelDownloadView(response, status.phase, context);
          this.modelDownload.set(next);
          if (next.phase === 'succeeded') {
            this.clearModelDownloadStream();
            this.refreshHealthAfterLLMInstallation(context);
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

  private startLLMEngineInstallStream(
    status: LLMInstallationView,
    context: LLMInstallationActionContext,
  ): void {
    if (status.jobId === null) return;
    this.clearLLMEngineInstallStream();
    this.llmEngineInstallStreamError.set(null);
    this.llmEngineInstallStreamSubscription = this.runtimeApi
      .llmInstallationClient()
      .streamLlmInstallation(status.jobId)
      .subscribe({
        next: (response) => {
          const next = this.toLLMInstallationView(response, status.kind, status.phase);
          this.llmEngineInstall.set(next);
          if (next.phase === 'succeeded') {
            this.clearLLMEngineInstallStream();
            this.refreshHealthAfterLLMInstallation(context);
          } else if (next.phase === 'failed') {
            this.clearLLMEngineInstallStream();
            this.operations.fail(next.error ?? next.message);
          } else if (next.phase === 'canceled') {
            this.clearLLMEngineInstallStream();
          }
        },
        error: () => {
          this.llmEngineInstallStreamSubscription = null;
          this.llmEngineInstallStreamError.set(
            'Runtime installation progress stream disconnected. Retry refresh to reconnect.',
          );
        },
        complete: () => {
          this.llmEngineInstallStreamSubscription = null;
        },
      });
  }

  private clearModelDownloadStream(): void {
    this.modelDownloadStreamSubscription?.unsubscribe();
    this.modelDownloadStreamSubscription = null;
  }

  private clearLLMEngineInstallStream(): void {
    this.llmEngineInstallStreamSubscription?.unsubscribe();
    this.llmEngineInstallStreamSubscription = null;
  }

  private toModelDownloadView(
    response: unknown,
    fallbackPhase: DownloadPhase,
    context: LLMInstallationActionContext,
  ): ModelDownloadView {
    return this.jobView.toModelDownloadView(response, fallbackPhase, {
      currentJobId: this.modelDownload()?.jobId ?? null,
      modelName: context.configuredModelName(),
    });
  }

  private toLLMInstallationView(
    response: unknown,
    fallbackKind: LLMRequirementKind,
    fallbackPhase: DownloadPhase,
  ): LLMInstallationView {
    return this.jobView.toLLMInstallationView(
      response,
      fallbackKind,
      fallbackPhase,
      {
        currentJobId: this.llmEngineInstall()?.jobId ?? null,
      },
    );
  }

  private failedDownload(
    message: string,
    context: LLMInstallationActionContext,
  ): ModelDownloadView {
    return this.jobView.failedDownload(
      message,
      this.modelDownload(),
      context.configuredModelName(),
    );
  }

  private failedLLMEngineInstall(
    kind: LLMRequirementKind,
    message: string,
  ): LLMInstallationView {
    return this.jobView.failedLLMEngineInstall(
      kind,
      message,
      this.llmEngineInstall(),
    );
  }
}
