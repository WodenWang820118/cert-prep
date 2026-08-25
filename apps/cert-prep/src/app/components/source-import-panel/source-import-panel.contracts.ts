import type { ChunkRead, DocumentRead } from '../../contracts/api.contracts';
import type {
  LanguageHint,
  SourceUploadItem,
} from '../../stores/source-import/contracts/source-import.contracts';

export type SourceImportAction =
  | { readonly type: 'choose-files'; readonly files: readonly File[] }
  | { readonly type: 'set-language'; readonly value: LanguageHint }
  | { readonly type: 'set-crop-images'; readonly enabled: boolean }
  | { readonly type: 'upload' }
  | { readonly type: 'cancel-upload'; readonly itemId: string }
  | { readonly type: 'retry-upload'; readonly itemId: string }
  | { readonly type: 'select-document'; readonly documentId: string }
  | { readonly type: 'cancel-processing' }
  | { readonly type: 'retry-processing' }
  | { readonly type: 'retry-progress' }
  | { readonly type: 'retry-audio' }
  | { readonly type: 'update-transcript'; readonly chunkId: string; readonly text: string }
  | { readonly type: 'translate-transcript'; readonly chunkId: string }
  | { readonly type: 'translate-stale-transcript' }
  | { readonly type: 'show-more-evidence' }
  | { readonly type: 'crop-applied'; readonly file: File }
  | { readonly type: 'keep-original-image' };

export interface SourceUploadQueueViewModel {
  readonly accept: string;
  readonly items: readonly SourceUploadItem[];
  readonly selectedFileLabel: string;
  readonly canUpload: boolean;
  readonly uploadBusy: boolean;
  readonly fileSelectionBlocked: boolean;
  readonly cropImagesBeforeUpload: boolean;
  readonly languageHint: LanguageHint;
  readonly languageHints: readonly LanguageHint[];
  readonly operationError: string | null;
}

export interface SourceDocumentStatusViewModel {
  readonly documents: readonly DocumentRead[];
  readonly activeDocumentId: string | null;
  readonly document: DocumentRead | null;
  readonly streamError: string | null;
  readonly cancelBusy: boolean;
  readonly retryBusy: boolean;
}

export interface SourceAudioPreviewViewModel {
  readonly url: string | null;
  readonly loading: boolean;
  readonly error: string | null;
}

export interface SourceEvidenceViewModel {
  readonly document: DocumentRead | null;
  readonly chunks: readonly ChunkRead[];
  readonly hiddenChunkCount: number;
  readonly audio: SourceAudioPreviewViewModel;
  readonly transcriptMutationBusy: boolean;
}
