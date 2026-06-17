import { computed, inject, Injectable, signal } from '@angular/core';
import { OperationStore } from './operation.store';

const RUNTIME_INSTALL_POLL_INTERVAL_MS = 1500;

type RuntimePhase =
  | 'missing'
  | 'installed'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed';

export interface DesktopRuntimeStatus {
  readonly kind: string;
  readonly label: string;
  readonly available: boolean;
  readonly running: boolean;
  readonly status: string;
  readonly detail: string;
  readonly unavailableReason?: string | null;
  readonly version?: string | null;
  readonly installedPath?: string | null;
  readonly baseUrl?: string | null;
  readonly token?: string | null;
  readonly jobId?: string | null;
  readonly completed?: number | null;
  readonly total?: number | null;
  readonly error?: string | null;
}

export interface DesktopRuntimeInstallation {
  readonly id: string;
  readonly kind: string;
  readonly provider: string;
  readonly model: string;
  readonly status: string;
  readonly detail: string;
  readonly completed?: number | null;
  readonly total?: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error?: string | null;
}

@Injectable({ providedIn: 'root' })
export class DesktopRuntimeStore {
  private readonly operations = inject(OperationStore);
  private installPollTimer: ReturnType<typeof setTimeout> | null = null;

  readonly isDesktop = signal(this.hasTauriRuntime());
  readonly status = signal<DesktopRuntimeStatus>(this.browserStatus());
  readonly installation = signal<DesktopRuntimeInstallation | null>(null);
  readonly installStarting = signal(false);
  readonly installConsentVisible = signal(false);
  readonly isBackendReady = computed(
    () => !this.isDesktop() || this.status().running,
  );
  readonly isPythonRuntimeMissing = computed(
    () =>
      this.isDesktop() &&
      !this.status().running &&
      (this.status().unavailableReason === 'python_runtime_missing' ||
        this.status().status === 'missing'),
  );
  readonly isInstallActive = computed(() => {
    const status = this.installation()?.status;
    return (
      this.installStarting() || status === 'queued' || status === 'running'
    );
  });
  readonly canInstallPythonRuntime = computed(
    () => this.isDesktop() && !this.isBackendReady() && !this.isInstallActive(),
  );
  readonly installProgress = computed(() =>
    this.progressFrom(this.installation() ?? this.status()),
  );

  async load(): Promise<void> {
    if (!this.isDesktop()) {
      this.status.set(this.browserStatus());
      return;
    }

    const status = await this.invoke<DesktopRuntimeStatus>(
      'desktop_runtime_status',
    );
    this.status.set(status);
  }

  openInstallConsent(): void {
    if (this.canInstallPythonRuntime()) {
      this.installConsentVisible.set(true);
    }
  }

  setInstallConsentVisible(visible: boolean): void {
    if (visible) {
      this.openInstallConsent();
      return;
    }
    this.cancelInstallConsent();
  }

  cancelInstallConsent(): void {
    if (!this.installStarting()) {
      this.installConsentVisible.set(false);
    }
  }

  async confirmPythonRuntimeInstallation(): Promise<void> {
    if (!this.canInstallPythonRuntime() || this.installStarting()) {
      return;
    }

    this.clearInstallPollTimer();
    this.installStarting.set(true);
    this.installation.set({
      id: '',
      kind: 'python_backend',
      provider: 'pyinstaller',
      model: 'exam-prep-backend',
      status: 'running',
      detail: 'Starting Python backend runtime installation.',
      completed: null,
      total: null,
      createdAt: '',
      updatedAt: '',
      error: null,
    });

    try {
      const response = await this.invoke<DesktopRuntimeInstallation>(
        'start_python_runtime_installation',
      );
      this.installation.set(response);
      this.installConsentVisible.set(false);
      this.continueInstallation(response);
    } catch (error) {
      const message = this.errorMessage(error);
      this.installation.set(this.failedInstallation(message));
      this.operations.fail(message);
    } finally {
      this.installStarting.set(false);
    }
  }

  async refreshInstallation(): Promise<void> {
    const current = this.installation();
    if (current === null || current.id.length === 0) {
      await this.load();
      return;
    }

    this.clearInstallPollTimer();
    try {
      const response = await this.invoke<DesktopRuntimeInstallation>(
        'get_python_runtime_installation',
        { jobId: current.id },
      );
      this.installation.set(response);
      this.continueInstallation(response);
    } catch (error) {
      const message = this.errorMessage(error);
      this.installation.set(this.failedInstallation(message, current));
      this.operations.fail(message);
    }
  }

  private continueInstallation(installation: DesktopRuntimeInstallation): void {
    const phase = this.phase(installation.status);
    if (phase === 'succeeded') {
      void this.load();
      return;
    }

    if (phase === 'failed') {
      this.operations.fail(installation.error ?? installation.detail);
      return;
    }

    this.scheduleInstallPoll();
  }

  private scheduleInstallPoll(): void {
    this.clearInstallPollTimer();
    this.installPollTimer = setTimeout(() => {
      this.installPollTimer = null;
      void this.refreshInstallation();
    }, RUNTIME_INSTALL_POLL_INTERVAL_MS);
  }

  private clearInstallPollTimer(): void {
    if (this.installPollTimer !== null) {
      clearTimeout(this.installPollTimer);
      this.installPollTimer = null;
    }
  }

  private failedInstallation(
    message: string,
    current: DesktopRuntimeInstallation | null = this.installation(),
  ): DesktopRuntimeInstallation {
    return {
      id: current?.id ?? '',
      kind: 'python_backend',
      provider: 'pyinstaller',
      model: 'exam-prep-backend',
      status: 'failed',
      detail: message,
      completed: current?.completed ?? null,
      total: current?.total ?? null,
      createdAt: current?.createdAt ?? '',
      updatedAt: current?.updatedAt ?? '',
      error: message,
    };
  }

  private progressFrom(
    value: DesktopRuntimeInstallation | DesktopRuntimeStatus | null,
  ): number | null {
    if (
      value === null ||
      value.completed === null ||
      value.completed === undefined
    ) {
      return null;
    }
    if (value.total === null || value.total === undefined || value.total <= 0) {
      return null;
    }
    return Math.max(
      0,
      Math.min(100, Math.round((value.completed / value.total) * 100)),
    );
  }

  private phase(status: string): RuntimePhase {
    const normalized = status
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');
    if (
      normalized === 'succeeded' ||
      normalized === 'success' ||
      normalized === 'completed'
    ) {
      return 'succeeded';
    }
    if (normalized === 'failed' || normalized === 'error') {
      return 'failed';
    }
    if (normalized === 'queued') {
      return 'queued';
    }
    if (normalized === 'running') {
      return 'running';
    }
    if (normalized === 'installed') {
      return 'installed';
    }
    return 'missing';
  }

  private async invoke<TResult>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<TResult> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<TResult>(command, args);
  }

  private hasTauriRuntime(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  }

  private browserStatus(): DesktopRuntimeStatus {
    return {
      kind: 'developer_backend',
      label: 'Developer backend',
      available: true,
      running: true,
      status: 'running',
      detail: 'Using the configured local development backend.',
      unavailableReason: null,
      version: null,
      installedPath: null,
      baseUrl: null,
      token: null,
      jobId: null,
      completed: null,
      total: null,
      error: null,
    };
  }

  private errorMessage(error: unknown): string {
    if (typeof error === 'string' && error.length > 0) {
      return error;
    }
    const maybe = error as { message?: unknown };
    return typeof maybe.message === 'string' && maybe.message.length > 0
      ? maybe.message
      : 'Python backend runtime installation did not complete.';
  }
}
