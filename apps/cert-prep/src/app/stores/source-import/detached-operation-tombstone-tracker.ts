import type { DocumentOperationRead } from '../../cert-prep-api';
import { Observable, Subscription, catchError, defer, of, tap, timer } from 'rxjs';
import { isExpectedDocumentOperation } from './document-operation-snapshot';

const RETRY_DELAYS_MS = [1000, 2000, 4000] as const;

export interface DetachedOperationTombstoneHooks {
  readonly getOperation: (
    projectId: string,
    operationId: string,
  ) => Observable<DocumentOperationRead>;
  readonly cancelOperation: (
    projectId: string,
    operationId: string,
  ) => Observable<DocumentOperationRead>;
}

interface DetachedTombstone {
  readonly key: string;
  readonly projectId: string;
  readonly operationId: string;
  retryCount: number;
  timer: Subscription | null;
}

export class DetachedOperationTombstoneTracker {
  private readonly tombstones = new Map<string, DetachedTombstone>();

  constructor(private readonly hooks: DetachedOperationTombstoneHooks) {}

  track(projectId: string, operationId: string): void {
    const key = `${projectId}:${operationId}`;
    if (this.tombstones.has(key)) {
      return;
    }
    const tombstone: DetachedTombstone = {
      key,
      projectId,
      operationId,
      retryCount: 0,
      timer: null,
    };
    this.tombstones.set(key, tombstone);
    this.reconcile(tombstone);
  }

  private reconcile(tombstone: DetachedTombstone): void {
    if (this.tombstones.get(tombstone.key) !== tombstone) {
      return;
    }
    defer(() => this.hooks.cancelOperation(tombstone.projectId, tombstone.operationId)).pipe(
      catchError(() => this.hooks.getOperation(tombstone.projectId, tombstone.operationId)),
      tap((operation) => {
        if (!this.finishWhenDurable(tombstone, operation)) this.schedule(tombstone);
      }),
      catchError(() => { this.schedule(tombstone); return of(null); }),
    ).subscribe();
  }

  private finishWhenDurable(
    tombstone: DetachedTombstone,
    operation: DocumentOperationRead,
  ): boolean {
    if (
      !isExpectedDocumentOperation(
        operation,
        tombstone.operationId,
        tombstone.projectId,
      ) ||
      !['cancel_requested', 'canceled', 'failed', 'succeeded'].includes(
        operation.status,
      )
    ) {
      return false;
    }
    if (tombstone.timer !== null) {
      tombstone.timer.unsubscribe();
    }
    this.tombstones.delete(tombstone.key);
    return true;
  }

  private schedule(tombstone: DetachedTombstone): void {
    if (
      this.tombstones.get(tombstone.key) !== tombstone ||
      tombstone.timer !== null
    ) {
      return;
    }
    const delay =
      RETRY_DELAYS_MS[
        Math.min(tombstone.retryCount, RETRY_DELAYS_MS.length - 1)
      ];
    tombstone.retryCount += 1;
    tombstone.timer = timer(delay).subscribe(() => {
      tombstone.timer = null;
      this.reconcile(tombstone);
    });
  }
}
