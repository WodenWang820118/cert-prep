import {
  effect,
  inject,
  Injectable,
  Injector,
  runInInjectionContext,
  signal,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import {
  catchError,
  defer,
  map,
  Observable,
  of,
  ReplaySubject,
  share,
  Subscription,
} from 'rxjs';
import type { BusyAction, CommandResult } from './operation/contracts/operation.contracts';

@Injectable({ providedIn: 'root' })
export class OperationStore {
  private readonly injector = inject(Injector);
  private readonly runEpochs = new Map<BusyAction, number>();
  private readonly activeActionCounts = signal<
    ReadonlyMap<BusyAction, number>
  >(new Map());
  readonly busy = signal<BusyAction | null>(null);
  readonly status = signal('Ready');
  readonly error = signal<string | null>(null);
  readonly errorCode = signal<string | null>(null);

  run<T>(
    action: BusyAction,
    successMessage: string | ((result: T) => string),
    task: (signal: AbortSignal) => Observable<T>,
    shouldApply: () => boolean = () => true,
  ): Observable<T | null> {
    return new Observable<T | null>((subscriber) => {
      const epoch = (this.runEpochs.get(action) ?? 0) + 1;
      this.runEpochs.set(action, epoch);
      const isCurrent = () =>
        epoch === this.runEpochs.get(action) && shouldApply();
      this.beginAction(action);
      this.error.set(null);
      this.errorCode.set(null);

      let closed = false;
      let cleaned = false;
      let taskSubscription: Subscription | undefined;
      let taskController: AbortController | undefined;
      const release = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        this.endAction(action);
      };
      const cleanup = (): void => {
        if (cleaned) {
          return;
        }
        cleaned = true;
        if (taskController !== undefined && !taskController.signal.aborted) {
          taskController.abort(new DOMException('The command was canceled.', 'AbortError'));
        }
        taskSubscription?.unsubscribe();
        resourceEffect.destroy();
        resource.destroy();
      };
      const finish = (): void => {
        release();
        cleanup();
      };

      const resource = runInInjectionContext(this.injector, () => {
        const started = signal(false);
        const controller = new AbortController();
        taskController = controller;
        const task$ = defer(() => task(controller.signal)).pipe(
          share({
            connector: () => new ReplaySubject<T>(1),
            resetOnError: false,
            resetOnComplete: false,
            resetOnRefCountZero: false,
          }),
        );
        const command = rxResource<CommandResult<T> | null, boolean | undefined>({
          params: () => (started() ? true : undefined),
          defaultValue: null,
          stream: ({ abortSignal }) => {
            abortSignal.addEventListener(
              'abort',
              () => {
                if (!controller.signal.aborted) {
                  controller.abort(abortSignal.reason);
                }
              },
              { once: true },
            );
            return task$.pipe(
              map((value) => ({ kind: 'success', value }) as const),
              catchError((error: unknown) =>
                of({ kind: 'error', error } as const),
              ),
            );
          },
        });
        taskSubscription = task$.subscribe({
          next: (value) => command?.set({ kind: 'success', value }),
          error: (error: unknown) => command?.set({ kind: 'error', error }),
        });
        started.set(true);
        return command;
      });

      const resourceEffect = runInInjectionContext(this.injector, () =>
        effect(() => {
          if (closed) {
            return;
          }
          const status = resource.status();
          if (status === 'resolved' || status === 'local') {
            const snapshot = resource.value();
            if (snapshot === null) {
              return;
            }
            if (snapshot.kind === 'error') {
              if (isCurrent()) {
                this.error.set(this.getErrorMessage(snapshot.error));
                this.errorCode.set(this.getErrorCode(snapshot.error));
              }
              release();
              subscriber.next(null);
              subscriber.complete();
              cleanup();
              return;
            }
            const result = snapshot.value;
            if (isCurrent()) {
              this.status.set(
                typeof successMessage === 'function'
                  ? successMessage(result)
                  : successMessage,
              );
            }
            release();
            subscriber.next(result);
            subscriber.complete();
            cleanup();
          } else if (status === 'error') {
            const error = resource.error();
            if (isCurrent()) {
              this.error.set(this.getErrorMessage(error));
              this.errorCode.set(this.getErrorCode(error));
            }
            release();
            subscriber.next(null);
            subscriber.complete();
            cleanup();
          }
        }),
      );

      return finish;
    });
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
