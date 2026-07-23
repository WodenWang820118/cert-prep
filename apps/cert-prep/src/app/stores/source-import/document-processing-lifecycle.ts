import type { DocumentOperationRead, DocumentRead } from '../../cert-prep-api';
import { EMPTY, from, Observable, Subject, Subscription, catchError, concatMap, defer, map, of, switchMap, tap, timer } from 'rxjs';
import type { ObservableInput } from 'rxjs';
import { isExpectedDocumentOperation } from './document-operation-snapshot';

const TRANSPORT_RETRY_DELAYS_MS = [1000, 2000, 4000] as const;
const OPERATION_PROGRESS_POLL_MS = 1000;
const ACTIVE_DOCUMENT_STATUSES = new Set(['processing', 'cancel_requested']);
type DocumentActionKind = 'retry' | 'cancel';
type DocumentActionRequestKind = 'post' | 'get' | 'delete-operation' | 'delete-document';
export type DocumentProcessingActionStatus = 'running' | 'cancel_requested' | 'status_unavailable' | 'failed';
export interface DocumentProcessingActionView { readonly kind: DocumentActionKind; readonly status: DocumentProcessingActionStatus; readonly cancellable: boolean; readonly error: string | null; }
type OperationRequestOutcome =
  | { readonly ok: true; readonly operation: DocumentOperationRead }
  | { readonly ok: false; readonly error: unknown };

export interface DocumentProcessingLifecycleHooks {
  readonly current: (projectId: string, contextEpoch: number) => boolean;
  readonly setView: (documentId: string, view: DocumentProcessingActionView | null) => void;
  readonly acceptDocument: (document: DocumentRead) => void;
  readonly retryDocument: (projectId: string, documentId: string, operationId: string, signal: AbortSignal) => Observable<DocumentOperationRead>;
  readonly cancelDocument: (projectId: string, documentId: string) => Observable<DocumentOperationRead>;
  readonly getDocument: (projectId: string, documentId: string) => Observable<DocumentRead>;
  readonly getOperation: (projectId: string, operationId: string) => Observable<DocumentOperationRead>;
  readonly cancelOperation: (projectId: string, operationId: string) => Observable<DocumentOperationRead>;
  readonly errorMessage: (error: unknown) => string;
  readonly errorCode: (error: unknown) => string | null;
  readonly runtimeMissing: () => void;
}

interface Attempt {
  readonly projectId: string; readonly contextEpoch: number; readonly documentId: string; readonly kind: DocumentActionKind;
  readonly controller: AbortController | null; readonly actions: Subject<() => Observable<void>>; readonly actionSubscription: Subscription;
  operationId: string | null; cancelRequested: boolean; cancelAcknowledged: boolean; publishWinnerExpected: boolean;
  viewStatus: DocumentProcessingActionStatus; operationRetryCount: number; documentRetryCount: number; timer: Subscription | null;
}

export class DocumentProcessingLifecycle {
  private readonly attempts = new Map<string, Attempt>();
  private readonly viewDocumentIds = new Set<string>();
  constructor(private readonly hooks: DocumentProcessingLifecycleHooks) {}
  hasActiveAttempt(documentId: string): boolean { return this.attempts.has(documentId); }

  retry(projectId: string, contextEpoch: number, documentId: string): Observable<boolean> {
    if (this.attempts.has(documentId)) return of(false);
    const attempt = this.createAttempt(projectId, contextEpoch, documentId, 'retry', crypto.randomUUID(), new AbortController());
    this.publishView(attempt, 'running', true, null);
    const request = captureOperationRequest(this.hooks.retryDocument(projectId, documentId, attempt.operationId as string, (attempt.controller as AbortController).signal));
    this.enqueue(attempt, () => this.reconcileCaptured(attempt, 'post', request));
    return of(true);
  }

  cancel(projectId: string, contextEpoch: number, documentId: string): Observable<boolean> {
    const existing = this.attempts.get(documentId);
    if (existing !== undefined) {
      if (!this.owns(existing)) return of(false);
      if (existing.cancelRequested) return this.resume(documentId);
      existing.cancelRequested = true;
      existing.cancelAcknowledged = false;
      existing.operationRetryCount = 0;
      existing.documentRetryCount = 0;
      this.clearTimer(existing);
      this.publishView(existing, 'cancel_requested', false, null);
      const operationId = existing.operationId;
      if (operationId === null) return of(false);
      const cancellation = captureOperationRequest(this.hooks.cancelOperation(projectId, operationId));
      existing.controller?.abort(new DOMException('OCR processing was canceled.', 'AbortError'));
      this.enqueue(existing, () => this.reconcileCaptured(existing, 'delete-operation', cancellation));
      return of(true);
    }
    const attempt = this.createAttempt(projectId, contextEpoch, documentId, 'cancel', null, null);
    attempt.cancelRequested = true;
    this.publishView(attempt, 'cancel_requested', false, null);
    const cancellation = captureOperationRequest(this.hooks.cancelDocument(projectId, documentId));
    this.enqueue(attempt, () => this.reconcileCaptured(attempt, 'delete-document', cancellation));
    return of(true);
  }

  resume(documentId: string): Observable<boolean> {
    const attempt = this.attempts.get(documentId);
    if (attempt === undefined || !this.owns(attempt) || attempt.viewStatus !== 'status_unavailable') return of(false);
    attempt.operationRetryCount = 0; attempt.documentRetryCount = 0; this.clearTimer(attempt);
    this.publishView(attempt, attempt.cancelRequested ? 'cancel_requested' : 'running', !attempt.cancelRequested, null);
    this.enqueue(attempt, () => this.requestReconciliation(attempt));
    return of(true);
  }

  invalidate(): void {
    const attempts = [...this.attempts.values()];
    this.attempts.clear();
    for (const attempt of attempts) {
      this.clearTimer(attempt); attempt.actions.complete(); attempt.actionSubscription.unsubscribe();
      attempt.controller?.abort(new DOMException('The document context changed.', 'AbortError'));
    }
    for (const documentId of this.viewDocumentIds) this.hooks.setView(documentId, null);
    this.viewDocumentIds.clear();
  }

  private createAttempt(projectId: string, contextEpoch: number, documentId: string, kind: DocumentActionKind, operationId: string | null, controller: AbortController | null): Attempt {
    const actions = new Subject<() => Observable<void>>();
    const actionSubscription = actions.pipe(concatMap((action) => defer(action).pipe(catchError(() => EMPTY)))).subscribe();
    const attempt: Attempt = { projectId, contextEpoch, documentId, kind, controller, actions, actionSubscription, operationId, cancelRequested: false, cancelAcknowledged: false, publishWinnerExpected: false, viewStatus: 'running', operationRetryCount: 0, documentRetryCount: 0, timer: null };
    this.attempts.set(documentId, attempt);
    return attempt;
  }

  private reconcileCaptured(attempt: Attempt, requestKind: DocumentActionRequestKind, request: Observable<OperationRequestOutcome>): Observable<void> {
    if (!this.owns(attempt)) return EMPTY;
    return request.pipe(switchMap((outcome) => {
      if (!this.owns(attempt)) return EMPTY;
      if (outcome.ok) return this.reconcileSnapshot(attempt, outcome.operation);
      if (requestKind === 'post') {
        if (attempt.cancelRequested) return EMPTY;
        if (this.noteRuntimeMissing(outcome.error) || isDefinitiveHttpFailure(outcome.error)) { this.fail(attempt, this.hooks.errorMessage(outcome.error)); return EMPTY; }
        return this.reconcileOperation(attempt, 'get');
      }
      if (requestKind === 'delete-operation') return this.reconcileOperation(attempt, 'get');
      if (requestKind === 'delete-document' && (outcome.error as { status?: unknown }).status === 409) { attempt.publishWinnerExpected = true; return this.reconcilePublishWinner(attempt); }
      if (requestKind === 'delete-document' && isDefinitiveHttpFailure(outcome.error)) { this.fail(attempt, this.hooks.errorMessage(outcome.error)); return EMPTY; }
      this.scheduleTransportRetry(attempt, 'operation');
      return EMPTY;
    }));
  }

  private reconcileSnapshot(attempt: Attempt, operation: DocumentOperationRead): Observable<void> {
    if (!this.owns(attempt) || !this.acceptsSnapshot(attempt, operation)) { this.scheduleTransportRetry(attempt, 'operation'); return EMPTY; }
    attempt.operationId ??= operation.id; attempt.operationRetryCount = 0;
    if (operation.status === 'cancel_requested') { attempt.cancelRequested = true; attempt.cancelAcknowledged = true; }
    return this.loadDocument(attempt, operation).pipe(switchMap((document) => {
      if (document === undefined || !this.owns(attempt)) return EMPTY;
      attempt.documentRetryCount = 0;
      if (operation.status === 'canceled' || operation.status === 'succeeded') { this.succeed(attempt); return of(undefined); }
      if (operation.status === 'failed') { this.fail(attempt, operation.error ?? 'The document processing operation failed.'); return EMPTY; }
      if (attempt.cancelRequested) { this.publishView(attempt, 'cancel_requested', false, null); this.scheduleProgressPoll(attempt, operation.status === 'running' && operation.cancellable ? 'delete-operation' : 'get'); }
      else { this.publishView(attempt, 'running', operation.cancellable, null); this.scheduleProgressPoll(attempt, 'get'); }
      return of(undefined);
    }));
  }

  private acceptsSnapshot(attempt: Attempt, operation: DocumentOperationRead): boolean {
    const operationId = attempt.operationId ?? operation.id;
    if (!isExpectedDocumentOperation(operation, operationId, attempt.projectId) || (operation.document_id !== null && operation.document_id !== attempt.documentId)) return false;
    return operation.document_id === attempt.documentId || (attempt.kind === 'retry' && attempt.cancelRequested && operation.status === 'canceled');
  }

  private loadDocument(attempt: Attempt, operation: DocumentOperationRead): Observable<DocumentRead | null | undefined> {
    if (operation.document_id === null) return of(null);
    return from(this.hooks.getDocument(attempt.projectId, attempt.documentId)).pipe(
      tap((document) => {
        if (!this.owns(attempt) || document.id !== attempt.documentId || document.project_id !== attempt.projectId) this.scheduleTransportRetry(attempt, 'document');
        else this.hooks.acceptDocument(document);
      }),
      switchMap((document) => document.id === attempt.documentId && document.project_id === attempt.projectId ? of(document) : of(undefined)),
      catchError(() => { this.scheduleTransportRetry(attempt, 'document'); return of(undefined); }),
    );
  }

  private reconcilePublishWinner(attempt: Attempt): Observable<void> {
    return from(this.hooks.getDocument(attempt.projectId, attempt.documentId)).pipe(
      switchMap((document) => {
        if (!this.owns(attempt) || document.id !== attempt.documentId || document.project_id !== attempt.projectId) { this.scheduleTransportRetry(attempt, 'document'); return EMPTY; }
        this.hooks.acceptDocument(document); attempt.documentRetryCount = 0;
        if (ACTIVE_DOCUMENT_STATUSES.has(document.status)) { this.publishView(attempt, 'running', false, null); this.scheduleProgressPoll(attempt, 'get-document'); return of(undefined); }
        this.succeed(attempt); return of(undefined);
      }),
      catchError(() => { this.scheduleTransportRetry(attempt, 'document'); return EMPTY; }),
    );
  }

  private requestReconciliation(attempt: Attempt): Observable<void> {
    if (!this.owns(attempt)) return EMPTY;
    if (attempt.publishWinnerExpected) return this.reconcilePublishWinner(attempt);
    if (attempt.cancelRequested && !attempt.cancelAcknowledged) return attempt.operationId === null ? this.reconcileDocumentCancellation(attempt) : this.reconcileOperation(attempt, 'delete-operation');
    return this.reconcileOperation(attempt, 'get');
  }

  private reconcileDocumentCancellation(attempt: Attempt): Observable<void> {
    return this.reconcileCaptured(attempt, 'delete-document', captureOperationRequest(this.hooks.cancelDocument(attempt.projectId, attempt.documentId)));
  }

  private reconcileOperation(attempt: Attempt, requestKind: 'get' | 'delete-operation'): Observable<void> {
    const operationId = attempt.operationId;
    if (operationId === null) { this.scheduleTransportRetry(attempt, 'operation'); return EMPTY; }
    const request = requestKind === 'get' ? this.hooks.getOperation(attempt.projectId, operationId) : this.hooks.cancelOperation(attempt.projectId, operationId);
    return this.reconcileCaptured(attempt, requestKind, captureOperationRequest(request));
  }

  private scheduleTransportRetry(attempt: Attempt, target: 'operation' | 'document'): void {
    if (!this.owns(attempt) || attempt.timer !== null) return;
    const retryCount = target === 'operation' ? attempt.operationRetryCount : attempt.documentRetryCount;
    if (retryCount >= TRANSPORT_RETRY_DELAYS_MS.length) { this.pause(attempt); return; }
    const delay = TRANSPORT_RETRY_DELAYS_MS[retryCount];
    if (target === 'operation') attempt.operationRetryCount += 1; else attempt.documentRetryCount += 1;
    attempt.timer = timer(delay).subscribe(() => { attempt.timer = null; if (this.owns(attempt)) this.enqueue(attempt, () => this.requestReconciliation(attempt)); });
  }

  private scheduleProgressPoll(attempt: Attempt, requestKind: 'get' | 'delete-operation' | 'get-document'): void {
    if (!this.owns(attempt) || attempt.timer !== null) return;
    attempt.operationRetryCount = 0;
    attempt.timer = timer(OPERATION_PROGRESS_POLL_MS).subscribe(() => {
      attempt.timer = null;
      if (!this.owns(attempt)) return;
      this.enqueue(attempt, () => requestKind === 'get-document' ? this.reconcilePublishWinner(attempt) : requestKind === 'get' ? this.reconcileOperation(attempt, 'get') : this.reconcileOperation(attempt, 'delete-operation'));
    });
  }

  private pause(attempt: Attempt): void { this.clearTimer(attempt); this.publishView(attempt, 'status_unavailable', attempt.kind === 'retry' && !attempt.cancelRequested, attempt.cancelRequested ? 'OCR cancellation status is unavailable. Retry status.' : 'OCR retry status is unavailable. Retry status.'); }
  private fail(attempt: Attempt, error: string): void { if (!this.owns(attempt)) return; this.clearTimer(attempt); this.attempts.delete(attempt.documentId); this.publishView(attempt, 'failed', false, error); }
  private succeed(attempt: Attempt): void { if (!this.owns(attempt)) return; this.clearTimer(attempt); this.attempts.delete(attempt.documentId); this.hooks.setView(attempt.documentId, null); this.viewDocumentIds.delete(attempt.documentId); }
  private noteRuntimeMissing(error: unknown): boolean { const code = this.hooks.errorCode(error); if (code === 'paddle_runtime_missing' || code === 'windowsml_runtime_missing') { this.hooks.runtimeMissing(); return true; } return false; }
  private publishView(attempt: Attempt, status: DocumentProcessingActionStatus, cancellable: boolean, error: string | null): void { if (!this.owns(attempt) && status !== 'failed') return; attempt.viewStatus = status; this.viewDocumentIds.add(attempt.documentId); this.hooks.setView(attempt.documentId, { kind: attempt.kind, status, cancellable, error }); }
  private enqueue(attempt: Attempt, action: () => Observable<void>): void { if (this.owns(attempt)) attempt.actions.next(action); }
  private clearTimer(attempt: Attempt): void { attempt.timer?.unsubscribe(); attempt.timer = null; }
  private owns(attempt: Attempt): boolean { return this.attempts.get(attempt.documentId) === attempt && this.hooks.current(attempt.projectId, attempt.contextEpoch); }
}

function isDefinitiveHttpFailure(error: unknown): boolean { const status = (error as { status?: unknown }).status; return typeof status === 'number' && status >= 400 && status < 500; }
function captureOperationRequest(request: ObservableInput<DocumentOperationRead>): Observable<OperationRequestOutcome> { return from(request).pipe(map((operation) => ({ ok: true, operation }) as const), catchError((error: unknown) => of({ ok: false, error }) as Observable<OperationRequestOutcome>)); }
