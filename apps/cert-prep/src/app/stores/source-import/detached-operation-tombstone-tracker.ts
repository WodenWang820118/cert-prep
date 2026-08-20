import { inject, Injectable } from '@angular/core';
import type { DocumentOperationRead } from '../../contracts/api.contracts';
import type { DocumentOperationEvent } from '../../contracts/operation-events.contracts';
import { catchError, defer, of, switchMap, takeWhile, tap } from 'rxjs';
import {
  DetachedOperationTombstoneHooks,
  DetachedTombstone,
} from './contracts/source-import.contracts';
import { DocumentOperationSnapshotService } from './document-operation-snapshot.service';

@Injectable({ providedIn: 'root' })
export class DetachedOperationTombstoneTracker {
  private readonly snapshot = inject(DocumentOperationSnapshotService);
  private readonly tombstones = new Map<string, DetachedTombstone>();
  private hooks!: DetachedOperationTombstoneHooks;

  configure(hooks: DetachedOperationTombstoneHooks): void {
    this.hooks = hooks;
  }

  track(projectId: string, operationId: string): void {
    const key = `${projectId}:${operationId}`;
    if (this.tombstones.has(key)) return;
    const tombstone: DetachedTombstone = {
      key,
      projectId,
      operationId,
      subscription: null,
    };
    this.tombstones.set(key, tombstone);
    this.reconcile(tombstone);
  }

  private reconcile(tombstone: DetachedTombstone): void {
    if (this.tombstones.get(tombstone.key) !== tombstone) return;
    const subscription = defer(() =>
      this.hooks.cancelOperation(tombstone.projectId, tombstone.operationId),
    )
      .pipe(
        catchError(() =>
          this.hooks.getOperation(tombstone.projectId, tombstone.operationId),
        ),
        switchMap((operation) =>
          this.finishWhenDurable(tombstone, operation)
            ? of(operation)
            : this.hooks.streamOperation(
                tombstone.projectId,
                tombstone.operationId,
              ),
        ),
        tap((value) => {
          const operation = isDocumentOperationEvent(value)
            ? value.operation
            : value;
          this.finishWhenDurable(tombstone, operation);
        }),
        takeWhile(() => this.tombstones.has(tombstone.key)),
        catchError(() => {
          this.tombstones.delete(tombstone.key);
          return of(null);
        }),
      )
      .subscribe();
    tombstone.subscription = subscription;
  }

  private finishWhenDurable(
    tombstone: DetachedTombstone,
    operation: DocumentOperationRead,
  ): boolean {
    if (
      !this.snapshot.isExpectedDocumentOperation(
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
    this.tombstones.delete(tombstone.key);
    tombstone.subscription?.unsubscribe();
    tombstone.subscription = null;
    return true;
  }
}

function isDocumentOperationEvent(
  value: DocumentOperationRead | DocumentOperationEvent,
): value is DocumentOperationEvent {
  return 'operation' in value;
}
