import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { ChunkRead, DocumentRead, CERT_PREP_API } from '../../cert-prep-api';
import type {
  DocumentParsingMetric,
  LanguageHint,
  SourceUploadItem,
} from './contracts/source-import.contracts';
import { DocumentParsingMetricsService } from './document-parsing-metrics.service';
import { DocumentLibraryStore } from './document-library.store';
import { HealthStore } from '../health/health.store';
import type { RuntimeInstallationView } from '../health/contracts/health-runtime.contracts';
import { OperationStore } from '../operation.store';
import { ProjectStore } from '../project.store';
import {
  SourceUploadLifecycle,
  type UploadTransportRun,
} from './source-upload-lifecycle';

const DOCUMENT_POLL_INTERVAL_MS = 1500;
const FIRST_CHUNK_POLL_INTERVAL_MS = 500;
const POLL_RETRY_DELAYS_MS = [1000, 2000, 4000] as const;
const DEFAULT_UPLOAD_BATCH_SIZE = 2;
const MIN_UPLOAD_BATCH_SIZE = 1;
const MAX_UPLOAD_BATCH_SIZE = 4;
const SOURCE_FILE_ACCEPT =
  '.pdf,.png,.jpg,.jpeg,.webp,.mp3,.wav,.m4a,application/pdf,image/png,image/jpeg,image/webp,audio/mpeg,audio/wav,audio/mp4';
const SUPPORTED_SOURCE_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/x-m4a',
]);
const SUPPORTED_SOURCE_FILE_EXTENSIONS = [
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.mp3',
  '.wav',
  '.m4a',
] as const;
const FINAL_DOCUMENT_STATUSES = new Set([
  'ready',
  'exam_failed',
  'no_text_detected',
  'ocr_failed',
  'transcription_failed',
  'canceled',
]);
const TRANSCRIPT_MUTATION_ACTIONS = [
  'transcript-edit',
  'transcript-translate',
  'transcript-translate-all',
] as const;

export interface SourceFileSelectionOptions {
  readonly append?: boolean;
  readonly autoUpload?: boolean;
}

@Injectable({ providedIn: 'root' })
export class SourceImportStore {
  private readonly api = inject(CERT_PREP_API);
  private readonly library = inject(DocumentLibraryStore);
  private readonly health = inject(HealthStore);
  private readonly metrics = inject(DocumentParsingMetricsService);
  private readonly operations = inject(OperationStore);
  private readonly projects = inject(ProjectStore);
  private documentPollTimer: ReturnType<typeof setTimeout> | null = null;
  private documentPollFailureCount = 0;
  private contextEpoch = 0;
  private uploadItemCounter = 0;
  private readonly pendingAutoUploadItemIds = new Set<string>();
  private readonly pendingAutoUploadRevision = signal(0);
  private autoUploadEnqueueScheduled = false;
  private whisperAuthorizationReconcileScheduled = false;
  private whisperAuthorizationAwaitingRuntime = false;
  private whisperConsentObserved = false;
  private whisperRuntimeInstallAtAuthorization: RuntimeInstallationView | null =
    null;
  private readonly uploadLifecycle = new SourceUploadLifecycle({
    item: (itemId) =>
      this.uploadItems().find((candidate) => candidate.id === itemId),
    current: (projectId, contextEpoch) =>
      this.isCurrentUploadContext(projectId, contextEpoch),
    patch: (itemId, patch) => this.updateUploadItem(itemId, patch),
    accept: (document, pollDocument) =>
      this.acceptLifecycleDocument(document, pollDocument),
    upload: (projectId, item, operationId, signal) => {
      const formData = new FormData();
      formData.append('file', item.file, item.file.name);
      formData.append('language_hint', this.languageHint());
      return this.api.uploadDocument(projectId, formData, {
        headers: { 'X-Cert-Prep-Operation-Id': operationId },
        signal,
      });
    },
    getDocument: (projectId, documentId) =>
      this.api.getDocument(projectId, documentId),
    getOperation: (projectId, operationId) =>
      this.api.getDocumentOperation(projectId, operationId),
    cancelOperation: (projectId, operationId) =>
      this.api.cancelDocumentOperation(projectId, operationId),
    newOperationId: () => this.newOperationId(),
    errorMessage: (error) => this.getUploadErrorMessage(error),
    errorCode: (error) => this.getUploadErrorCode(error),
  });

  readonly languageHints: readonly LanguageHint[] = [
    'auto',
    'ja',
    'zh-Hant',
    'zh-Hans',
    'en',
    'mixed',
  ];
  readonly uploadBatchSizes = [1, 2, 3, 4] as const;
  readonly sourceFileAccept = SOURCE_FILE_ACCEPT;
  readonly languageHint = signal<LanguageHint>('auto');
  readonly uploadBatchSize = signal(DEFAULT_UPLOAD_BATCH_SIZE);
  readonly uploadItems = signal<SourceUploadItem[]>([]);
  readonly pollingError = signal<string | null>(null);
  readonly selectedFiles = computed(() =>
    this.uploadItems().map((item) => item.file),
  );
  readonly selectedFile = computed(() => this.selectedFiles()[0] ?? null);
  readonly hasSelectedAudio = computed(() =>
    this.uploadItems().some((item) => this.isAudioSourceFile(item.file)),
  );
  readonly whisperModelsRequirement = this.health.whisperModelsRequirement;
  readonly whisperModelsReady = this.health.areWhisperModelsReady;
  readonly whisperModelInstall = computed(() => {
    const install = this.health.runtimeInstall();
    return install?.kind === 'whisper_models' ? install : null;
  });
  readonly canCancelWhisperModelDownload = computed(
    () =>
      this.whisperModelInstall() !== null &&
      this.health.canCancelRuntimeInstallation(),
  );
  readonly isUploading = computed(() =>
    this.uploadItems().some((item) =>
      ['uploading', 'cancel_requested'].includes(item.status),
    ),
  );
  readonly pendingUploadCount = computed(
    () =>
      this.uploadItems().filter((item) =>
        ['queued', 'failed'].includes(item.status),
      ).length,
  );
  readonly uploadedFileCount = computed(
    () =>
      this.uploadItems().filter((item) => item.status === 'uploaded').length,
  );
  readonly failedUploadCount = computed(
    () =>
      this.uploadItems().filter((item) =>
        ['failed', 'status_unavailable'].includes(item.status),
      ).length,
  );
  readonly isTranscriptMutationBusy = computed(() =>
    this.operations.isBusyFor(TRANSCRIPT_MUTATION_ACTIONS),
  );
  readonly selectedFileLabel = computed(() => {
    const files = this.selectedFiles();
    if (files.length === 0) {
      return this.activeDocument()?.filename ?? 'No source file selected';
    }
    if (files.length === 1) {
      return files[0]?.name ?? 'No source file selected';
    }
    return `${files.length} files selected`;
  });
  readonly documents = this.library.documents;
  readonly activeDocumentId = this.library.activeDocumentId;
  readonly uploadedDocument = this.library.uploadedDocument;
  readonly chunks = this.library.chunks;
  readonly visibleChunkLimit = this.library.visibleChunkLimit;
  readonly activeDocument = this.library.activeDocument;
  readonly activeDocumentSelectValue = this.library.activeDocumentSelectValue;
  readonly previewChunks = this.library.previewChunks;
  readonly hiddenChunkCount = this.library.hiddenChunkCount;
  readonly isParsing = computed(() =>
    ['processing', 'cancel_requested'].includes(
      this.activeDocument()?.status ?? '',
    ),
  );
  readonly progressPercent = computed(() =>
    this.metrics.progressPercent(this.activeDocument()),
  );
  readonly progressLabel = computed(() =>
    this.metrics.progressLabel(this.activeDocument()),
  );
  readonly parseStageText = computed(() => {
    const document = this.activeDocument();
    if (document === null) {
      return 'No source file uploaded.';
    }
    if (document.source_kind === 'audio') {
      if (document.status === 'processing') {
        return document.transcription_status === 'succeeded'
          ? 'Japanese transcription complete; translating to Traditional Chinese.'
          : 'Transcribing Japanese audio.';
      }
      if (document.status === 'cancel_requested') {
        return 'Cancel requested; waiting for the audio processing checkpoint.';
      }
      if (document.status === 'canceled') {
        return 'Audio processing canceled. The original source file is retained and can be retried.';
      }
      if (document.status === 'transcription_failed') {
        return 'Japanese transcription failed. The original source file is retained and can be retried.';
      }
      if (document.status === 'ready') {
        return document.translation_status === 'failed'
          ? 'Japanese transcription is ready; Traditional Chinese translation failed and can be retried.'
          : 'Japanese transcription and Traditional Chinese translation complete.';
      }
      return 'Audio processing needs attention.';
    }
    if (document.status === 'processing') {
      return document.chunks_count > 0
        ? 'Parsing continues; completed chunks are already available.'
        : 'Parsing started; waiting for the first completed page.';
    }
    if (document.status === 'cancel_requested') {
      return 'Cancel requested; waiting for the active parser checkpoint.';
    }
    if (document.status === 'canceled') {
      return 'Parsing canceled. The original source file is retained and can be retried.';
    }
    if (document.status === 'ready') {
      return 'Parsing complete.';
    }
    if (document.status === 'ocr_failed') {
      return 'OCR failed before the document could be completed.';
    }
    if (document.status === 'no_text_detected') {
      return 'Parsing finished, but no text was detected.';
    }
    return 'Question generation needs attention.';
  });
  readonly elapsedTime = computed(() =>
    this.metrics.elapsedTime(this.activeDocument()),
  );
  readonly canUpload = computed(
    () =>
      this.projects.selectedProject() !== null &&
      this.uploadItems().some(
        (item) =>
          ['queued', 'failed'].includes(item.status) &&
          (this.isUploadItemReady(item) ||
            (this.isAudioSourceFile(item.file) &&
              !this.isPendingAutoUpload(item.id))),
      ) &&
      !this.isUploading(),
  );
  readonly canGenerateDrafts = computed(() => {
    const document = this.activeDocument();
    return (
      this.projects.selectedProject() !== null &&
      document !== null &&
      document.has_text &&
      document.chunks_count > 0
    );
  });

  constructor() {
    effect(() => {
      this.whisperModelsReady();
      this.health.runtimeInstallConsentKind();
      this.health.runtimeInstall();
      this.health.healthSnapshotLoading();
      this.scheduleWhisperAuthorizationReconciliation();
    });
  }

  chooseFile(
    file: File | null,
    options: SourceFileSelectionOptions = {},
  ): void {
    this.chooseFiles(file === null ? [] : [file], options);
  }

  chooseFiles(
    files: readonly File[],
    options: SourceFileSelectionOptions = {},
  ): void {
    const supportedFiles = files.filter((file) =>
      this.isSupportedSourceFile(file),
    );
    const rejectedFiles = files.filter(
      (file) => !this.isSupportedSourceFile(file),
    );

    const nextItems: SourceUploadItem[] = supportedFiles.map((file) => ({
      id: `source-upload-${++this.uploadItemCounter}`,
      file,
      status: 'queued',
      document: null,
      error: null,
    }));
    const appendSelection = options.append ?? this.shouldAppendNewSelection();
    const autoUpload = options.autoUpload ?? appendSelection;
    if (appendSelection) {
      this.uploadItems.update((items) => [...items, ...nextItems]);
    } else {
      this.invalidateUploadContext();
      this.uploadItems.set(nextItems);
      this.library.clearActiveDocument();
      this.stopDocumentPolling();
      this.resetDocumentPollingFailure();
    }
    if (autoUpload) {
      this.rememberPendingAutoUploads(nextItems.map((item) => item.id));
      this.startReadyAutoUploads();
    }
    if (this.hasPendingAudioUpload()) {
      void (autoUpload
        ? this.preflightAuthorizedWhisperModels()
        : this.preflightWhisperModels());
    } else if (
      this.health.runtimeInstallConsentKind() === 'whisper_models' &&
      !this.health.runtimeInstallStarting()
    ) {
      this.health.cancelRuntimeInstallConsent();
    }
    this.operations.error.set(null);
    this.operations.errorCode.set(null);
    if (rejectedFiles.length > 0) {
      const rejectedNames = rejectedFiles
        .map((file) => file.name || '(unnamed file)')
        .join(', ');
      const skippedLabel =
        rejectedFiles.length === 1
          ? 'Unsupported source file was skipped'
          : 'Unsupported source files were skipped';
      this.operations.fail(
        `${skippedLabel}: ${rejectedNames}. Supported formats: PDF, PNG, JPEG, WebP, MP3, WAV, and M4A.`,
      );
    }
  }

  shouldAppendNewSelection(): boolean {
    return (
      this.uploadLifecycle.hasActiveRun() ||
      this.uploadItems().some((item) => item.status === 'status_unavailable')
    );
  }

  reset(): void {
    this.invalidateUploadContext();
    this.uploadItems.set([]);
    this.library.reset();
    this.resetDocumentPollingFailure();
  }

  setLanguageHint(value: string): void {
    const next = this.languageHints.includes(value as LanguageHint)
      ? (value as LanguageHint)
      : 'auto';
    this.languageHint.set(next);
  }

  setUploadBatchSize(value: number | string): void {
    const parsed = Number(value);
    const normalized = Number.isFinite(parsed)
      ? Math.trunc(parsed)
      : DEFAULT_UPLOAD_BATCH_SIZE;
    this.uploadBatchSize.set(
      Math.min(MAX_UPLOAD_BATCH_SIZE, Math.max(MIN_UPLOAD_BATCH_SIZE, normalized)),
    );
  }

  showMoreChunks(): void {
    this.library.showMoreChunks();
  }

  parsingMetrics(document: DocumentRead): DocumentParsingMetric[] {
    return this.metrics.parsingMetrics(document);
  }

  async uploadDocument(): Promise<DocumentRead | null> {
    const documents = await this.uploadDocuments();
    return documents.length > 0 ? documents[documents.length - 1] : null;
  }

  async uploadDocuments(): Promise<DocumentRead[]> {
    const project = this.projects.selectedProject();
    let uploadItems = this.uploadItems().filter((item) =>
      ['queued', 'failed'].includes(item.status),
    );
    if (project === null) {
      this.operations.fail(
        'Choose a project and one or more source files before uploading.',
      );
      return [];
    }
    if (uploadItems.length === 0) {
      if (!this.uploadLifecycle.hasActiveRun()) {
        this.operations.fail(
          'Choose a project and one or more source files before uploading.',
        );
      }
      return [];
    }
    this.rememberPendingAutoUploads(uploadItems.map((item) => item.id));
    const pendingAudioNeedsModels = uploadItems.some(
      (item) => this.isAudioSourceFile(item.file) && !this.whisperModelsReady(),
    );
    let readyItems = uploadItems.filter((item) => this.isUploadItemReady(item));
    if (readyItems.length === 0 && pendingAudioNeedsModels) {
      await this.preflightAuthorizedWhisperModels();
      uploadItems = this.uploadItems().filter((item) =>
        ['queued', 'failed'].includes(item.status),
      );
      readyItems = uploadItems.filter((item) => this.isUploadItemReady(item));
    } else if (pendingAudioNeedsModels) {
      void this.preflightAuthorizedWhisperModels();
    }
    if (readyItems.length === 0) {
      if (
        uploadItems.some((item) => !this.isAudioSourceFile(item.file)) &&
        this.health.isOcrHealthLoading()
      ) {
        this.operations.fail(
          'OCR runtime is warming up. Try again when runtime health finishes.',
        );
      }
      return [];
    }

    for (const item of readyItems) {
      if (item.status === 'failed') {
        this.updateUploadItem(item.id, { status: 'queued', error: null });
      }
    }
    const itemIds = readyItems.map((item) => item.id);
    if (this.uploadLifecycle.hasActiveRun()) {
      this.forgetPendingAutoUploads(itemIds);
      this.uploadLifecycle.begin(
        project.id,
        this.contextEpoch,
        itemIds,
        this.uploadBatchSize(),
      );
      return [];
    }
    if (this.operations.isBusyFor('upload')) {
      return [];
    }
    this.forgetPendingAutoUploads(itemIds);
    return this.runUploadTransports(project.id, itemIds);
  }

  private async runUploadTransports(
    projectId: string,
    itemIds: readonly string[],
  ): Promise<DocumentRead[]> {
    const run = this.uploadLifecycle.begin(
      projectId,
      this.contextEpoch,
      itemIds,
      this.uploadBatchSize(),
    );
    return this.finishUploadTransports(projectId, run);
  }

  private async finishUploadTransports(
    projectId: string,
    run: UploadTransportRun,
  ): Promise<DocumentRead[]> {
    const result = await this.operations.run(
      'upload',
      (documents) => this.uploadOutcomeMessage(run.itemIds, documents),
      async () => {
        await run.done;
        return [...run.documents];
      },
      () => this.isCurrentUploadContext(projectId, run.contextEpoch),
    );
    if (!this.isCurrentUploadContext(projectId, run.contextEpoch)) {
      return [];
    }
    if (run.runtimePromptNeeded) {
      await this.refreshRuntimeHealth();
      if (this.isCurrentUploadContext(projectId, run.contextEpoch)) {
        this.health.openOcrRuntimeInstallConsent();
      }
    }

    const documents = result ?? [];
    const activeDocument = documents[documents.length - 1] ?? null;
    if (activeDocument !== null) {
      this.setActiveDocument(activeDocument);
      await this.refreshUploadedDocument(projectId, activeDocument.id);
    }

    const failedCount = this.failedUploadCount();
    if (failedCount > 0) {
      this.operations.error.set(
        failedCount === 1
          ? '1 source file failed to upload.'
          : `${failedCount} source files failed to upload.`,
      );
    }
    this.startReadyAutoUploads();
    return documents;
  }

  private uploadOutcomeMessage(
    itemIds: readonly string[],
    documents: readonly DocumentRead[],
  ): string {
    const acceptedCount = documents.length;
    const incompleteCount = Math.max(0, itemIds.length - acceptedCount);
    if (acceptedCount > 0) {
      const accepted =
        acceptedCount === 1
          ? '1 source file uploaded'
          : `${acceptedCount} source files uploaded`;
      return incompleteCount === 0
        ? accepted
        : `${accepted}; ${incompleteCount} did not complete`;
    }
    const itemIdSet = new Set(itemIds);
    const items = this.uploadItems().filter((item) => itemIdSet.has(item.id));
    if (
      items.length === itemIds.length &&
      items.every((item) => item.status === 'canceled')
    ) {
      return itemIds.length === 1
        ? 'Source file upload canceled'
        : `${itemIds.length} source file uploads canceled`;
    }
    return itemIds.length === 1
      ? 'Source file upload did not complete'
      : 'No source file uploads completed';
  }

  async loadLatestDocument(projectId: string): Promise<void> {
    const documents = await this.api.listDocuments(projectId);
    this.library.setDocuments(documents.items);
    const activeDocument = this.library.chooseActiveFromDocuments();
    this.setActiveDocument(activeDocument);
    if (activeDocument === null) {
      this.chunks.set([]);
      this.stopDocumentPolling();
      return;
    }
    await this.refreshUploadedDocument(projectId, activeDocument.id);
  }

  setActiveDocumentId(documentId: string | null): void {
    if (this.library.setActiveDocumentId(documentId)) {
      this.stopDocumentPolling();
      this.resetDocumentPollingFailure();
    }
  }

  async selectDocument(documentId: string): Promise<void> {
    const projectId = this.projects.selectedProject()?.id;
    const previousDocumentId = this.activeDocumentId();
    this.setActiveDocumentId(documentId);
    if (projectId === undefined || this.activeDocumentId() !== documentId) {
      return;
    }
    if (previousDocumentId !== documentId) {
      this.library.clearChunks();
      this.stopDocumentPolling();
    }

    await this.refreshUploadedDocument(projectId, documentId);
  }

  async refreshUploadedDocument(
    projectId?: string,
    documentId?: string,
  ): Promise<void> {
    const project = projectId ?? this.projects.selectedProject()?.id;
    const document =
      documentId ?? this.activeDocumentId() ?? this.activeDocument()?.id;
    if (project === undefined || document === undefined) {
      return;
    }
    if (documentId !== undefined && this.activeDocumentId() !== documentId) {
      this.activeDocumentId.set(documentId);
    }

    try {
      const [nextDocument, chunks] = await Promise.all([
        this.api.getDocument(project, document),
        this.loadDocumentChunks(project, document),
      ]);
      this.library.upsertDocument(nextDocument);
      if (!this.isCurrentProjectDocument(project, document)) {
        return;
      }
      this.setActiveDocument(nextDocument);
      this.library.setChunks(chunks);
      this.updateUploadDocumentSnapshot(nextDocument);
      this.resetDocumentPollingFailure();
      if (
        ['processing', 'cancel_requested'].includes(nextDocument.status)
      ) {
        this.scheduleDocumentPolling(project, document);
      } else {
        this.stopDocumentPolling();
      }
    } catch {
      this.handleDocumentPollingFailure(project, document);
    }
  }

  retryDocumentPolling(): void {
    const projectId = this.projects.selectedProject()?.id;
    const documentId = this.activeDocumentId();
    if (projectId === undefined || documentId === null) {
      return;
    }

    this.resetDocumentPollingFailure();
    void this.refreshUploadedDocument(projectId, documentId);
  }

  canCancelUploadItem(item: SourceUploadItem): boolean {
    return (
      ['queued', 'uploading', 'cancel_requested'].includes(item.status) ||
      (item.status === 'uploaded' &&
        ['processing', 'cancel_requested'].includes(item.document?.status ?? ''))
    );
  }

  canRetryUploadItem(item: SourceUploadItem): boolean {
    return (
      item.status === 'status_unavailable' ||
      (item.document === null && ['failed', 'canceled'].includes(item.status))
    );
  }

  async cancelUploadItem(itemId: string): Promise<void> {
    const projectId = this.projects.selectedProject()?.id;
    const item = this.uploadItems().find((candidate) => candidate.id === itemId);
    if (
      projectId === undefined ||
      item === undefined ||
      !this.canCancelUploadItem(item)
    ) {
      return;
    }

    if (['queued', 'uploading', 'cancel_requested'].includes(item.status)) {
      this.uploadLifecycle.cancel(item.id);
      return;
    }
    const document = item.document;
    if (document === null) {
      return;
    }

    this.updateUploadItem(item.id, {
      status: 'cancel_requested',
      error: null,
    });
    try {
      await this.api.cancelDocumentProcessing(projectId, document.id);
      this.updateUploadItem(item.id, { status: 'canceled', error: null });
      await this.refreshUploadedDocument(projectId, document.id);
    } catch (error) {
      this.updateUploadItem(item.id, {
        status: 'failed',
        error: this.getUploadErrorMessage(error),
      });
    }
  }

  async retryUploadItem(itemId: string): Promise<void> {
    const projectId = this.projects.selectedProject()?.id;
    const item = this.uploadItems().find((candidate) => candidate.id === itemId);
    if (
      projectId === undefined ||
      item === undefined ||
      !this.canRetryUploadItem(item)
    ) {
      return;
    }
    if (item.status === 'status_unavailable') {
      const resumed = this.uploadLifecycle.resume(item.id);
      if (resumed?.kind === 'new-run') {
        await this.finishUploadTransports(projectId, resumed.run);
      }
      return;
    }
    if (this.isAudioSourceFile(item.file) && !this.whisperModelsReady()) {
      this.rememberPendingAutoUploads([item.id]);
      if (!(await this.preflightAuthorizedWhisperModels())) {
        return;
      }
    } else if (
      !this.isAudioSourceFile(item.file) &&
      this.health.isOcrHealthLoading()
    ) {
      this.operations.fail(
        'OCR runtime is warming up. Try again when runtime health finishes.',
      );
      return;
    }
    this.rememberPendingAutoUploads([item.id]);
    if (!this.updateUploadItem(item.id, { status: 'queued', error: null })) {
      this.forgetPendingAutoUploads([item.id]);
      return;
    }
    if (this.uploadLifecycle.hasActiveRun()) {
      this.forgetPendingAutoUploads([item.id]);
      this.uploadLifecycle.begin(
        projectId,
        this.contextEpoch,
        [item.id],
        this.uploadBatchSize(),
      );
      return;
    }
    if (this.operations.isBusyFor('upload')) {
      return;
    }
    this.forgetPendingAutoUploads([item.id]);
    await this.runUploadTransports(projectId, [item.id]);
  }

  async cancelActiveDocumentProcessing(): Promise<void> {
    const projectId = this.projects.selectedProject()?.id;
    const document = this.activeDocument();
    if (
      projectId === undefined ||
      document === null ||
      !['processing', 'cancel_requested'].includes(document.status)
    ) {
      return;
    }
    const canceled = await this.operations.run(
      'document-cancel',
      'Parsing cancellation requested',
      () => this.api.cancelDocumentProcessing(projectId, document.id),
    );
    if (canceled !== null) {
      await this.refreshUploadedDocument(projectId, document.id);
    }
  }

  async retryActiveDocumentProcessing(): Promise<void> {
    const projectId = this.projects.selectedProject()?.id;
    const document = this.activeDocument();
    if (
      projectId === undefined ||
      document === null ||
      ![
        'canceled',
        'ocr_failed',
        'transcription_failed',
        'no_text_detected',
        'exam_failed',
      ].includes(document.status)
    ) {
      return;
    }
    const retried = await this.operations.run(
      'document-retry',
      'Parsing restarted',
      () => this.api.retryDocumentProcessing(projectId, document.id),
    );
    if (retried !== null) {
      this.resetDocumentPollingFailure();
      await this.refreshUploadedDocument(projectId, document.id);
    }
  }

  async updateTranscriptChunk(chunkId: string, text: string): Promise<void> {
    const projectId = this.projects.selectedProject()?.id;
    const documentId = this.activeDocumentId();
    if (
      projectId === undefined ||
      documentId === null ||
      this.isTranscriptMutationBusy()
    ) {
      return;
    }
    const updated = await this.operations.run(
      'transcript-edit',
      'Japanese transcript saved',
      () => this.api.updateDocumentChunk(projectId, documentId, chunkId, { text }),
      () => this.isCurrentProjectDocument(projectId, documentId),
    );
    if (
      updated !== null &&
      this.isCurrentProjectDocument(projectId, documentId)
    ) {
      this.library.setChunks(
        this.chunks().map((chunk) =>
          chunk.id === chunkId ? updated : chunk,
        ),
      );
      await this.refreshDocumentMetadata(projectId, documentId);
    }
  }

  async translateTranscriptChunk(chunkId: string): Promise<void> {
    const projectId = this.projects.selectedProject()?.id;
    const documentId = this.activeDocumentId();
    if (
      projectId === undefined ||
      documentId === null ||
      this.isTranscriptMutationBusy()
    ) {
      return;
    }
    const translated = await this.operations.run(
      'transcript-translate',
      'Traditional Chinese translation updated',
      () => this.api.translateDocumentChunk(projectId, documentId, chunkId),
      () => this.isCurrentProjectDocument(projectId, documentId),
    );
    if (
      translated !== null &&
      this.isCurrentProjectDocument(projectId, documentId)
    ) {
      this.library.setChunks(
        this.chunks().map((chunk) =>
          chunk.id === chunkId ? translated : chunk,
        ),
      );
      await this.refreshDocumentMetadata(projectId, documentId);
    }
  }

  async translateStaleTranscriptChunks(): Promise<void> {
    const projectId = this.projects.selectedProject()?.id;
    const documentId = this.activeDocumentId();
    if (
      projectId === undefined ||
      documentId === null ||
      this.isTranscriptMutationBusy()
    ) {
      return;
    }
    const translated = await this.operations.run(
      'transcript-translate-all',
      'Stale translations updated',
      () => this.api.translateDocumentStaleChunks(projectId, documentId),
      () => this.isCurrentProjectDocument(projectId, documentId),
    );
    if (
      translated !== null &&
      this.isCurrentProjectDocument(projectId, documentId)
    ) {
      const byId = new Map(translated.items.map((chunk) => [chunk.id, chunk]));
      this.library.setChunks(
        this.chunks().map((chunk) => byId.get(chunk.id) ?? chunk),
      );
      await this.refreshDocumentMetadata(projectId, documentId);
    }
  }

  private async refreshDocumentMetadata(
    projectId: string,
    documentId: string,
  ): Promise<void> {
    let document: DocumentRead;
    try {
      document = await this.api.getDocument(projectId, documentId);
    } catch (error) {
      console.warn(
        'Unable to refresh document metadata after a transcript mutation.',
        error,
      );
      // The successful chunk mutation remains visible; normal refresh/polling
      // reconciles document-level status when the backend is available again.
      return;
    }
    if (!this.isCurrentProjectDocument(projectId, documentId)) {
      return;
    }
    this.library.upsertDocument(document);
    this.setActiveDocument(document);
    this.updateUploadDocumentSnapshot(document);
  }

  private async loadDocumentChunks(
    projectId: string,
    documentId: string,
  ): Promise<ChunkRead[]> {
    const chunks = await this.api.listDocumentChunks(projectId, documentId);
    return chunks.items;
  }

  private isSupportedSourceFile(file: File): boolean {
    const mimeType = file.type.trim().toLowerCase();
    if (SUPPORTED_SOURCE_MIME_TYPES.has(mimeType)) {
      return true;
    }

    const filename = file.name.toLowerCase();
    return SUPPORTED_SOURCE_FILE_EXTENSIONS.some((extension) =>
      filename.endsWith(extension),
    );
  }

  async cancelWhisperModelDownload(): Promise<void> {
    await this.health.cancelRuntimeInstallation();
  }

  private async preflightWhisperModels(): Promise<boolean> {
    if (!this.hasPendingAudioUpload()) {
      return true;
    }
    if (this.whisperModelsReady()) {
      return true;
    }
    if (this.whisperModelsRequirement() === null) {
      try {
        await this.health.refreshRuntimeRequirements();
      } catch {
        if (!this.hasPendingAudioUpload()) {
          return true;
        }
        this.operations.fail(
          'Whisper model status is unavailable. Refresh runtime health before uploading audio.',
        );
        return false;
      }
    }
    if (!this.hasPendingAudioUpload()) {
      return true;
    }
    if (this.whisperModelsReady()) {
      return true;
    }
    if (this.health.areWhisperModelsMissing()) {
      this.health.openWhisperModelsConsent();
      this.operations.status.set(
        'Whisper model download consent is required before audio upload.',
      );
      return false;
    }
    this.operations.fail(
      'Whisper model status is unavailable. Refresh runtime health before uploading audio.',
    );
    return false;
  }

  private async preflightAuthorizedWhisperModels(): Promise<boolean> {
    const ready = await this.preflightWhisperModels();
    if (!ready) {
      this.beginWhisperRuntimeAuthorizationWait();
    }
    return ready;
  }

  private hasPendingAudioUpload(): boolean {
    return this.uploadItems().some(
      (item) =>
        ['queued', 'failed'].includes(item.status) &&
        this.isAudioSourceFile(item.file),
    );
  }

  private isAudioSourceFile(file: File): boolean {
    const mimeType = file.type.trim().toLowerCase();
    if (
      mimeType === 'audio/mpeg' ||
      mimeType === 'audio/wav' ||
      mimeType === 'audio/x-wav' ||
      mimeType === 'audio/mp4' ||
      mimeType === 'audio/x-m4a'
    ) {
      return true;
    }
    return ['.mp3', '.wav', '.m4a'].some((extension) =>
      file.name.toLowerCase().endsWith(extension),
    );
  }

  private isUploadItemReady(item: SourceUploadItem): boolean {
    return this.isAudioSourceFile(item.file)
      ? this.whisperModelsReady()
      : !this.health.isOcrHealthLoading();
  }

  private scheduleReadyAutoUploads(): void {
    if (this.autoUploadEnqueueScheduled) {
      return;
    }
    this.autoUploadEnqueueScheduled = true;
    queueMicrotask(() => {
      this.autoUploadEnqueueScheduled = false;
      this.startReadyAutoUploads();
    });
  }

  private beginWhisperRuntimeAuthorizationWait(): void {
    const hasAuthorizedAudio = this.uploadItems().some(
      (item) =>
        this.pendingAutoUploadItemIds.has(item.id) &&
        ['queued', 'failed'].includes(item.status) &&
        this.isAudioSourceFile(item.file),
    );
    if (!hasAuthorizedAudio) {
      return;
    }
    this.whisperAuthorizationAwaitingRuntime = true;
    this.whisperConsentObserved =
      this.health.runtimeInstallConsentKind() === 'whisper_models';
    this.whisperRuntimeInstallAtAuthorization = this.health.runtimeInstall();
    this.reconcileWhisperRuntimeAuthorization();
  }

  private scheduleWhisperAuthorizationReconciliation(): void {
    if (this.whisperAuthorizationReconcileScheduled) {
      return;
    }
    this.whisperAuthorizationReconcileScheduled = true;
    queueMicrotask(() => {
      this.whisperAuthorizationReconcileScheduled = false;
      this.reconcileWhisperRuntimeAuthorization();
    });
  }

  private reconcileWhisperRuntimeAuthorization(): void {
    if (!this.whisperAuthorizationAwaitingRuntime) {
      return;
    }
    const consentOpen =
      this.health.runtimeInstallConsentKind() === 'whisper_models';
    const install = this.health.runtimeInstall();
    const installAdvanced =
      install !== this.whisperRuntimeInstallAtAuthorization &&
      install?.kind === 'whisper_models';
    const installTerminalFailure =
      installAdvanced &&
      (install.phase === 'failed' || install.phase === 'canceled');
    const consentCanceled =
      this.whisperConsentObserved && !consentOpen && !installAdvanced;
    if (installTerminalFailure || consentCanceled) {
      this.releaseWhisperRuntimeAuthorization();
      return;
    }
    if (this.whisperModelsReady()) {
      this.resetWhisperRuntimeAuthorizationWait();
      this.scheduleReadyAutoUploads();
      return;
    }
    this.whisperConsentObserved ||= consentOpen;
    const installActive =
      install?.kind === 'whisper_models' &&
      [
        'starting',
        'running',
        'cancel_requested',
        'waiting_for_user',
      ].includes(install.phase);
    const succeededHealthRefreshActive =
      installAdvanced &&
      install.phase === 'succeeded' &&
      this.health.healthSnapshotLoading();
    if (consentOpen || installActive || succeededHealthRefreshActive) {
      return;
    }
    this.releaseWhisperRuntimeAuthorization();
  }

  private releaseWhisperRuntimeAuthorization(): void {
    const itemIds = this.uploadItems()
      .filter(
        (item) =>
          this.pendingAutoUploadItemIds.has(item.id) &&
          ['queued', 'failed'].includes(item.status) &&
          this.isAudioSourceFile(item.file),
      )
      .map((item) => item.id);
    this.resetWhisperRuntimeAuthorizationWait();
    this.forgetPendingAutoUploads(itemIds);
  }

  private resetWhisperRuntimeAuthorizationWait(): void {
    this.whisperAuthorizationAwaitingRuntime = false;
    this.whisperConsentObserved = false;
    this.whisperRuntimeInstallAtAuthorization = null;
  }

  private startReadyAutoUploads(): void {
    const projectId = this.projects.selectedProject()?.id;
    if (projectId === undefined) {
      return;
    }
    const readyItems = this.uploadItems().filter(
      (item) =>
        this.pendingAutoUploadItemIds.has(item.id) &&
        ['queued', 'failed'].includes(item.status) &&
        this.isUploadItemReady(item),
    );
    if (readyItems.length === 0) {
      return;
    }
    for (const item of readyItems) {
      if (item.status === 'failed') {
        this.updateUploadItem(item.id, { status: 'queued', error: null });
      }
    }
    const itemIds = readyItems.map((item) => item.id);
    if (this.uploadLifecycle.hasActiveRun()) {
      this.forgetPendingAutoUploads(itemIds);
      this.uploadLifecycle.begin(
        projectId,
        this.contextEpoch,
        itemIds,
        this.uploadBatchSize(),
      );
      return;
    }
    if (this.operations.isBusyFor('upload')) {
      return;
    }
    this.forgetPendingAutoUploads(itemIds);
    void this.runUploadTransports(projectId, itemIds);
  }

  private forgetPendingAutoUploads(itemIds: readonly string[]): void {
    let changed = false;
    for (const itemId of itemIds) {
      changed = this.pendingAutoUploadItemIds.delete(itemId) || changed;
    }
    if (changed) {
      this.pendingAutoUploadRevision.update((revision) => revision + 1);
    }
  }

  private rememberPendingAutoUploads(itemIds: readonly string[]): void {
    let changed = false;
    for (const itemId of itemIds) {
      if (!this.pendingAutoUploadItemIds.has(itemId)) {
        this.pendingAutoUploadItemIds.add(itemId);
        changed = true;
      }
    }
    if (changed) {
      this.pendingAutoUploadRevision.update((revision) => revision + 1);
    }
  }

  private isPendingAutoUpload(itemId: string): boolean {
    this.pendingAutoUploadRevision();
    return this.pendingAutoUploadItemIds.has(itemId);
  }

  private clearPendingAutoUploads(): void {
    if (this.pendingAutoUploadItemIds.size === 0) {
      return;
    }
    this.pendingAutoUploadItemIds.clear();
    this.pendingAutoUploadRevision.update((revision) => revision + 1);
  }

  private updateUploadItem(
    id: string,
    patch: Partial<Omit<SourceUploadItem, 'id' | 'file'>>,
  ): boolean {
    let updated = false;
    this.uploadItems.update((items) =>
      items.map((item) => {
        if (item.id !== id) {
          return item;
        }
        updated = true;
        return { ...item, ...patch };
      }),
    );
    if (
      patch.status !== undefined &&
      ['uploaded', 'failed', 'canceled'].includes(patch.status)
    ) {
      this.forgetPendingAutoUploads([id]);
    }
    return updated;
  }

  private acceptLifecycleDocument(
    document: DocumentRead,
    pollDocument: boolean,
  ): void {
    this.library.upsertDocument(document);
    this.setActiveDocument(document);
    this.updateUploadDocumentSnapshot(document);
    if (pollDocument && !FINAL_DOCUMENT_STATUSES.has(document.status)) {
      this.scheduleDocumentPolling(document.project_id, document.id);
    }
  }

  private updateUploadDocumentSnapshot(document: DocumentRead): void {
    this.uploadItems.update((items) =>
      items.map((item) =>
        item.document?.id === document.id ? { ...item, document } : item,
      ),
    );
  }

  private invalidateUploadContext(): void {
    this.contextEpoch += 1;
    this.resetWhisperRuntimeAuthorizationWait();
    this.clearPendingAutoUploads();
    this.stopDocumentPolling();
    this.uploadLifecycle.invalidate();
  }

  private isCurrentUploadContext(
    projectId: string,
    contextEpoch: number,
  ): boolean {
    return (
      this.contextEpoch === contextEpoch &&
      this.projects.selectedProject()?.id === projectId
    );
  }

  private setActiveDocument(document: DocumentRead | null): void {
    if (this.library.setActiveDocument(document)) {
      this.stopDocumentPolling();
    }
  }

  private async refreshRuntimeHealth(): Promise<void> {
    try {
      await this.health.load();
    } catch (error) {
      console.warn(
        'Unable to refresh runtime health before opening the OCR runtime prompt.',
        error,
      );
      // Keep the use-time prompt available even if the health refresh failed.
    }
  }

  private getUploadErrorMessage(error: unknown): string {
    const httpError = error as { error?: unknown; message?: unknown };
    if (this.hasMessage(httpError.error)) {
      return httpError.error.message;
    }

    if (typeof httpError.error === 'string' && httpError.error.length > 0) {
      return httpError.error;
    }

    if (typeof httpError.message === 'string' && httpError.message.length > 0) {
      return httpError.message;
    }

    return 'The local cert prep service did not complete the upload.';
  }

  private hasMessage(value: unknown): value is { message: string } {
    return (
      typeof value === 'object' &&
      value !== null &&
      'message' in value &&
      typeof (value as { message?: unknown }).message === 'string'
    );
  }

  private getUploadErrorCode(error: unknown): string | null {
    const httpError = error as { error?: unknown };
    if (
      typeof httpError.error === 'object' &&
      httpError.error !== null &&
      'code' in httpError.error &&
      typeof (httpError.error as { code?: unknown }).code === 'string'
    ) {
      return (httpError.error as { code: string }).code;
    }

    return null;
  }

  private scheduleDocumentPolling(projectId: string, documentId: string): void {
    this.stopDocumentPolling();
    this.documentPollTimer = setTimeout(() => {
      this.documentPollTimer = null;
      void this.pollDocument(projectId, documentId);
    }, this.documentPollIntervalMs());
  }

  private documentPollIntervalMs(): number {
    const document = this.activeDocument();
    return document?.status === 'processing' &&
      this.chunks().length === 0
      ? FIRST_CHUNK_POLL_INTERVAL_MS
      : DOCUMENT_POLL_INTERVAL_MS;
  }

  private async pollDocument(projectId: string, documentId: string): Promise<void> {
    if (!this.isCurrentProjectDocument(projectId, documentId)) {
      return;
    }

    try {
      const [document, chunks] = await Promise.all([
        this.api.getDocument(projectId, documentId),
        this.loadDocumentChunks(projectId, documentId),
      ]);
      if (!this.isCurrentProjectDocument(projectId, documentId)) {
        return;
      }
      this.library.upsertDocument(document);
      this.setActiveDocument(document);
      this.library.setChunks(chunks);
      this.updateUploadDocumentSnapshot(document);
      this.resetDocumentPollingFailure();
      if (!FINAL_DOCUMENT_STATUSES.has(document.status)) {
        this.scheduleDocumentPolling(projectId, documentId);
      }
    } catch {
      this.handleDocumentPollingFailure(projectId, documentId);
    }
  }

  private handleDocumentPollingFailure(
    projectId: string,
    documentId: string,
  ): void {
    this.stopDocumentPolling();
    if (!this.isCurrentProjectDocument(projectId, documentId)) {
      return;
    }

    const delay = POLL_RETRY_DELAYS_MS[this.documentPollFailureCount];
    if (delay !== undefined) {
      this.documentPollFailureCount += 1;
      this.documentPollTimer = setTimeout(() => {
        this.documentPollTimer = null;
        void this.pollDocument(projectId, documentId);
      }, delay);
      return;
    }

    this.pollingError.set(
      'Parsing progress could not be refreshed. The local job may still be running.',
    );
  }

  private resetDocumentPollingFailure(): void {
    this.documentPollFailureCount = 0;
    this.pollingError.set(null);
  }

  private stopDocumentPolling(): void {
    if (this.documentPollTimer !== null) {
      clearTimeout(this.documentPollTimer);
      this.documentPollTimer = null;
    }
  }

  private isCurrentProjectDocument(projectId: string, documentId: string): boolean {
    return (
      this.projects.selectedProject()?.id === projectId &&
      this.activeDocumentId() === documentId
    );
  }

  private newOperationId(): string {
    const cryptoRef = globalThis.crypto;
    return typeof cryptoRef?.randomUUID === 'function'
      ? cryptoRef.randomUUID()
      : `source-${Date.now()}-${this.uploadItemCounter}-${Math.random()
          .toString(16)
          .slice(2)}`;
  }
}
