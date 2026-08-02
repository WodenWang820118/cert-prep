import { computed, inject, Injectable, signal } from '@angular/core';
import { catchError, from, map, Observable, of, Subscription, tap, timer } from 'rxjs';
import type {
  DesktopRuntimeInstallation,
  DesktopRuntimeStatus,
} from './contracts/desktop-runtime.contracts';
import { DesktopRuntimeBridgeService } from './desktop-runtime-bridge.service';
import { DesktopRuntimeViewService } from './desktop-runtime-view.service';
import { OperationStore } from '../operation.store';
import { RUNTIME_INSTALL_POLL_INTERVAL_MS } from './constants/desktop-runtime.constants';
import { CertPrepRuntimeConfig } from '../../services/cert-prep-api.service';

@Injectable({ providedIn: 'root' })
export class DesktopRuntimeStore {
  private readonly bridge = inject(DesktopRuntimeBridgeService);
  private readonly operations = inject(OperationStore);
  private readonly view = inject(DesktopRuntimeViewService);
  private readonly runtimeConfig = inject(CertPrepRuntimeConfig);
  private installPollSubscription: Subscription | null = null;
  private captureRuntimePollSubscription: Subscription | null = null;
  private captureRuntimeAction: 'install' | 'start' | null = null;
  private readonly desktop = this.bridge.isDesktop();

  readonly isDesktop = signal(this.desktop);
  readonly status = signal<DesktopRuntimeStatus>(this.view.browserStatus());
  readonly installation = signal<DesktopRuntimeInstallation | null>(null);
  readonly installStarting = signal(false);
  readonly installConsentVisible = signal(false);
  readonly captureRuntimeStatus = signal<DesktopRuntimeStatus>(
    this.desktop
      ? this.view.pendingCaptureRuntimeStatus()
      : this.view.browserCaptureRuntimeStatus(),
  );
  /**
   * Desktop Capture Runtime is fail-closed until the native status command
   * resolves. Browser development mode has no native command to await.
   */
  readonly captureRuntimeStatusLoaded = signal(!this.desktop);
  readonly captureRuntimeInstallation = signal<DesktopRuntimeInstallation | null>(
    null,
  );
  readonly captureRuntimeInstallStarting = signal(false);
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
  readonly isCaptureRuntimeReady = computed(
    () =>
      !this.isDesktop() ||
      (this.captureRuntimeStatusLoaded() && this.captureRuntimeStatus().running),
  );
  readonly isCaptureRuntimeInstallActive = computed(() => {
    const phase = this.view.phase(
      this.captureRuntimeInstallation()?.status ?? '',
    );
    return (
      this.captureRuntimeInstallStarting() ||
      phase === 'queued' ||
      phase === 'running'
    );
  });
  readonly canInstallCaptureRuntime = computed(
    () =>
      this.isDesktop() &&
      this.captureRuntimeStatusLoaded() &&
      !this.captureRuntimeStatus().available &&
      this.captureRuntimeStatus().unavailableReason !==
        'requires_host_configuration' &&
      !this.isCaptureRuntimeInstallActive(),
  );
  readonly canStartCaptureRuntime = computed(
    () =>
      this.isDesktop() &&
      this.captureRuntimeStatusLoaded() &&
      this.captureRuntimeStatus().available &&
      !this.captureRuntimeStatus().running &&
      !this.isCaptureRuntimeInstallActive(),
  );
  readonly installProgress = computed(() =>
    this.view.progressFrom(this.installation() ?? this.status()),
  );

  load(): Observable<DesktopRuntimeStatus | null> {
    if (!this.isDesktop()) {
      this.status.set(this.view.browserStatus());
      return of(this.status());
    }

    return from(this.bridge.invoke<DesktopRuntimeStatus>('desktop_runtime_status')).pipe(
      tap((status) => this.status.set(status)),
      map((status) => status),
      catchError((error: unknown) => {
        this.operations.fail(this.view.errorMessage(error));
        return of(null);
      }),
    );
  }

  loadCaptureRuntime(): Observable<DesktopRuntimeStatus | null> {
    if (!this.isDesktop()) {
      this.captureRuntimeStatus.set(this.view.browserCaptureRuntimeStatus());
      this.captureRuntimeStatusLoaded.set(true);
      return of(this.captureRuntimeStatus());
    }

    return from(
      this.bridge.invoke<DesktopRuntimeStatus>('capture_runtime_status'),
    ).pipe(
      tap((status) => {
        this.captureRuntimeStatus.set(status);
        this.captureRuntimeStatusLoaded.set(true);
      }),
      catchError((error: unknown) => {
        this.operations.fail(this.view.errorMessage(error));
        return of(null);
      }),
    );
  }

  installCaptureRuntime(): void {
    this.startCaptureRuntimeJob(
      'install_capture_runtime',
      'Installing Capture Runtime.',
      'install',
    );
  }

  startCaptureRuntime(): void {
    this.startCaptureRuntimeJob(
      'start_capture_runtime',
      'Starting Capture Runtime.',
      'start',
    );
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

  confirmPythonRuntimeInstallation(): void {
    if (!this.canInstallPythonRuntime() || this.installStarting()) {
      return;
    }

    this.clearInstallPollTimer();
    this.installStarting.set(true);
    this.installation.set({
      id: '',
      kind: 'python_backend',
      provider: 'pyinstaller',
      model: 'cert-prep-backend',
      status: 'running',
      detail: 'Starting Python backend runtime installation.',
      completed: null,
      total: null,
      createdAt: '',
      updatedAt: '',
      error: null,
    });

    from(this.bridge
      .invoke<DesktopRuntimeInstallation>('start_python_runtime_installation'))
      .pipe(
        tap((response) => {
          this.installation.set(response);
          this.installConsentVisible.set(false);
          this.continueInstallation(response);
          this.installStarting.set(false);
        }),
        catchError((error: unknown) => {
          const message = this.view.errorMessage(error);
          this.installation.set(
            this.view.failedInstallation(message, this.installation()),
          );
          this.operations.fail(message);
          this.installStarting.set(false);
          return of(null);
        }),
      )
      .subscribe();
  }

  refreshInstallation(): void {
    const current = this.installation();
    if (current === null || current.id.length === 0) {
      this.load().subscribe();
      return;
    }

    this.clearInstallPollTimer();
    from(this.bridge
      .invoke<DesktopRuntimeInstallation>('get_python_runtime_installation', {
        jobId: current.id,
      }))
      .pipe(
        tap((response) => {
          this.installation.set(response);
          this.continueInstallation(response);
        }),
        catchError((error: unknown) => {
          const message = this.view.errorMessage(error);
          this.installation.set(this.view.failedInstallation(message, current));
          this.operations.fail(message);
          return of(null);
        }),
      )
      .subscribe();
  }

  private continueInstallation(installation: DesktopRuntimeInstallation): void {
    const phase = this.view.phase(installation.status);
    if (phase === 'succeeded') {
      this.load().subscribe();
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
    this.installPollSubscription = timer(RUNTIME_INSTALL_POLL_INTERVAL_MS)
      .pipe(tap(() => (this.installPollSubscription = null)))
      .subscribe(() => this.refreshInstallation());
  }

  private startCaptureRuntimeJob(
    command: string,
    detail: string,
    action: 'install' | 'start',
  ): void {
    const permitted =
      action === 'install'
        ? this.canInstallCaptureRuntime()
        : this.canStartCaptureRuntime();
    if (this.captureRuntimeInstallStarting() || !permitted) {
      return;
    }
    this.clearCaptureRuntimePollTimer();
    this.captureRuntimeAction = action;
    this.captureRuntimeInstallStarting.set(true);
    this.captureRuntimeInstallation.set({
      id: '',
      kind: 'capture_runtime',
      provider: 'bundled-release',
      model: 'capture-runtime@0.3.8',
      status: 'running',
      detail,
      completed: null,
      total: null,
      createdAt: '',
      updatedAt: '',
      error: null,
    });
    from(this.bridge.invoke<DesktopRuntimeInstallation>(command))
      .pipe(
        tap((response) => {
          this.captureRuntimeInstallation.set(response);
          this.captureRuntimeInstallStarting.set(false);
          this.continueCaptureRuntimeInstallation(response);
        }),
        catchError((error: unknown) => {
          const message = this.view.errorMessage(error);
          this.captureRuntimeAction = null;
          this.captureRuntimeInstallation.set(
            this.view.failedCaptureRuntimeInstallation(
              message,
              this.captureRuntimeInstallation(),
            ),
          );
          this.captureRuntimeInstallStarting.set(false);
          this.operations.fail(message);
          return of(null);
        }),
      )
      .subscribe();
  }

  private continueCaptureRuntimeInstallation(
    installation: DesktopRuntimeInstallation,
  ): void {
    const phase = this.view.phase(installation.status);
    if (phase === 'succeeded') {
      const action = this.captureRuntimeAction;
      this.captureRuntimeAction = null;
      if (action === 'start') {
        this.runtimeConfig.invalidateBackendConfig();
        this.load().subscribe();
      }
      this.loadCaptureRuntime().subscribe();
      return;
    }
    if (phase === 'failed') {
      this.captureRuntimeAction = null;
      this.operations.fail(installation.error ?? installation.detail);
      this.loadCaptureRuntime().subscribe();
      return;
    }
    this.scheduleCaptureRuntimePoll();
  }

  private refreshCaptureRuntimeInstallation(): void {
    const current = this.captureRuntimeInstallation();
    if (current === null || current.id.length === 0) {
      this.loadCaptureRuntime().subscribe();
      return;
    }
    this.clearCaptureRuntimePollTimer();
    from(
      this.bridge.invoke<DesktopRuntimeInstallation>(
        'get_capture_runtime_installation',
        { jobId: current.id },
      ),
    )
      .pipe(
        tap((response) => {
          this.captureRuntimeInstallation.set(response);
          this.continueCaptureRuntimeInstallation(response);
        }),
        catchError((error: unknown) => {
          const message = this.view.errorMessage(error);
          this.captureRuntimeInstallation.set(
            this.view.failedCaptureRuntimeInstallation(message, current),
          );
          this.operations.fail(message);
          return of(null);
        }),
      )
      .subscribe();
  }

  private scheduleCaptureRuntimePoll(): void {
    this.clearCaptureRuntimePollTimer();
    this.captureRuntimePollSubscription = timer(RUNTIME_INSTALL_POLL_INTERVAL_MS)
      .pipe(tap(() => (this.captureRuntimePollSubscription = null)))
      .subscribe(() => this.refreshCaptureRuntimeInstallation());
  }

  private clearCaptureRuntimePollTimer(): void {
    if (this.captureRuntimePollSubscription !== null) {
      this.captureRuntimePollSubscription.unsubscribe();
      this.captureRuntimePollSubscription = null;
    }
  }

  private clearInstallPollTimer(): void {
    if (this.installPollSubscription !== null) {
      this.installPollSubscription.unsubscribe();
      this.installPollSubscription = null;
    }
  }
}
