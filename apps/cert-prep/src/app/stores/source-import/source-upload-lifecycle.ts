import type { DocumentOperationRead, DocumentRead } from '../../cert-prep-api';
import type { SourceUploadItem } from './contracts/source-import.contracts';
import { DetachedOperationTombstoneTracker } from './detached-operation-tombstone-tracker';
import { isExpectedDocumentOperation } from './document-operation-snapshot';

const TRANSPORT_RETRY_DELAYS_MS = [1000, 2000, 4000] as const;
const OPERATION_PROGRESS_POLL_MS = 1000;

type UploadPatch = Partial<Omit<SourceUploadItem, 'id' | 'file'>>;
type TerminalUploadStatus = 'uploaded' | 'failed' | 'canceled';
type OperationRequestOutcome =
  | { readonly ok: true; readonly operation: DocumentOperationRead }
  | { readonly ok: false; readonly error: unknown };

export interface UploadTransportRun {
  readonly projectId: string;
  readonly contextEpoch: number;
  readonly documents: DocumentRead[];
  readonly done: Promise<void>;
  runtimePromptNeeded: boolean;
}

export type UploadResumeResult =
  | { readonly kind: 'current-run' }
  | { readonly kind: 'new-run'; readonly run: UploadTransportRun };

export interface SourceUploadLifecycleHooks {
  readonly item: (itemId: string) => SourceUploadItem | undefined;
  readonly current: (projectId: string, contextEpoch: number) => boolean;
  readonly patch: (itemId: string, patch: UploadPatch) => boolean;
  readonly accept: (document: DocumentRead, pollDocument: boolean) => void;
  readonly upload: (
    projectId: string,
    item: SourceUploadItem,
    operationId: string,
    signal: AbortSignal,
  ) => Promise<DocumentRead>;
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
}

interface MutableUploadRun extends UploadTransportRun {
  readonly concurrency: number;
  queuedItemIds: string[];
  activeCount: number;
  resolveDone: () => void;
}

interface UploadAttempt {
  readonly itemId: string;
  readonly operationId: string;
  readonly controller: AbortController;
  run: MutableUploadRun;
  documentId: string | null;
  document: DocumentRead | null;
  cancelRequested: boolean;
  slotHeld: boolean;
  transportRetryCount: number;
  pollTimer: ReturnType<typeof setTimeout> | null;
  chain: Promise<void>;
}

export class SourceUploadLifecycle {
  private readonly attempts = new Map<string, UploadAttempt>();
  private readonly detachedTombstones: DetachedOperationTombstoneTracker;
  private activeRun: MutableUploadRun | null = null;

  constructor(private readonly hooks: SourceUploadLifecycleHooks) {
    this.detachedTombstones = new DetachedOperationTombstoneTracker(hooks);
  }

  hasActiveRun(): boolean {
    return this.activeRun !== null;
  }

  resume(itemId: string): UploadResumeResult | null {
    const attempt = this.attempts.get(itemId);
    if (
      attempt === undefined ||
      attempt.slotHeld ||
      !this.owns(attempt) ||
      this.hooks.item(itemId)?.status !== 'status_unavailable'
    ) {
      return null;
    }

    const currentRun = this.activeRun;
    let result: UploadResumeResult;
    if (currentRun !== null) {
      attempt.run = currentRun;
      result = { kind: 'current-run' };
    } else {
      const run = this.createRun(
        attempt.run.projectId,
        attempt.run.contextEpoch,
        attempt.run.concurrency,
      );
      this.activeRun = run;
      attempt.run = run;
      result = { kind: 'new-run', run };
    }

    attempt.slotHeld = true;
    attempt.run.activeCount += 1;
    attempt.transportRetryCount = 0;
    this.clearPollTimer(attempt);
    this.hooks.patch(itemId, {
      status: attempt.cancelRequested ? 'cancel_requested' : 'uploading',
      error: null,
    });
    this.serialize(attempt, () => this.requestReconciliation(attempt));
    return result;
  }

  begin(
    projectId: string,
    contextEpoch: number,
    itemIds: readonly string[],
    concurrency: number,
  ): UploadTransportRun {
    if (this.activeRun !== null) {
      this.activeRun.queuedItemIds.push(...itemIds);
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
      if (this.hooks.patch(itemId, { status: 'canceled', error: null })) {
        this.removeQueuedItem(itemId);
      }
      return;
    }

    const attempt = this.attempts.get(itemId);
    if (
      attempt === undefined ||
      attempt.cancelRequested ||
      !this.owns(attempt)
    ) {
      return;
    }

    attempt.cancelRequested = true;
    attempt.transportRetryCount = 0;
    this.clearPollTimer(attempt);
    this.hooks.patch(itemId, { status: 'cancel_requested', error: null });
    const cancellation = captureOperationRequest(
      this.hooks.cancelOperation(
        attempt.run.projectId,
        attempt.operationId,
      ),
    );
    attempt.controller.abort(
      new DOMException('The upload was canceled.', 'AbortError'),
    );
    this.serialize(attempt, () =>
      this.reconcileCaptured(attempt, 'delete', cancellation),
    );
  }

  invalidate(): void {
    const attempts = [...this.attempts.values()];
    this.attempts.clear();
    if (this.activeRun !== null) {
      this.activeRun.queuedItemIds = [];
      this.activeRun.documents.splice(0);
      this.activeRun.resolveDone();
      this.activeRun = null;
    }

    for (const attempt of attempts) {
      this.clearPollTimer(attempt);
      this.detachedTombstones.track(
        attempt.run.projectId,
        attempt.operationId,
      );
      attempt.controller.abort(
        new DOMException('The upload context changed.', 'AbortError'),
      );
    }
  }

  private createRun(
    projectId: string,
    contextEpoch: number,
    concurrency: number,
    itemIds: readonly string[] = [],
  ): MutableUploadRun {
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    return {
      projectId,
      contextEpoch,
      concurrency,
      queuedItemIds: [...itemIds],
      activeCount: 0,
      resolveDone,
      done,
      documents: [],
      runtimePromptNeeded: false,
    };
  }

  private pump(run: MutableUploadRun): void {
    if (!this.hooks.current(run.projectId, run.contextEpoch)) {
      run.queuedItemIds = [];
      run.resolveDone();
      if (this.activeRun === run) {
        this.activeRun = null;
      }
      return;
    }

    while (
      run.activeCount < run.concurrency &&
      run.queuedItemIds.length > 0
    ) {
      const itemId = run.queuedItemIds.shift();
      const item = itemId === undefined ? undefined : this.hooks.item(itemId);
      if (
        item === undefined ||
        item.status !== 'queued' ||
        item.document !== null
      ) {
        continue;
      }

      const attempt: UploadAttempt = {
        itemId: item.id,
        operationId: crypto.randomUUID(),
        controller: new AbortController(),
        run,
        documentId: null,
        document: null,
        cancelRequested: false,
        slotHeld: true,
        transportRetryCount: 0,
        pollTimer: null,
        chain: Promise.resolve(),
      };
      if (!this.hooks.patch(item.id, { status: 'uploading', error: null })) {
        continue;
      }
      run.activeCount += 1;
      this.attempts.set(item.id, attempt);
      void this.execute(attempt, item);
    }
    this.finishRun(run);
  }

  private async execute(
    attempt: UploadAttempt,
    item: SourceUploadItem,
  ): Promise<void> {
    try {
      const document = await this.hooks.upload(
        attempt.run.projectId,
        item,
        attempt.operationId,
        attempt.controller.signal,
      );
      this.serialize(attempt, async () => this.acceptUpload(attempt, document));
    } catch (error) {
      this.serialize(attempt, () => this.reconcileTransportError(attempt, error));
    }
  }

  private async acceptUpload(
    attempt: UploadAttempt,
    document: DocumentRead,
  ): Promise<void> {
    if (!this.owns(attempt)) {
      return;
    }
    if (attempt.cancelRequested) {
      this.observeDocument(attempt, document, false);
      this.hooks.patch(attempt.itemId, {
        status: 'cancel_requested',
        document,
        error: null,
      });
      return;
    }
    this.handoffDocument(attempt, document);
  }

  private async reconcileTransportError(
    attempt: UploadAttempt,
    error: unknown,
  ): Promise<void> {
    if (!this.owns(attempt)) {
      return;
    }
    if (
      !attempt.cancelRequested &&
      !isAbortError(error) &&
      isTerminalHttpFailure(error)
    ) {
      const errorCode = this.hooks.errorCode(error);
      attempt.run.runtimePromptNeeded ||=
        errorCode === 'paddle_runtime_missing' ||
        errorCode === 'windowsml_runtime_missing';
      this.settle(
        attempt,
        'failed',
        attempt.document,
        this.hooks.errorMessage(error),
      );
      return;
    }

    await this.reconcile(
      attempt,
      'get',
      this.hooks.getOperation(attempt.run.projectId, attempt.operationId),
    );
  }

  private async reconcile(
    attempt: UploadAttempt,
    requestKind: 'get' | 'delete',
    request: Promise<DocumentOperationRead>,
  ): Promise<void> {
    await this.reconcileCaptured(
      attempt,
      requestKind,
      captureOperationRequest(request),
    );
  }

  private async reconcileCaptured(
    attempt: UploadAttempt,
    requestKind: 'get' | 'delete',
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
    if (requestKind === 'delete') {
      await this.reconcile(
        attempt,
        'get',
        this.hooks.getOperation(attempt.run.projectId, attempt.operationId),
      );
    } else {
      this.scheduleTransportRetry(attempt);
    }
  }

  private async reconcileSnapshot(
    attempt: UploadAttempt,
    operation: DocumentOperationRead,
  ): Promise<void> {
    if (
      !this.owns(attempt)
    ) {
      return;
    }
    if (
      !isExpectedDocumentOperation(
        operation,
        attempt.operationId,
        attempt.run.projectId,
      )
    ) {
      this.scheduleTransportRetry(attempt);
      return;
    }

    if (operation.document_id !== null) {
      attempt.documentId = operation.document_id;
    }

    const document = await this.loadOperationDocument(attempt, operation);
    if (document === undefined || !this.owns(attempt)) {
      return;
    }
    attempt.transportRetryCount = 0;

    if (operation.status === 'canceled') {
      this.settle(attempt, 'canceled', document, null);
      return;
    }
    if (operation.status === 'failed') {
      this.settle(
        attempt,
        'failed',
        document,
        operation.error ?? 'The document operation failed.',
      );
      return;
    }
    if (operation.status === 'succeeded') {
      this.handoffDocument(attempt, document as DocumentRead);
      return;
    }

    if (operation.status === 'cancel_requested') {
      attempt.cancelRequested = true;
    }

    if (attempt.cancelRequested) {
      this.hooks.patch(attempt.itemId, {
        status: 'cancel_requested',
        document,
        error: null,
      });
      if (
        operation.status !== 'cancel_requested' &&
        operation.cancellable
      ) {
        this.scheduleProgressPoll(attempt, 'delete');
      } else {
        this.scheduleProgressPoll(attempt);
      }
      return;
    }

    if (document !== null) {
      this.handoffDocument(attempt, document);
    } else {
      this.scheduleProgressPoll(attempt);
    }
  }

  private async loadOperationDocument(
    attempt: UploadAttempt,
    operation: DocumentOperationRead,
  ): Promise<DocumentRead | null | undefined> {
    const documentId = operation.document_id ?? attempt.documentId;
    if (documentId === null) {
      return attempt.document;
    }
    attempt.documentId = documentId;
    try {
      const document = await this.hooks.getDocument(
        attempt.run.projectId,
        documentId,
      );
      this.observeDocument(attempt, document, false);
      return document;
    } catch {
      this.scheduleTransportRetry(attempt);
      return undefined;
    }
  }

  private handoffDocument(
    attempt: UploadAttempt,
    document: DocumentRead,
  ): void {
    if (document.status === 'canceled') {
      this.observeDocument(attempt, document, false);
      this.settle(attempt, 'canceled', document, null);
      return;
    }
    if (document.status === 'ocr_failed') {
      this.observeDocument(attempt, document, false);
      this.settle(attempt, 'failed', document, 'OCR failed to complete.');
      return;
    }

    const pollDocument =
      document.status === 'processing' || document.status === 'cancel_requested';
    this.observeDocument(attempt, document, pollDocument);
    const existingIndex = attempt.run.documents.findIndex(
      (item) => item.id === document.id,
    );
    if (existingIndex === -1) {
      attempt.run.documents.push(document);
    } else {
      attempt.run.documents[existingIndex] = document;
    }
    this.settle(attempt, 'uploaded', document, null);
  }

  private observeDocument(
    attempt: UploadAttempt,
    document: DocumentRead,
    pollDocument: boolean,
  ): void {
    if (!this.owns(attempt)) {
      return;
    }
    attempt.documentId = document.id;
    attempt.document = document;
    this.hooks.accept(document, pollDocument);
  }

  private settle(
    attempt: UploadAttempt,
    status: TerminalUploadStatus,
    document: DocumentRead | null,
    error: string | null,
  ): void {
    if (!this.owns(attempt)) {
      return;
    }
    this.hooks.patch(attempt.itemId, { status, document, error });
    this.clearPollTimer(attempt);
    this.attempts.delete(attempt.itemId);
    this.releaseSlot(attempt);
  }

  private scheduleTransportRetry(attempt: UploadAttempt): void {
    if (!this.owns(attempt) || attempt.pollTimer !== null) {
      return;
    }
    if (attempt.transportRetryCount >= TRANSPORT_RETRY_DELAYS_MS.length) {
      this.pauseForTransportError(attempt);
      return;
    }

    const delay = TRANSPORT_RETRY_DELAYS_MS[attempt.transportRetryCount];
    attempt.transportRetryCount += 1;
    attempt.pollTimer = setTimeout(() => {
      attempt.pollTimer = null;
      if (!this.owns(attempt)) {
        return;
      }
      this.serialize(attempt, () => this.requestReconciliation(attempt));
    }, delay);
  }

  private scheduleProgressPoll(
    attempt: UploadAttempt,
    requestKind: 'get' | 'delete' = 'get',
  ): void {
    if (!this.owns(attempt) || attempt.pollTimer !== null) {
      return;
    }
    attempt.transportRetryCount = 0;
    attempt.pollTimer = setTimeout(() => {
      attempt.pollTimer = null;
      if (!this.owns(attempt)) {
        return;
      }
      this.serialize(attempt, () =>
        requestKind === 'delete'
          ? this.reconcile(
              attempt,
              'delete',
              this.hooks.cancelOperation(
                attempt.run.projectId,
                attempt.operationId,
              ),
            )
          : this.reconcile(
              attempt,
              'get',
              this.hooks.getOperation(
                attempt.run.projectId,
                attempt.operationId,
              ),
            ),
      );
    }, OPERATION_PROGRESS_POLL_MS);
  }

  private async requestReconciliation(attempt: UploadAttempt): Promise<void> {
    const projectId = attempt.run.projectId;
    if (attempt.cancelRequested) {
      await this.reconcile(
        attempt,
        'delete',
        this.hooks.cancelOperation(projectId, attempt.operationId),
      );
      return;
    }
    await this.reconcile(
      attempt,
      'get',
      this.hooks.getOperation(projectId, attempt.operationId),
    );
  }

  private pauseForTransportError(attempt: UploadAttempt): void {
    if (!this.owns(attempt)) {
      return;
    }
    this.clearPollTimer(attempt);
    this.hooks.patch(attempt.itemId, {
      status: 'status_unavailable',
      document: attempt.document,
      error: attempt.cancelRequested
        ? 'Cancellation status is unavailable. Retry status check.'
        : 'Upload status is unavailable. Retry status check.',
    });
    this.releaseSlot(attempt);
  }

  private serialize(
    attempt: UploadAttempt,
    action: () => Promise<void>,
  ): void {
    attempt.chain = attempt.chain
      .catch(() => undefined)
      .then(action)
      .catch(() => undefined);
  }

  private releaseSlot(attempt: UploadAttempt): void {
    if (!attempt.slotHeld) {
      return;
    }
    attempt.slotHeld = false;
    attempt.run.activeCount = Math.max(0, attempt.run.activeCount - 1);
    this.pump(attempt.run);
  }

  private removeQueuedItem(itemId: string): void {
    if (this.activeRun === null) {
      return;
    }
    this.activeRun.queuedItemIds = this.activeRun.queuedItemIds.filter(
      (queuedId) => queuedId !== itemId,
    );
    this.pump(this.activeRun);
  }

  private finishRun(run: MutableUploadRun): void {
    if (run.queuedItemIds.length === 0 && run.activeCount === 0) {
      run.resolveDone();
      if (this.activeRun === run) {
        this.activeRun = null;
      }
    }
  }

  private clearPollTimer(attempt: UploadAttempt): void {
    if (attempt.pollTimer !== null) {
      clearTimeout(attempt.pollTimer);
      attempt.pollTimer = null;
    }
  }

  private owns(attempt: UploadAttempt): boolean {
    return (
      this.attempts.get(attempt.itemId) === attempt &&
      this.hooks.current(attempt.run.projectId, attempt.run.contextEpoch)
    );
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'AbortError'
  );
}

function isTerminalHttpFailure(error: unknown): boolean {
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && status >= 400;
}

function captureOperationRequest(
  request: Promise<DocumentOperationRead>,
): Promise<OperationRequestOutcome> {
  return request.then(
    (operation) => ({ ok: true, operation }),
    (error: unknown) => ({ ok: false, error }),
  );
}
