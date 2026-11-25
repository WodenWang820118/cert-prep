import type {
  SourceOperationRead,
  SourceRead,
} from '../../core/domain';
import type { SourceOperationEvent } from '../../core/domain';
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
  readonly source: SourceRead | null;
  readonly error: string | null;
}

/**
 * One source activity in a project: the learner uploaded or selected
 * a source (re-selecting the same one included), or a source became
 * active. Every activity is a new object, so a reader sees each one even when
 * the active source did not change.
 */
export interface SourceActivity {
  readonly projectId: string;
}

export interface SourceFileSelectionOptions {
  readonly append?: boolean;
  readonly autoUpload?: boolean;
}

export type UploadPatch = Partial<Omit<SourceUploadItem, 'id' | 'file'>>;
export type TerminalUploadStatus = 'uploaded' | 'failed' | 'canceled';
export type OperationRequestOutcome =
  | { readonly ok: true; readonly operation: SourceOperationRead }
  | { readonly ok: false; readonly error: unknown };

export interface UploadTransportRun {
  readonly projectId: string;
  readonly contextEpoch: number;
  readonly itemIds: string[];
  readonly sources: SourceRead[];
  readonly done: Observable<void>;
}

export type UploadResumeResult =
  | { readonly kind: 'current-run' }
  | { readonly kind: 'new-run'; readonly run: UploadTransportRun };

export interface SourceUploadLifecycleHooks {
  readonly item: (itemId: string) => SourceUploadItem | undefined;
  readonly current: (projectId: string, contextEpoch: number) => boolean;
  readonly patch: (itemId: string, patch: UploadPatch) => boolean;
  readonly accept: (source: SourceRead, operationId: string) => void;
  readonly upload: (
    projectId: string,
    item: SourceUploadItem,
    operationId: string,
    signal: AbortSignal,
  ) => Observable<SourceRead>;
  readonly getSource: (
    projectId: string,
    sourceId: string,
  ) => Observable<SourceRead>;
  readonly getOperation: (
    projectId: string,
    operationId: string,
  ) => Observable<SourceOperationRead>;
  readonly streamOperation: (
    projectId: string,
    operationId: string,
  ) => Observable<SourceOperationEvent>;
  readonly cancelOperation: (
    projectId: string,
    operationId: string,
  ) => Observable<SourceOperationRead>;
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
  cancellationSubscription: Subscription | null;
  run: MutableUploadRun;
  sourceId: string | null;
  source: SourceRead | null;
  cancelRequested: boolean;
  slotHeld: boolean;
}

export interface DetachedOperationTombstoneHooks {
  readonly getOperation: (
    projectId: string,
    operationId: string,
  ) => Observable<SourceOperationRead>;
  readonly cancelOperation: (
    projectId: string,
    operationId: string,
  ) => Observable<SourceOperationRead>;
  readonly streamOperation: (
    projectId: string,
    operationId: string,
  ) => Observable<SourceOperationEvent>;
}

export interface DetachedTombstone {
  readonly key: string;
  readonly projectId: string;
  readonly operationId: string;
  subscription: Subscription | null;
}

export function namedSourceLanguage(language: string): string | undefined {
  switch (language) {
    case 'ja':
      return 'Japanese';
    case 'zh-Hant':
      return 'Traditional Chinese';
    case 'zh-Hans':
      return 'Simplified Chinese';
    case 'en':
      return 'English';
    default:
      return undefined;
  }
}
