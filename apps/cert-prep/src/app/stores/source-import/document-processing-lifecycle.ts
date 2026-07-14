import type { DocumentOperationRead, DocumentRead } from '../../cert-prep-api';
import { isExpectedDocumentOperation } from './document-operation-snapshot';

const TRANSPORT_RETRY_DELAYS_MS = [1000, 2000, 4000] as const;
const OPERATION_PROGRESS_POLL_MS = 1000;
const ACTIVE_DOCUMENT_STATUSES = new Set(['processing', 'cancel_requested']);

type DocumentActionKind = 'retry' | 'cancel';
type DocumentActionRequestKind =
  | 'post'
  | 'get'
  | 'delete-operation'
  | 'delete-document';

export type DocumentProcessingActionStatus =
  | 'running'
  | 'cancel_requested'
  | 'status_unavailable'
  | 'failed';

export interface DocumentProcessingActionView {
  readonly kind: DocumentActionKind;
  readonly status: DocumentProcessingActionStatus;
  readonly cancellable: boolean;
  readonly error: string | null;
}

type OperationRequestOutcome =
  | { readonly ok: true; readonly operation: DocumentOperationRead }
  | { readonly ok: false; readonly error: unknown };

export interface DocumentProcessingLifecycleHooks {
  readonly current: (projectId: string, contextEpoch: number) => boolean;
  readonly setView: (
    documentId: string,
    view: DocumentProcessingActionView | null,
  ) => void;
  readonly acceptDocument: (document: DocumentRead) => void;
  readonly retryDocument: (
    projectId: string,
    documentId: string,
    operationId: string,
    signal: AbortSignal,
  ) => Promise<DocumentOperationRead>;
  readonly cancelDocument: (
    projectId: string,
    documentId: string,
  ) => Promise<DocumentOperationRead>;
  readonly getDocument: (
    projectId: string,
    documentId: string,
  ) => Promise<DocumentRead>;
  readonly getOperation: (
    projectId: string,
    operationId: string,
  ) => Promise<DocumentOperationRead>;
  readonly cancelOperation: (
    projectId: string,
    operationId: string,
  ) => Promise<DocumentOperationRead>;
  readonly errorMessage: (error: unknown) => string;
  readonly errorCode: (error: unknown) => string | null;
  readonly runtimeMissing: () => void;
}

interface DocumentProcessingAttempt {
  readonly projectId: string;
  readonly contextEpoch: number;
  readonly documentId: string;
  readonly kind: DocumentActionKind;
  readonly controller: AbortController | null;
  operationId: string | null;
  cancelRequested: boolean;
  cancelAcknowledged: boolean;
  publishWinnerExpected: boolean;
  viewStatus: DocumentProcessingActionStatus;
  operationRetryCount: number;
  documentRetryCount: number;
  timer: ReturnType<typeof setTimeout> | null;
  chain: Promise<void>;
}

export class DocumentProcessingLifecycle {
  private readonly attempts = new Map<string, DocumentProcessingAttempt>();
  private readonly viewDocumentIds = new Set<string>();

  constructor(private readonly hooks: DocumentProcessingLifecycleHooks) {}

  hasActiveAttempt(documentId: string): boolean {
    return this.attempts.has(documentId);
  }

  async retry(
    projectId: string,
    contextEpoch: number,
    documentId: string,
  ): Promise<boolean> {
    if (this.attempts.has(documentId)) {
      return false;
    }

    const operationId = crypto.randomUUID();
    const controller = new AbortController();
    const attempt: DocumentProcessingAttempt = {
      projectId,
      contextEpoch,
      documentId,
      kind: 'retry',
      controller,
      operationId,
      cancelRequested: false,
      cancelAcknowledged: false,
      publishWinnerExpected: false,
      viewStatus: 'running',
      operationRetryCount: 0,
      documentRetryCount: 0,
      timer: null,
      chain: Promise.resolve(),
    };
    this.attempts.set(documentId, attempt);
    this.publishView(attempt, 'running', true, null);
    const request = captureOperationRequest(
      this.hooks.retryDocument(
        projectId,
        documentId,
        operationId,
        controller.signal,
      ),
    );
    await this.enqueue(attempt, () =>
      this.reconcileCaptured(attempt, 'post', request),
    );
    return true;
  }

  async cancel(
    projectId: string,
    contextEpoch: number,
    documentId: string,
  ): Promise<boolean> {
    const existing = this.attempts.get(documentId);
    if (existing !== undefined) {
      if (!this.owns(existing)) {
        return false;
      }
      if (existing.cancelRequested) {
        return this.resume(documentId);
      }
      existing.cancelRequested = true;
      existing.cancelAcknowledged = false;
      existing.operationRetryCount = 0;
      existing.documentRetryCount = 0;
      this.clearTimer(existing);
      this.publishView(existing, 'cancel_requested', false, null);
      const operationId = existing.operationId;
      if (operationId === null) {
        return false;
      }
      const cancellation = captureOperationRequest(
        this.hooks.cancelOperation(projectId, operationId),
      );
      existing.controller?.abort(
        new DOMException('OCR processing was canceled.', 'AbortError'),
      );
      await this.enqueue(existing, () =>
        this.reconcileCaptured(
          existing,
          'delete-operation',
          cancellation,
        ),
      );
      return true;
    }

    const attempt: DocumentProcessingAttempt = {
      projectId,
      contextEpoch,
      documentId,
      kind: 'cancel',
      controller: null,
      operationId: null,
      cancelRequested: true,
      cancelAcknowledged: false,
      publishWinnerExpected: false,
      viewStatus: 'cancel_requested',
      operationRetryCount: 0,
      documentRetryCount: 0,
      timer: null,
      chain: Promise.resolve(),
    };
    this.attempts.set(documentId, attempt);
    this.publishView(attempt, 'cancel_requested', false, null);
    const cancellation = captureOperationRequest(
      this.hooks.cancelDocument(projectId, documentId),
    );
    await this.enqueue(attempt, () =>
      this.reconcileCaptured(attempt, 'delete-document', cancellation),
    );
    return true;
  }

  async resume(documentId: string): Promise<boolean> {
    const attempt = this.attempts.get(documentId);
    if (
      attempt === undefined ||
      !this.owns(attempt) ||
      attempt.viewStatus !== 'status_unavailable'
    ) {
      return false;
    }

    attempt.operationRetryCount = 0;
    attempt.documentRetryCount = 0;
    this.clearTimer(attempt);
    this.publishView(
      attempt,
      attempt.cancelRequested ? 'cancel_requested' : 'running',
      !attempt.cancelRequested,
      null,
    );
    await this.enqueue(attempt, () => this.requestReconciliation(attempt));
    return true;
  }

  invalidate(): void {
    const attempts = [...this.attempts.values()];
    this.attempts.clear();
    for (const attempt of attempts) {
      this.clearTimer(attempt);
      attempt.controller?.abort(
        new DOMException('The document context changed.', 'AbortError'),
      );
    }
    for (const documentId of this.viewDocumentIds) {
      this.hooks.setView(documentId, null);
    }
    this.viewDocumentIds.clear();
  }

  private async reconcileCaptured(
    attempt: DocumentProcessingAttempt,
    requestKind: DocumentActionRequestKind,
    request: Promise<OperationRequestOutcome>,
  ): Promise<void> {
    if (!this.owns(attempt)) {
      return;
    }
    const outcome = await request;
    if (!this.owns(attempt)) {
      return;
    }
    if (outcome.ok) {
      await this.reconcileSnapshot(attempt, outcome.operation);
      return;
    }

    if (requestKind === 'post') {
      if (attempt.cancelRequested) {
        return;
      }
      if (
        this.noteRuntimeMissing(outcome.error) ||
        isDefinitiveHttpFailure(outcome.error)
      ) {
        this.fail(attempt, this.hooks.errorMessage(outcome.error));
        return;
      }
      await this.reconcileOperation(attempt, 'get');
      return;
    }

    if (requestKind === 'delete-operation') {
      await this.reconcileOperation(attempt, 'get');
      return;
    }

    if (requestKind === 'delete-document') {
      if ((outcome.error as { status?: unknown }).status === 409) {
        attempt.publishWinnerExpected = true;
        await this.reconcilePublishWinner(attempt);
        return;
      }
      if (isDefinitiveHttpFailure(outcome.error)) {
        this.fail(attempt, this.hooks.errorMessage(outcome.error));
        return;
      }
    }

    this.scheduleTransportRetry(attempt, 'operation');
  }

  private async reconcileSnapshot(
    attempt: DocumentProcessingAttempt,
    operation: DocumentOperationRead,
  ): Promise<void> {
    if (!this.owns(attempt) || !this.acceptsSnapshot(attempt, operation)) {
      this.scheduleTransportRetry(attempt, 'operation');
      return;
    }

    attempt.operationId ??= operation.id;
    attempt.operationRetryCount = 0;
    if (operation.status === 'cancel_requested') {
      attempt.cancelRequested = true;
      attempt.cancelAcknowledged = true;
    }

    const document = await this.loadDocument(attempt, operation);
    if (document === undefined || !this.owns(attempt)) {
      return;
    }
    attempt.documentRetryCount = 0;

    if (operation.status === 'canceled') {
      this.succeed(attempt);
      return;
    }
    if (operation.status === 'succeeded') {
      this.succeed(attempt);
      return;
    }
    if (operation.status === 'failed') {
      this.fail(
        attempt,
        operation.error ?? 'The document processing operation failed.',
      );
      return;
    }

    if (attempt.cancelRequested) {
      this.publishView(attempt, 'cancel_requested', false, null);
      this.scheduleProgressPoll(
        attempt,
        operation.status === 'running' && operation.cancellable
          ? 'delete-operation'
          : 'get',
      );
      return;
    }

    this.publishView(attempt, 'running', operation.cancellable, null);
    this.scheduleProgressPoll(attempt, 'get');
  }

  private acceptsSnapshot(
    attempt: DocumentProcessingAttempt,
    operation: DocumentOperationRead,
  ): boolean {
    const operationId = attempt.operationId ?? operation.id;
    if (
      !isExpectedDocumentOperation(
        operation,
        operationId,
        attempt.projectId,
      ) ||
      (operation.document_id !== null &&
        operation.document_id !== attempt.documentId)
    ) {
      return false;
    }
    if (operation.document_id === attempt.documentId) {
      return true;
    }
    return (
      attempt.kind === 'retry' &&
      attempt.cancelRequested &&
      operation.status === 'canceled'
    );
  }

  private async loadDocument(
    attempt: DocumentProcessingAttempt,
    operation: DocumentOperationRead,
  ): Promise<DocumentRead | null | undefined> {
    if (operation.document_id === null) {
      return null;
    }
    try {
      const document = await this.hooks.getDocument(
        attempt.projectId,
        attempt.documentId,
      );
      if (
        !this.owns(attempt) ||
        document.id !== attempt.documentId ||
        document.project_id !== attempt.projectId
      ) {
        this.scheduleTransportRetry(attempt, 'document');
        return undefined;
      }
      this.hooks.acceptDocument(document);
      return document;
    } catch {
      this.scheduleTransportRetry(attempt, 'document');
      return undefined;
    }
  }

  private async reconcilePublishWinner(
    attempt: DocumentProcessingAttempt,
  ): Promise<void> {
    try {
      const document = await this.hooks.getDocument(
        attempt.projectId,
        attempt.documentId,
      );
      if (
        !this.owns(attempt) ||
        document.id !== attempt.documentId ||
        document.project_id !== attempt.projectId
      ) {
        this.scheduleTransportRetry(attempt, 'document');
        return;
      }
      this.hooks.acceptDocument(document);
      attempt.documentRetryCount = 0;
      if (ACTIVE_DOCUMENT_STATUSES.has(document.status)) {
        this.publishView(attempt, 'running', false, null);
        this.scheduleProgressPoll(attempt, 'get-document');
        return;
      }
      this.succeed(attempt);
    } catch {
      this.scheduleTransportRetry(attempt, 'document');
    }
  }

  private async requestReconciliation(
    attempt: DocumentProcessingAttempt,
  ): Promise<void> {
    if (!this.owns(attempt)) {
      return;
    }
    if (attempt.publishWinnerExpected) {
      await this.reconcilePublishWinner(attempt);
      return;
    }
    if (attempt.cancelRequested && !attempt.cancelAcknowledged) {
      if (attempt.operationId === null) {
        await this.reconcileDocumentCancellation(attempt);
      } else {
        await this.reconcileOperation(attempt, 'delete-operation');
      }
      return;
    }
    await this.reconcileOperation(attempt, 'get');
  }

  private async reconcileDocumentCancellation(
    attempt: DocumentProcessingAttempt,
  ): Promise<void> {
    await this.reconcileCaptured(
      attempt,
      'delete-document',
      captureOperationRequest(
        this.hooks.cancelDocument(attempt.projectId, attempt.documentId),
      ),
    );
  }

  private async reconcileOperation(
    attempt: DocumentProcessingAttempt,
    requestKind: 'get' | 'delete-operation',
  ): Promise<void> {
    const operationId = attempt.operationId;
    if (operationId === null) {
      this.scheduleTransportRetry(attempt, 'operation');
      return;
    }
    const request =
      requestKind === 'get'
        ? this.hooks.getOperation(attempt.projectId, operationId)
        : this.hooks.cancelOperation(attempt.projectId, operationId);
    await this.reconcileCaptured(
      attempt,
      requestKind,
      captureOperationRequest(request),
    );
  }

  private scheduleTransportRetry(
    attempt: DocumentProcessingAttempt,
    target: 'operation' | 'document',
  ): void {
    if (!this.owns(attempt) || attempt.timer !== null) {
      return;
    }
    const retryCount =
      target === 'operation'
        ? attempt.operationRetryCount
        : attempt.documentRetryCount;
    if (retryCount >= TRANSPORT_RETRY_DELAYS_MS.length) {
      this.pause(attempt);
      return;
    }
    const delay = TRANSPORT_RETRY_DELAYS_MS[retryCount];
    if (target === 'operation') {
      attempt.operationRetryCount += 1;
    } else {
      attempt.documentRetryCount += 1;
    }
    attempt.timer = setTimeout(() => {
      attempt.timer = null;
      if (this.owns(attempt)) {
        void this.enqueue(attempt, () => this.requestReconciliation(attempt));
      }
    }, delay);
  }

  private scheduleProgressPoll(
    attempt: DocumentProcessingAttempt,
    requestKind: 'get' | 'delete-operation' | 'get-document',
  ): void {
    if (!this.owns(attempt) || attempt.timer !== null) {
      return;
    }
    attempt.operationRetryCount = 0;
    attempt.timer = setTimeout(() => {
      attempt.timer = null;
      if (this.owns(attempt)) {
        void this.enqueue(attempt, () => {
          if (requestKind === 'get-document') {
            return this.reconcilePublishWinner(attempt);
          }
          return requestKind === 'get'
            ? this.reconcileOperation(attempt, 'get')
            : this.reconcileOperation(attempt, 'delete-operation');
        });
      }
    }, OPERATION_PROGRESS_POLL_MS);
  }

  private pause(attempt: DocumentProcessingAttempt): void {
    this.clearTimer(attempt);
    this.publishView(
      attempt,
      'status_unavailable',
      attempt.kind === 'retry' && !attempt.cancelRequested,
      attempt.cancelRequested
        ? 'OCR cancellation status is unavailable. Retry status.'
        : 'OCR retry status is unavailable. Retry status.',
    );
  }

  private fail(attempt: DocumentProcessingAttempt, error: string): void {
    if (!this.owns(attempt)) {
      return;
    }
    this.clearTimer(attempt);
    this.attempts.delete(attempt.documentId);
    this.publishView(attempt, 'failed', false, error);
  }

  private succeed(attempt: DocumentProcessingAttempt): void {
    if (!this.owns(attempt)) {
      return;
    }
    this.clearTimer(attempt);
    this.attempts.delete(attempt.documentId);
    this.hooks.setView(attempt.documentId, null);
    this.viewDocumentIds.delete(attempt.documentId);
  }

  private noteRuntimeMissing(error: unknown): boolean {
    const errorCode = this.hooks.errorCode(error);
    if (
      errorCode === 'paddle_runtime_missing' ||
      errorCode === 'windowsml_runtime_missing'
    ) {
      this.hooks.runtimeMissing();
      return true;
    }
    return false;
  }

  private publishView(
    attempt: DocumentProcessingAttempt,
    status: DocumentProcessingActionStatus,
    cancellable: boolean,
    error: string | null,
  ): void {
    if (!this.owns(attempt) && status !== 'failed') {
      return;
    }
    attempt.viewStatus = status;
    this.viewDocumentIds.add(attempt.documentId);
    this.hooks.setView(attempt.documentId, {
      kind: attempt.kind,
      status,
      cancellable,
      error,
    });
  }

  private enqueue(
    attempt: DocumentProcessingAttempt,
    action: () => Promise<void>,
  ): Promise<void> {
    const next = attempt.chain.catch(() => undefined).then(action);
    attempt.chain = next.catch(() => undefined);
    return attempt.chain;
  }

  private clearTimer(attempt: DocumentProcessingAttempt): void {
    if (attempt.timer !== null) {
      clearTimeout(attempt.timer);
      attempt.timer = null;
    }
  }

  private owns(attempt: DocumentProcessingAttempt): boolean {
    return (
      this.attempts.get(attempt.documentId) === attempt &&
      this.hooks.current(attempt.projectId, attempt.contextEpoch)
    );
  }
}

function isDefinitiveHttpFailure(error: unknown): boolean {
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

function captureOperationRequest(
  request: Promise<DocumentOperationRead>,
): Promise<OperationRequestOutcome> {
  return request.then(
    (operation) => ({ ok: true, operation }),
    (error: unknown) => ({ ok: false, error }),
  );
}
