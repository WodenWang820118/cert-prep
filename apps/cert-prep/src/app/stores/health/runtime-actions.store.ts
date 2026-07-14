import { computed, inject, Injectable, signal } from '@angular/core';
import type {
  DownloadPhase,
  FastFlowTermsConsent,
  LLMProviderSelectionRead,
  ModelDownloadView,
  RuntimeInstallationView,
  RuntimeInstallationStartRequest,
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
  readonly fastFlowModelSelected: () => boolean;
  readonly fastFlowTerms: () => FastFlowTermsConsent | null;
  readonly applyProviderSelection: (
    selection: LLMProviderSelectionRead,
  ) => void;
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
  readonly modelDownloadCanceling = signal(false);
  readonly modelDownload = signal<ModelDownloadView | null>(null);
  readonly runtimeInstallConsentKind = signal<RuntimeKind | null>(null);
  readonly runtimeInstallStarting = signal(false);
  readonly runtimeInstallCanceling = signal(false);
  readonly runtimeInstall = signal<RuntimeInstallationView | null>(null);
  readonly fastFlowTermsAcknowledged = signal(false);
  readonly fastFlowTermsDecisionPending = signal(false);

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

  openModelDownloadConsent(canDownloadModel: boolean): void {
    if (canDownloadModel) {
      this.fastFlowTermsAcknowledged.set(false);
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
      this.fastFlowTermsAcknowledged.set(false);
    }
  }

  setFastFlowTermsAcknowledged(acknowledged: boolean): void {
    if (!this.fastFlowTermsDecisionPending()) {
      this.fastFlowTermsAcknowledged.set(acknowledged);
    }
  }

  async confirmModelDownload(context: RuntimeActionContext): Promise<void> {
    if (!context.canDownloadModel() || this.modelDownloadStarting()) {
      return;
    }

    const fastFlowTerms = context.fastFlowModelSelected()
      ? context.fastFlowTerms()
      : null;
    if (
      context.fastFlowModelSelected() &&
      !this.canProceedWithFastFlowTerms(fastFlowTerms)
    ) {
      return;
    }

    const client = this.runtimeApi.modelDownloadClient();
    this.clearModelDownloadPollTimer();
    this.modelDownloadStarting.set(true);
    this.modelDownload.set(
      this.jobView.startingDownload(context.configuredModelName()),
    );

    try {
      const body = await this.acceptedFastFlowRequest(
        fastFlowTerms,
        context,
      );
      const response = await client.startModelDownload(body);
      const status = this.toModelDownloadView(response, 'running', context);
      this.modelDownload.set(status);
      this.modelDownloadConsentVisible.set(false);
      this.fastFlowTermsAcknowledged.set(false);
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
      if (this.isFastFlowKind(kind)) {
        this.fastFlowTermsAcknowledged.set(false);
      }
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
      this.fastFlowTermsAcknowledged.set(false);
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

    const fastFlowTerms = this.isFastFlowKind(kind)
      ? context.fastFlowTerms()
      : null;
    if (
      this.isFastFlowKind(kind) &&
      !this.canProceedWithFastFlowTerms(fastFlowTerms)
    ) {
      return;
    }

    const client = this.runtimeApi.runtimeInstallationClient();
    this.clearRuntimeInstallPollTimer();
    this.runtimeInstallStarting.set(true);
    this.runtimeInstall.set(this.jobView.startingRuntimeInstall(kind));

    try {
      const body = await this.acceptedFastFlowRequest(
        fastFlowTerms,
        context,
      );
      const response = await client.startRuntimeInstallation(kind, body);
      const status = this.toRuntimeInstallationView(
        response,
        kind,
        'running',
      );
      this.runtimeInstall.set(status);
      this.runtimeInstallConsentKind.set(null);
      this.fastFlowTermsAcknowledged.set(false);
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

  async declineFastFlowTerms(
    context: RuntimeActionContext,
  ): Promise<boolean> {
    const runtimeKind = this.runtimeInstallConsentKind();
    const fastFlowConsentOpen =
      (this.modelDownloadConsentVisible() &&
        context.fastFlowModelSelected()) ||
      this.isFastFlowKind(runtimeKind);
    const terms = context.fastFlowTerms();
    if (
      !fastFlowConsentOpen ||
      this.fastFlowTermsDecisionPending()
    ) {
      return false;
    }

    const client = this.runtimeApi.providerSelectionClient();
    this.fastFlowTermsDecisionPending.set(true);
    try {
      const selection = await client.decideFastflowlmTerms({
        decision: 'declined',
        terms_version: terms?.version ?? null,
      });
      context.applyProviderSelection(selection);
      this.modelDownloadConsentVisible.set(false);
      this.runtimeInstallConsentKind.set(null);
      this.fastFlowTermsAcknowledged.set(false);
      return true;
    } catch (error) {
      this.operations.fail(this.jobView.errorMessage(error));
      return false;
    } finally {
      this.fastFlowTermsDecisionPending.set(false);
    }
  }

  async cancelModelDownload(context: RuntimeActionContext): Promise<void> {
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
    try {
      const response = await client.cancelModelDownload(current.jobId);
      const status = this.toModelDownloadView(
        response,
        'cancel_requested',
        context,
      );
      this.modelDownload.set(status);
      this.continueModelDownload(status, context);
    } catch (error) {
      this.operations.fail(this.jobView.errorMessage(error));
      this.continueModelDownload(current, context);
    } finally {
      this.modelDownloadCanceling.set(false);
    }
  }

  async cancelRuntimeInstallation(
    context: RuntimeActionContext,
  ): Promise<void> {
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
    try {
      const response = await client.cancelRuntimeInstallation(current.jobId);
      const status = this.toRuntimeInstallationView(
        response,
        current.kind,
        'cancel_requested',
      );
      this.runtimeInstall.set(status);
      this.continueRuntimeInstallation(status, context);
    } catch (error) {
      this.operations.fail(this.jobView.errorMessage(error));
      this.continueRuntimeInstallation(current, context);
    } finally {
      this.runtimeInstallCanceling.set(false);
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
      void this.refreshHealthAfterRuntimeChange(context);
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

  private canProceedWithFastFlowTerms(
    terms: FastFlowTermsConsent | null,
  ): boolean {
    if (terms === null) {
      this.operations.fail('FastFlowLM terms metadata is unavailable.');
      return false;
    }
    if (!this.fastFlowTermsAcknowledged()) {
      this.operations.fail('Review and accept the FastFlowLM terms first.');
      return false;
    }
    return true;
  }

  private async acceptedFastFlowRequest(
    terms: FastFlowTermsConsent | null,
    context: RuntimeActionContext,
  ): Promise<RuntimeInstallationStartRequest | undefined> {
    if (terms === null) {
      return undefined;
    }

    const client = this.runtimeApi.providerSelectionClient();
    const selection = await client.decideFastflowlmTerms({
      decision: 'accepted',
      terms_version: terms.version,
    });
    context.applyProviderSelection(selection);
    return { fastflowlm_terms_accepted_version: terms.version };
  }

  private isFastFlowKind(
    kind: RuntimeKind | null | undefined,
  ): boolean {
    return kind === 'fastflowlm' || kind === 'fastflowlm_model';
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
