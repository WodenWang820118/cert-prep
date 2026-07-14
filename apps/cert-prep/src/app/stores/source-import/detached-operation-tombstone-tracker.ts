import type { DocumentOperationRead } from '../../cert-prep-api';
import { isExpectedDocumentOperation } from './document-operation-snapshot';

const RETRY_DELAYS_MS = [1000, 2000, 4000] as const;

export interface DetachedOperationTombstoneHooks {
  readonly getOperation: (
    projectId: string,
    operationId: string,
  ) => Promise<DocumentOperationRead>;
  readonly cancelOperation: (
    projectId: string,
    operationId: string,
  ) => Promise<DocumentOperationRead>;
}

interface DetachedTombstone {
  readonly key: string;
  readonly projectId: string;
  readonly operationId: string;
  retryCount: number;
  timer: ReturnType<typeof setTimeout> | null;
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
    void this.reconcile(tombstone);
  }

  private async reconcile(tombstone: DetachedTombstone): Promise<void> {
    if (this.tombstones.get(tombstone.key) !== tombstone) {
      return;
    }
    try {
      const operation = await this.hooks.cancelOperation(
        tombstone.projectId,
        tombstone.operationId,
      );
      if (this.finishWhenDurable(tombstone, operation)) {
        return;
      }
    } catch {
      try {
        const operation = await this.hooks.getOperation(
          tombstone.projectId,
          tombstone.operationId,
        );
        if (this.finishWhenDurable(tombstone, operation)) {
          return;
        }
      } catch {
        // Keep the exact operation owned until a durable server state is seen.
      }
    }
    this.schedule(tombstone);
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
      clearTimeout(tombstone.timer);
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
    tombstone.timer = setTimeout(() => {
      tombstone.timer = null;
      void this.reconcile(tombstone);
    }, delay);
  }
}
