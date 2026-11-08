import { Injectable } from '@angular/core';
import type {
  DesktopRuntimeInstallation,
  DesktopRuntimeStatus,
  RuntimePhase,
  RuntimeUpdateNotice,
} from '../domain';
import { RUNTIME_UPDATE_COPY } from '../domain';

/**
 * Maps raw runtime command data into stable UI/runtime state primitives.
 */
@Injectable({ providedIn: 'root' })
export class DesktopRuntimeViewService {
  browserStatus(): DesktopRuntimeStatus {
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

  browserCaptureRuntimeStatus(): DesktopRuntimeStatus {
    return {
      kind: 'capture_runtime',
      label: 'Capture Runtime',
      available: true,
      running: true,
      status: 'running',
      detail: 'Using the configured local development Capture Runtime.',
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

  pendingCaptureRuntimeStatus(): DesktopRuntimeStatus {
    return {
      kind: 'capture_runtime',
      label: 'Capture Runtime',
      available: false,
      running: false,
      status: 'checking',
      detail: 'Checking Capture Runtime availability.',
      unavailableReason: 'capture_runtime_checking',
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

  failedInstallation(
    message: string,
    current: DesktopRuntimeInstallation | null,
  ): DesktopRuntimeInstallation {
    return {
      id: current?.id ?? '',
      kind: 'python_backend',
      provider: 'pyinstaller',
      model: 'cert-prep-backend',
      status: 'failed',
      detail: message,
      completed: current?.completed ?? null,
      total: current?.total ?? null,
      createdAt: current?.createdAt ?? '',
      updatedAt: current?.updatedAt ?? '',
      error: message,
    };
  }

  failedCaptureRuntimeInstallation(
    message: string,
    current: DesktopRuntimeInstallation | null,
  ): DesktopRuntimeInstallation {
    return {
      id: current?.id ?? '',
      kind: 'capture_runtime',
      provider: 'bundled-release',
      model: current?.model ?? 'capture-runtime',
      status: 'failed',
      detail: message,
      completed: current?.completed ?? null,
      total: current?.total ?? null,
      createdAt: current?.createdAt ?? '',
      updatedAt: current?.updatedAt ?? '',
      error: message,
    };
  }

  captureRuntimeModel(status: DesktopRuntimeStatus | null): string {
    const version = status?.version?.trim();
    return version === undefined || version.length === 0
      ? 'capture-runtime'
      : `capture-runtime@${version}`;
  }

  progressFrom(
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

  phase(status: string): RuntimePhase {
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
    if (normalized === 'running' || normalized === 'starting') {
      return 'running';
    }
    if (normalized === 'installed') {
      return 'installed';
    }
    return 'missing';
  }

  /**
   * Accepts only a well-formed, non-idle `runtime_update_status` snapshot;
   * anything else means there is no update notice to show.
   */
  runtimeUpdateNotice(value: unknown): RuntimeUpdateNotice | null {
    if (typeof value !== 'object' || value === null) {
      return null;
    }
    const raw = value as Record<string, unknown>;
    const phase = raw['phase'];
    if (phase !== 'applying' && phase !== 'succeeded' && phase !== 'failed') {
      return null;
    }
    const count = (field: unknown): number =>
      typeof field === 'number' && Number.isFinite(field) && field >= 0
        ? field
        : 0;
    const runtimes = raw['runtimes'];
    const estimated = raw['estimatedSeconds'];
    const error = raw['error'];
    return {
      phase,
      runtimes: Array.isArray(runtimes)
        ? runtimes.filter(
            (runtime): runtime is string => typeof runtime === 'string',
          )
        : [],
      completed: count(raw['completed']),
      total: count(raw['total']),
      estimatedSeconds:
        typeof estimated === 'number' && estimated > 0 ? estimated : null,
      error: typeof error === 'string' && error.length > 0 ? error : null,
    };
  }

  /** zh-TW wording of the update notice shown in the shell. */
  runtimeUpdateMessage(notice: RuntimeUpdateNotice): string {
    if (notice.phase === 'succeeded') {
      return RUNTIME_UPDATE_COPY.succeeded;
    }
    if (notice.phase === 'failed') {
      return RUNTIME_UPDATE_COPY.failed(
        notice.error ?? RUNTIME_UPDATE_COPY.unknownError,
      );
    }
    const names = notice.runtimes.map(
      (runtime) =>
        RUNTIME_UPDATE_COPY.runtimeNames[runtime] ??
        RUNTIME_UPDATE_COPY.fallbackRuntimeName,
    );
    const subject =
      names.length > 0
        ? [...new Set(names)].join('與')
        : RUNTIME_UPDATE_COPY.fallbackRuntimeName;
    return RUNTIME_UPDATE_COPY.applying(subject, notice.estimatedSeconds);
  }

  errorMessage(error: unknown): string {
    if (typeof error === 'string' && error.length > 0) {
      return error;
    }
    const maybe = error as { message?: unknown };
    return typeof maybe.message === 'string' && maybe.message.length > 0
      ? maybe.message
      : 'Runtime operation did not complete.';
  }
}
