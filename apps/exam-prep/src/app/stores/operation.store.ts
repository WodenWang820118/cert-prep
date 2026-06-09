import { Injectable, computed, signal } from '@angular/core';

type BusyAction =
  | 'startup'
  | 'health'
  | 'project'
  | 'upload'
  | 'drafts'
  | 'approve'
  | 'session'
  | 'attempt'
  | 'review';

@Injectable({ providedIn: 'root' })
export class OperationStore {
  readonly busy = signal<BusyAction | null>(null);
  readonly status = signal('Ready');
  readonly error = signal<string | null>(null);
  readonly isBusy = computed(() => this.busy() !== null);

  async run<T>(
    action: BusyAction,
    successMessage: string,
    task: () => Promise<T>,
  ): Promise<T | null> {
    this.busy.set(action);
    this.error.set(null);
    try {
      const result = await task();
      this.status.set(successMessage);
      return result;
    } catch (error) {
      this.error.set(this.getErrorMessage(error));
      return null;
    } finally {
      if (this.busy() === action) {
        this.busy.set(null);
      }
    }
  }

  fail(message: string): void {
    this.error.set(message);
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

    return 'The local exam prep service did not complete the request.';
  }

  private hasMessage(value: unknown): value is { message: string } {
    return (
      typeof value === 'object' &&
      value !== null &&
      'message' in value &&
      typeof (value as { message?: unknown }).message === 'string'
    );
  }
}
