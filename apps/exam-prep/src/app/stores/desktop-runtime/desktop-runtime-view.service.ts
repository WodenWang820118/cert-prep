import { Injectable } from '@angular/core';
import type {
  DesktopRuntimeInstallation,
  DesktopRuntimeStatus,
  RuntimePhase,
} from './contracts/desktop-runtime.contracts';

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

  failedInstallation(
    message: string,
    current: DesktopRuntimeInstallation | null,
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
    if (normalized === 'running') {
      return 'running';
    }
    if (normalized === 'installed') {
      return 'installed';
    }
    return 'missing';
  }

  errorMessage(error: unknown): string {
    if (typeof error === 'string' && error.length > 0) {
      return error;
    }
    const maybe = error as { message?: unknown };
    return typeof maybe.message === 'string' && maybe.message.length > 0
      ? maybe.message
      : 'Python backend runtime installation did not complete.';
  }
}
