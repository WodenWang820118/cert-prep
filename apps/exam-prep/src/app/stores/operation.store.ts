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
  readonly busy = signal<BusyAction | null>(null);
  readonly status = signal('Ready');
  readonly error = signal<string | null>(null);
  readonly errorCode = signal<string | null>(null);

  async run<T>(
    action: BusyAction,
    successMessage: string,
    task: () => Promise<T>,
  ): Promise<T | null> {
    this.busy.set(action);
    this.error.set(null);
    this.errorCode.set(null);
    try {
      const result = await task();
      this.status.set(successMessage);
      return result;
    } catch (error) {
      this.error.set(this.getErrorMessage(error));
      this.errorCode.set(this.getErrorCode(error));
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

  isBusyFor(action: string | readonly string[]): boolean {
    const current = this.busy();
    if (current === null) {
      return false;
    }
    return Array.isArray(action) ? action.includes(current) : current === action;
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
