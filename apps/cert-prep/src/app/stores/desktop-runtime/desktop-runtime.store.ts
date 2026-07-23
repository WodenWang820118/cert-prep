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

@Injectable({ providedIn: 'root' })
export class DesktopRuntimeStore {
  private readonly bridge = inject(DesktopRuntimeBridgeService);
  private readonly operations = inject(OperationStore);
  private readonly view = inject(DesktopRuntimeViewService);
  private installPollSubscription: Subscription | null = null;

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

  private clearInstallPollTimer(): void {
    if (this.installPollSubscription !== null) {
      this.installPollSubscription.unsubscribe();
      this.installPollSubscription = null;
    }
  }
}
