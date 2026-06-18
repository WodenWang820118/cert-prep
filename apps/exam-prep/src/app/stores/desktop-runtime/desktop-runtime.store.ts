import { computed, inject, Injectable, signal } from '@angular/core';
import type {
  DesktopRuntimeInstallation,
  DesktopRuntimeStatus,
} from './contracts/desktop-runtime.contracts';
import { DesktopRuntimeBridgeService } from './desktop-runtime-bridge.service';
import { DesktopRuntimeViewService } from './desktop-runtime-view.service';
import { OperationStore } from '../operation.store';

const RUNTIME_INSTALL_POLL_INTERVAL_MS = 1500;

@Injectable({ providedIn: 'root' })
export class DesktopRuntimeStore {
  private readonly bridge = inject(DesktopRuntimeBridgeService);
  private readonly operations = inject(OperationStore);
  private readonly view = inject(DesktopRuntimeViewService);
  private installPollTimer: ReturnType<typeof setTimeout> | null = null;

  readonly isDesktop = signal(this.bridge.isDesktop());
  readonly status = signal<DesktopRuntimeStatus>(this.view.browserStatus());
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
    this.view.progressFrom(this.installation() ?? this.status()),
  );

  async load(): Promise<void> {
    if (!this.isDesktop()) {
      this.status.set(this.view.browserStatus());
      return;
    }

    const status = await this.bridge.invoke<DesktopRuntimeStatus>(
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
      const response = await this.bridge.invoke<DesktopRuntimeInstallation>(
        'start_python_runtime_installation',
      );
      this.installation.set(response);
      this.installConsentVisible.set(false);
      this.continueInstallation(response);
    } catch (error) {
      const message = this.view.errorMessage(error);
      this.installation.set(
        this.view.failedInstallation(message, this.installation()),
      );
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
      const response = await this.bridge.invoke<DesktopRuntimeInstallation>(
        'get_python_runtime_installation',
        { jobId: current.id },
      );
      this.installation.set(response);
      this.continueInstallation(response);
    } catch (error) {
      const message = this.view.errorMessage(error);
      this.installation.set(this.view.failedInstallation(message, current));
      this.operations.fail(message);
    }
  }

  private continueInstallation(installation: DesktopRuntimeInstallation): void {
    const phase = this.view.phase(installation.status);
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
}
