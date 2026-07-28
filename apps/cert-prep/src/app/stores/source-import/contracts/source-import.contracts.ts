import type {
  DocumentOperationRead,
  DocumentRead,
} from '../../../contracts/api.contracts';
import type { Observable, Subscription } from 'rxjs';

/**
 * Optional OCR/parser language hint sent with an uploaded source file.
 */
export type LanguageHint =
  | 'auto'
  | 'ja'
  | 'zh-Hant'
  | 'zh-Hans'
  | 'en'
  | 'mixed';

/**
 * Display-ready parsing metric shown on the source document card.
 */
export interface DocumentParsingMetric {
  readonly label: string;
  readonly value: string;
}

export type SourceUploadStatus =
  | 'queued'
  | 'uploading'
  | 'cancel_requested'
  | 'canceled'
  | 'status_unavailable'
  | 'uploaded'
  | 'failed';

export interface SourceUploadItem {
  readonly id: string;
  readonly file: File;
  readonly status: SourceUploadStatus;
  readonly document: DocumentRead | null;
  readonly error: string | null;
}

/**
 * Source document metric lookup definition for schema variants emitted by the
 * backend during parsing performance experiments.
 */
export interface ParsingMetricDefinition {
  readonly label: string;
  readonly kind: 'duration' | 'count';
  readonly keys: readonly string[];
}

export interface SourceFileSelectionOptions {
  readonly append?: boolean;
  readonly autoUpload?: boolean;
}

export type UploadPatch = Partial<Omit<SourceUploadItem, 'id' | 'file'>>;
export type TerminalUploadStatus = 'uploaded' | 'failed' | 'canceled';
export type OperationRequestOutcome =
  | { readonly ok: true; readonly operation: DocumentOperationRead }
  | { readonly ok: false; readonly error: unknown };

export interface UploadTransportRun {
  readonly projectId: string;
  readonly contextEpoch: number;
  readonly itemIds: string[];
  readonly documents: DocumentRead[];
  readonly done: Observable<void>;
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
  ) => Observable<DocumentRead>;
  readonly getDocument: (
    projectId: string,
    documentId: string,
  ) => Observable<DocumentRead>;
  readonly getOperation: (
    projectId: string,
    operationId: string,
  ) => Observable<DocumentOperationRead>;
  readonly cancelOperation: (
    projectId: string,
    operationId: string,
  ) => Observable<DocumentOperationRead>;
  readonly newOperationId: () => string;
  readonly errorMessage: (error: unknown) => string;
}

export interface MutableUploadRun extends UploadTransportRun {
  readonly concurrency: number;
  readonly doneSubject: import('rxjs').ReplaySubject<void>;
  queuedItemIds: string[];
  queuedReconciliationItemIds: string[];
  activeCount: number;
}

export interface UploadAttempt {
  readonly itemId: string;
  readonly operationId: string;
  readonly controller: AbortController;
  readonly actions: import('rxjs').Subject<() => Observable<void>>;
  readonly actionSubscription: Subscription;
  run: MutableUploadRun;
  documentId: string | null;
  document: DocumentRead | null;
  cancelRequested: boolean;
  slotHeld: boolean;
  transportRetryCount: number;
  pollSubscription: Subscription | null;
}

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

export interface DetachedTombstone {
  readonly key: string;
  readonly projectId: string;
  readonly operationId: string;
  retryCount: number;
  timer: Subscription | null;
}
