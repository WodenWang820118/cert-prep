import { Injectable, signal } from '@angular/core';

type BusyAction =
  | 'startup'
  | 'health'
  | 'project'
  | 'upload'
  | 'questions'
  | 'saveDraft'
  | 'session'
  | 'attempt'
  | 'review'
  | 'runtime';

@Injectable({ providedIn: 'root' })
export class OperationStore {
  private readonly runEpochs = new Map<BusyAction, number>();
  private readonly activeActionCounts = signal<
    ReadonlyMap<BusyAction, number>
  >(new Map());
  readonly busy = signal<BusyAction | null>(null);
  readonly status = signal('Ready');
  readonly error = signal<string | null>(null);
  readonly errorCode = signal<string | null>(null);

  async run<T>(
    action: BusyAction,
    successMessage: string,
    task: () => Promise<T>,
    shouldApply: () => boolean = () => true,
  ): Promise<T | null> {
    const epoch = (this.runEpochs.get(action) ?? 0) + 1;
    this.runEpochs.set(action, epoch);
    const isCurrent = () =>
      epoch === this.runEpochs.get(action) && shouldApply();
    this.beginAction(action);
    this.error.set(null);
    this.errorCode.set(null);
    try {
      const result = await task();
      if (isCurrent()) {
        this.status.set(successMessage);
      }
      return result;
    } catch (error) {
      if (isCurrent()) {
        this.error.set(this.getErrorMessage(error));
        this.errorCode.set(this.getErrorCode(error));
      }
      return null;
    } finally {
      this.endAction(action);
    }
  }

  fail(message: string): void {
    this.error.set(message);
  }

  isBusyFor(action: string | readonly string[]): boolean {
    const current = this.busy();
    const requested = Array.isArray(action) ? action : [action];
    return requested.some(
      (candidate) =>
        candidate === current ||
        (this.activeActionCounts().get(candidate as BusyAction) ?? 0) > 0,
    );
  }

  private beginAction(action: BusyAction): void {
    const counts = new Map(this.activeActionCounts());
    counts.set(action, (counts.get(action) ?? 0) + 1);
    this.activeActionCounts.set(counts);
    this.busy.set(action);
  }

  private endAction(action: BusyAction): void {
    const counts = new Map(this.activeActionCounts());
    const remainingForAction = Math.max(0, (counts.get(action) ?? 1) - 1);
    if (remainingForAction === 0) {
      counts.delete(action);
    } else {
      counts.set(action, remainingForAction);
    }
    this.activeActionCounts.set(counts);

    if (this.busy() === action) {
      const remaining = [...counts.keys()];
      this.busy.set(remaining[remaining.length - 1] ?? null);
    }
  }

  private getErrorMessage(error: unknown): string {
    const httpError = error as { error?: unknown; message?: unknown };
    if (this.hasMessage(httpError.error)) {
      return httpError.error.message;
    }

    if (typeof httpError.error === 'string' && httpError.error.length > 0) {
      return httpError.error;
    }

    if (typeof httpError.message === 'string' && httpError.message.length > 0) {
      return httpError.message;
    }

    return 'The local cert prep service did not complete the request.';
  }

  private hasMessage(value: unknown): value is { message: string } {
    return (
      typeof value === 'object' &&
      value !== null &&
      'message' in value &&
      typeof (value as { message?: unknown }).message === 'string'
    );
  }

  private getErrorCode(error: unknown): string | null {
    const httpError = error as { error?: unknown };
    if (
      typeof httpError.error === 'object' &&
      httpError.error !== null &&
      'code' in httpError.error &&
      typeof (httpError.error as { code?: unknown }).code === 'string'
    ) {
      return (httpError.error as { code: string }).code;
    }

    return null;
  }
}
