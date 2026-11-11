import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { defer, type Subscription } from 'rxjs';
import type {
  DevicePreferenceRead,
  DevicePreferenceUpdate,
} from '@cert-prep/api';
import { requestErrorMessage } from '../../core/domain';
import { DEVICE_COPY } from '../domain';
import { HealthStore } from './health.store';
import { RuntimeApiClientsService } from './runtime-api-clients.service';

function isUnknownDeviceError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const status = (error as { status?: unknown }).status;
  const errBody = (error as { error?: unknown }).error;
  if (status === 422 && typeof errBody === 'object' && errBody !== null) {
    return (errBody as { code?: unknown }).code === 'unknown_device';
  }
  return false;
}

@Injectable({ providedIn: 'root' })
export class DevicePreferenceStore {
  private readonly runtimeApi = inject(RuntimeApiClientsService);
  private readonly health = inject(HealthStore);

  readonly preference = signal<DevicePreferenceRead | null>(null);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  private openCount = 0;
  private readGeneration = 0;
  private saveGeneration = 0;
  private healthSubscription?: Subscription;
  private pollTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.close());
  }

  open(): void {
    this.openCount += 1;
    if (this.openCount > 1) return;
    this.healthSubscription = this.health.healthRefreshFinished$.subscribe(
      () => {
        if (!this.saving()) this.load();
      },
    );
    if (!this.health.healthSnapshotLoading()) this.load();
  }

  close(): void {
    if (this.openCount <= 0) return;
    this.openCount -= 1;
    if (this.openCount > 0) return;
    this.readGeneration += 1;
    this.healthSubscription?.unsubscribe();
    this.healthSubscription = undefined;
    this.stopPolling();
  }

  load(): void {
    if (this.openCount <= 0 || this.saving() || this.health.healthSnapshotLoading())
      return;
    const generation = ++this.readGeneration;
    this.stopPolling();
    defer(() => this.runtimeApi.devicePreference()).subscribe({
      next: (pref) => {
        if (generation !== this.readGeneration) return;
        this.preference.set(pref);
        this.schedulePoll();
      },
      error: () => {
        if (generation === this.readGeneration) this.schedulePoll();
      },
    });
  }

  choose(body: DevicePreferenceUpdate): void {
    if (this.saving()) return;
    this.readGeneration += 1;
    const generation = ++this.saveGeneration;
    this.stopPolling();
    this.saving.set(true);
    this.error.set(null);

    defer(() => this.runtimeApi.chooseDevicePreference(body)).subscribe({
      next: (updated) => {
        if (generation !== this.saveGeneration) return;
        this.preference.set(updated);
        this.saving.set(false);
        if (this.openCount > 0) this.health.refresh();
      },
      error: (err: unknown) => {
        if (generation !== this.saveGeneration) return;
        this.saving.set(false);
        if (isUnknownDeviceError(err)) {
          this.error.set(DEVICE_COPY.errors.unknownDevice);
          this.load();
        } else {
          const reason = requestErrorMessage(
            err,
            DEVICE_COPY.errors.defaultSaveError,
          );
          this.error.set(DEVICE_COPY.errors.saveFailed(reason));
          this.schedulePoll();
        }
      },
    });
  }

  private stopPolling(): void {
    clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  private schedulePoll(): void {
    this.stopPolling();
    if (
      this.openCount <= 0 ||
      this.saving() ||
      this.preference()?.status !== 'pending'
    )
      return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      if (!this.health.healthSnapshotLoading()) this.health.refresh();
      // An in-flight health refresh will trigger the preference read on completion.
    }, 5000);
  }
}
