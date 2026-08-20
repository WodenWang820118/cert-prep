import { inject, Injectable } from '@angular/core';
import type { DocumentOperationRead, DocumentRead } from '../../contracts/api.contracts';
import { EMPTY, from, Observable, of, ReplaySubject, Subject, catchError, concatMap, defer, map, switchMap, takeWhile, tap } from 'rxjs';
import type { ObservableInput } from 'rxjs';
import type {
  OperationRequestOutcome,
  SourceUploadItem,
  SourceUploadLifecycleHooks,
  UploadAttempt,
  UploadResumeResult,
  UploadTransportRun,
  MutableUploadRun,
  TerminalUploadStatus,
} from './contracts/source-import.contracts';
import type { DocumentOperationEvent } from '../../contracts/operation-events.contracts';
import { DetachedOperationTombstoneTracker } from './detached-operation-tombstone-tracker';
import { DocumentOperationSnapshotService } from './document-operation-snapshot.service';

@Injectable({ providedIn: 'root' })
export class SourceUploadLifecycle {
  private readonly detachedTombstones = inject(DetachedOperationTombstoneTracker);
  private readonly snapshot = inject(DocumentOperationSnapshotService);
  private readonly attempts = new Map<string, UploadAttempt>();
  private activeRun: MutableUploadRun | null = null;
  private hooks!: SourceUploadLifecycleHooks;

  configure(hooks: SourceUploadLifecycleHooks): void {
    this.hooks = hooks;
    this.detachedTombstones.configure({
      getOperation: hooks.getOperation,
      cancelOperation: hooks.cancelOperation,
      streamOperation: hooks.streamOperation,
    });
  }

  hasActiveRun(): boolean { return this.activeRun !== null; }

  resume(itemId: string): UploadResumeResult | null {
    const attempt = this.attempts.get(itemId);
    if (attempt === undefined || attempt.slotHeld || !this.owns(attempt) || this.hooks.item(itemId)?.status !== 'status_unavailable' || attempt.run.queuedReconciliationItemIds.includes(itemId)) return null;
    const currentRun = this.activeRun;
    let result: UploadResumeResult;
    if (currentRun !== null) {
      if (!currentRun.itemIds.includes(itemId)) currentRun.itemIds.push(itemId);
      attempt.run = currentRun;
      result = { kind: 'current-run' };
    } else {
      const run = this.createRun(attempt.run.projectId, attempt.run.contextEpoch, attempt.run.concurrency);
      run.itemIds.push(itemId);
      this.activeRun = run;
      attempt.run = run;
      result = { kind: 'new-run', run };
    }
    attempt.run.queuedReconciliationItemIds.push(itemId);
    this.pump(attempt.run);
    return result;
  }

  begin(projectId: string, contextEpoch: number, itemIds: readonly string[], concurrency: number): UploadTransportRun {
    if (this.activeRun !== null) {
      for (const itemId of itemIds) {
        if (!this.activeRun.itemIds.includes(itemId)) this.activeRun.itemIds.push(itemId);
        if (!this.activeRun.queuedItemIds.includes(itemId) && !this.attempts.has(itemId)) this.activeRun.queuedItemIds.push(itemId);
      }
      this.pump(this.activeRun);
      return this.activeRun;
    }
    const run = this.createRun(projectId, contextEpoch, concurrency, itemIds);
    this.activeRun = run;
    this.pump(run);
    return run;
  }

  cancel(itemId: string): void {
    const item = this.hooks.item(itemId);
    if (item?.status === 'queued') {
      if (this.hooks.patch(itemId, { status: 'canceled', error: null })) this.removeQueuedItem(itemId);
      return;
    }
    const attempt = this.attempts.get(itemId);
    if (attempt === undefined || attempt.cancelRequested || !this.owns(attempt)) return;
    attempt.cancelRequested = true;
    this.hooks.patch(itemId, { status: 'cancel_requested', error: null });
    const cancellation = captureOperationRequest(this.hooks.cancelOperation(attempt.run.projectId, attempt.operationId));
    attempt.controller.abort(new DOMException('The upload was canceled.', 'AbortError'));
    attempt.cancellationSubscription = this.reconcileCaptured(
      attempt,
      'delete',
      cancellation,
    ).subscribe({
      error: () => this.pauseForTransportError(attempt),
      complete: () => {
        attempt.cancellationSubscription = null;
      },
    });
  }

  invalidate(): void {
    const attempts = [...this.attempts.values()];
    this.attempts.clear();
    if (this.activeRun !== null) {
      this.activeRun.queuedItemIds = [];
      this.activeRun.queuedReconciliationItemIds = [];
      this.activeRun.documents.splice(0);
      this.completeRun(this.activeRun);
      this.activeRun = null;
    }
    for (const attempt of attempts) {
      attempt.actions.complete();
      attempt.actionSubscription.unsubscribe();
      attempt.cancellationSubscription?.unsubscribe();
      attempt.cancellationSubscription = null;
      this.detachedTombstones.track(attempt.run.projectId, attempt.operationId);
      attempt.controller.abort(new DOMException('The upload context changed.', 'AbortError'));
    }
  }

  private createRun(projectId: string, contextEpoch: number, concurrency: number, itemIds: readonly string[] = []): MutableUploadRun {
    const doneSubject = new ReplaySubject<void>(1);
    return { projectId, contextEpoch, concurrency, itemIds: [...itemIds], queuedItemIds: [...itemIds], queuedReconciliationItemIds: [], activeCount: 0, doneSubject, done: doneSubject.asObservable(), documents: [] };
  }

  private pump(run: MutableUploadRun): void {
    if (!this.hooks.current(run.projectId, run.contextEpoch)) {
      run.queuedItemIds = [];
      run.queuedReconciliationItemIds = [];
      this.completeRun(run);
      if (this.activeRun === run) this.activeRun = null;
      return;
    }
    while (run.activeCount < run.concurrency) {
      const reconciliationItemId = run.queuedReconciliationItemIds.shift();
      if (reconciliationItemId !== undefined) {
        const attempt = this.attempts.get(reconciliationItemId);
        if (attempt === undefined || attempt.run !== run || attempt.slotHeld || !this.owns(attempt) || this.hooks.item(reconciliationItemId)?.status !== 'status_unavailable') continue;
        this.startReconciliation(attempt);
        continue;
      }
      const itemId = run.queuedItemIds.shift();
      if (itemId === undefined) break;
      const item = this.hooks.item(itemId);
      if (item === undefined || item.status !== 'queued' || item.document !== null) continue;
      const actions = new Subject<() => Observable<void>>();
      const actionSubscription = actions.pipe(concatMap((action) => defer(action).pipe(catchError(() => EMPTY)))).subscribe();
      const attempt: UploadAttempt = { itemId: item.id, operationId: this.hooks.newOperationId(), controller: new AbortController(), actions, actionSubscription, cancellationSubscription: null, run, documentId: null, document: null, cancelRequested: false, slotHeld: true };
      if (!this.hooks.patch(item.id, { status: 'uploading', error: null })) { actionSubscription.unsubscribe(); actions.complete(); continue; }
      run.activeCount += 1;
      this.attempts.set(item.id, attempt);
      this.execute(attempt, item);
    }
    this.finishRun(run);
  }

  private startReconciliation(attempt: UploadAttempt): void {
    if (!this.hooks.patch(attempt.itemId, { status: attempt.cancelRequested ? 'cancel_requested' : 'uploading', error: null })) return;
    attempt.slotHeld = true;
    attempt.run.activeCount += 1;
    this.enqueue(attempt, () => this.requestReconciliation(attempt));
  }

  private execute(attempt: UploadAttempt, item: SourceUploadItem): void {
    from(this.hooks.upload(attempt.run.projectId, item, attempt.operationId, attempt.controller.signal)).subscribe({
      next: (document) => this.enqueue(attempt, () => this.acceptUpload(attempt, document)),
      error: (error: unknown) => this.enqueue(attempt, () => this.reconcileTransportError(attempt, error)),
    });
  }

  private acceptUpload(attempt: UploadAttempt, document: DocumentRead): Observable<void> {
    if (!this.owns(attempt)) return EMPTY;
    if (attempt.cancelRequested) {
      this.observeDocument(attempt, document);
      this.hooks.patch(attempt.itemId, { status: 'cancel_requested', document, error: null });
      return of(undefined);
    }
    this.handoffDocument(attempt, document);
    return of(undefined);
  }

  private reconcileTransportError(attempt: UploadAttempt, error: unknown): Observable<void> {
    if (!this.owns(attempt)) return EMPTY;
    if (!attempt.cancelRequested && !isAbortError(error) && isAuthoritativeClientFailure(error)) {
      this.settle(attempt, 'failed', attempt.document, this.hooks.errorMessage(error));
      return of(undefined);
    }
    return this.reconcile(attempt, 'get', this.hooks.getOperation(attempt.run.projectId, attempt.operationId));
  }

  private reconcile(attempt: UploadAttempt, requestKind: 'get' | 'delete', request: Observable<DocumentOperationRead>): Observable<void> {
    return this.reconcileCaptured(attempt, requestKind, captureOperationRequest(request));
  }

  private reconcileCaptured(attempt: UploadAttempt, requestKind: 'get' | 'delete', request: Observable<OperationRequestOutcome>): Observable<void> {
    if (!this.owns(attempt)) return EMPTY;
    return request.pipe(switchMap((outcome) => {
      if (!this.owns(attempt)) return EMPTY;
      if (outcome.ok) return this.reconcileSnapshot(attempt, outcome.operation);
      return requestKind === 'delete'
        ? this.reconcile(attempt, 'get', this.hooks.getOperation(attempt.run.projectId, attempt.operationId))
        : defer(() => { this.pauseForTransportError(attempt); return of(undefined); });
    }));
  }

  private reconcileSnapshot(attempt: UploadAttempt, operation: DocumentOperationRead): Observable<void> {
    if (!this.owns(attempt)) return EMPTY;
    if (!this.snapshot.isExpectedDocumentOperation(operation, attempt.operationId, attempt.run.projectId)) {
      this.pauseForTransportError(attempt);
      return of(undefined);
    }
    if (operation.document_id !== null) attempt.documentId = operation.document_id;
    return this.loadOperationDocument(attempt, operation).pipe(switchMap((document) => {
      if (document === undefined || !this.owns(attempt)) return EMPTY;
      if (operation.status === 'canceled') { this.settle(attempt, 'canceled', document, null); return of(undefined); }
      if (operation.status === 'failed') { this.settle(attempt, 'failed', document, operation.error ?? 'The document operation failed.'); return of(undefined); }
      if (operation.status === 'succeeded') { if (document !== null) this.handoffDocument(attempt, document); return of(undefined); }
      if (operation.status === 'cancel_requested') attempt.cancelRequested = true;
      if (attempt.cancelRequested) {
        this.hooks.patch(attempt.itemId, { status: 'cancel_requested', document, error: null });
        return this.streamOperation(attempt);
      }
      if (document !== null) this.handoffDocument(attempt, document);
      else return this.streamOperation(attempt);
      return of(undefined);
    }));
  }

  private streamOperation(attempt: UploadAttempt): Observable<void> {
    if (!this.owns(attempt)) return EMPTY;
    return this.hooks
      .streamOperation(attempt.run.projectId, attempt.operationId)
      .pipe(
        tap((event) => this.applyOperationEvent(attempt, event)),
        takeWhile(() => this.owns(attempt), true),
        map(() => undefined),
        catchError(() => {
          this.pauseForTransportError(attempt);
          return of(undefined);
        }),
      );
  }

  private applyOperationEvent(
    attempt: UploadAttempt,
    event: DocumentOperationEvent,
  ): void {
    const { operation, document } = event;
    if (
      !this.snapshot.isExpectedDocumentOperation(
        operation,
        attempt.operationId,
        attempt.run.projectId,
      )
    ) {
      throw new Error('Unexpected document operation event.');
    }
    if (document !== null) {
      this.observeDocument(attempt, document);
    }
    if (operation.status === 'canceled') {
      this.settle(attempt, 'canceled', document, null);
    } else if (operation.status === 'failed') {
      this.settle(
        attempt,
        'failed',
        document,
        operation.error ?? 'The document operation failed.',
      );
    } else if (operation.status === 'succeeded' && document !== null) {
      this.handoffDocument(attempt, document);
    } else if (operation.status === 'cancel_requested') {
      attempt.cancelRequested = true;
      this.hooks.patch(attempt.itemId, {
        status: 'cancel_requested',
        document,
        error: null,
      });
    } else if (document !== null) {
      this.handoffDocument(attempt, document);
    }
  }

  private loadOperationDocument(attempt: UploadAttempt, operation: DocumentOperationRead): Observable<DocumentRead | null | undefined> {
    const documentId = operation.document_id ?? attempt.documentId;
    if (documentId === null) return of(attempt.document);
    attempt.documentId = documentId;
    return from(this.hooks.getDocument(attempt.run.projectId, documentId)).pipe(
      tap((document) => this.observeDocument(attempt, document)),
      map((document) => document as DocumentRead | null),
      catchError(() => { this.pauseForTransportError(attempt); return of(undefined); }),
    );
  }

  private handoffDocument(attempt: UploadAttempt, document: DocumentRead): void {
    if (document.status === 'canceled') { this.observeDocument(attempt, document); this.settle(attempt, 'canceled', document, null); return; }
    this.observeDocument(attempt, document);
    const existingIndex = attempt.run.documents.findIndex((item) => item.id === document.id);
    if (existingIndex === -1) attempt.run.documents.push(document); else attempt.run.documents[existingIndex] = document;
    this.settle(attempt, 'uploaded', document, null);
  }

  private observeDocument(attempt: UploadAttempt, document: DocumentRead): void {
    if (!this.owns(attempt)) return;
    attempt.documentId = document.id;
    attempt.document = document;
    this.hooks.accept(document, attempt.operationId);
  }

  private settle(attempt: UploadAttempt, status: TerminalUploadStatus, document: DocumentRead | null, error: string | null): void {
    if (!this.owns(attempt)) return;
    this.hooks.patch(attempt.itemId, { status, document, error });
    this.attempts.delete(attempt.itemId);
    attempt.actions.complete();
    attempt.actionSubscription.unsubscribe();
    attempt.cancellationSubscription?.unsubscribe();
    attempt.cancellationSubscription = null;
    this.releaseSlot(attempt);
  }

  private requestReconciliation(attempt: UploadAttempt): Observable<void> {
    const projectId = attempt.run.projectId;
    return attempt.cancelRequested
      ? this.reconcile(attempt, 'delete', this.hooks.cancelOperation(projectId, attempt.operationId))
      : this.reconcile(attempt, 'get', this.hooks.getOperation(projectId, attempt.operationId));
  }

  private pauseForTransportError(attempt: UploadAttempt): void {
    if (!this.owns(attempt)) return;
    this.hooks.patch(attempt.itemId, { status: 'status_unavailable', document: attempt.document, error: attempt.cancelRequested ? 'Cancellation status is unavailable. Retry status check.' : 'Upload status is unavailable. Retry status check.' });
    this.releaseSlot(attempt);
  }

  private enqueue(attempt: UploadAttempt, action: () => Observable<void>): void {
    if (this.owns(attempt)) attempt.actions.next(action);
  }

  private releaseSlot(attempt: UploadAttempt): void {
    if (!attempt.slotHeld) return;
    attempt.slotHeld = false;
    attempt.run.activeCount = Math.max(0, attempt.run.activeCount - 1);
    queueMicrotask(() => this.pump(attempt.run));
  }

  private removeQueuedItem(itemId: string): void {
    if (this.activeRun === null) return;
    this.activeRun.queuedItemIds = this.activeRun.queuedItemIds.filter((queuedId) => queuedId !== itemId);
    this.pump(this.activeRun);
  }

  private finishRun(run: MutableUploadRun): void {
    if (run.queuedItemIds.length === 0 && run.queuedReconciliationItemIds.length === 0 && run.activeCount === 0) {
      this.completeRun(run);
      if (this.activeRun === run) this.activeRun = null;
    }
  }

  private completeRun(run: MutableUploadRun): void {
    if (!run.doneSubject.closed) { run.doneSubject.next(); run.doneSubject.complete(); }
  }

  private owns(attempt: UploadAttempt): boolean {
    return this.attempts.get(attempt.itemId) === attempt && this.hooks.current(attempt.run.projectId, attempt.run.contextEpoch);
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

function isAuthoritativeClientFailure(error: unknown): boolean {
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429;
}

function captureOperationRequest(request: ObservableInput<DocumentOperationRead>): Observable<OperationRequestOutcome> {
  return from(request).pipe(map((operation) => ({ ok: true, operation }) as const), catchError((error: unknown) => of({ ok: false, error }) as Observable<OperationRequestOutcome>));
}
