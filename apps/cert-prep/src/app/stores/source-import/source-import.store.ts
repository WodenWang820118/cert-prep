import { computed, inject, Injectable, signal } from '@angular/core';
import { CERT_PREP_API } from '../../cert-prep-api';
import type { ChunkRead, DocumentRead } from '../../cert-prep-api';
import type {
  DocumentParsingMetric,
  LanguageHint,
  SourceUploadItem,
} from './contracts/source-import.contracts';
import { DocumentParsingMetricsService } from './document-parsing-metrics.service';
import { DocumentLibraryStore } from './document-library.store';
import {
  DocumentProcessingLifecycle,
  type DocumentProcessingActionView,
} from './document-processing-lifecycle';
import { HealthStore } from '../health/health.store';
import { OperationStore } from '../operation.store';
import { ProjectStore } from '../project.store';
import {
  SourceUploadLifecycle,
  type UploadTransportRun,
} from './source-upload-lifecycle';

const DOCUMENT_POLL_INTERVAL_MS = 1500;
const FIRST_CHUNK_POLL_INTERVAL_MS = 500;
const DOCUMENT_POLL_RETRY_DELAYS_MS = [1000, 2000, 4000] as const;
const DEFAULT_UPLOAD_BATCH_SIZE = 2;
const MIN_UPLOAD_BATCH_SIZE = 1;
const MAX_UPLOAD_BATCH_SIZE = 4;
const ACTIVE_DOCUMENT_STATUSES = new Set(['processing', 'cancel_requested']);
const RETRYABLE_DOCUMENT_STATUSES = new Set([
  'canceled',
  'ocr_failed',
  'no_text_detected',
]);

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
  private documentListRequestEpoch = 0;
  private documentRefreshRequestEpoch = 0;
  private contextEpoch = 0;
  private uploadItemCounter = 0;
  private readonly uploadLifecycle = new SourceUploadLifecycle({
    item: (itemId) =>
      this.uploadItems().find((candidate) => candidate.id === itemId),
    current: (projectId, contextEpoch) =>
      this.isCurrentContext(projectId, contextEpoch),
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
    errorMessage: (error) => this.getUploadErrorMessage(error),
    errorCode: (error) => this.getUploadErrorCode(error),
  });
  private readonly documentProcessingLifecycle =
    new DocumentProcessingLifecycle({
      current: (projectId, contextEpoch) =>
        this.isCurrentContext(projectId, contextEpoch),
      setView: (documentId, view) =>
        this.setDocumentProcessingView(documentId, view),
      acceptDocument: (document) =>
        this.acceptDocumentProcessingDocument(document),
      retryDocument: (projectId, documentId, operationId, signal) =>
        this.api.retryDocumentProcessing(projectId, documentId, {
          headers: { 'X-Cert-Prep-Operation-Id': operationId },
          signal,
        }),
      cancelDocument: (projectId, documentId) =>
        this.api.cancelDocumentProcessing(projectId, documentId),
      getDocument: (projectId, documentId) =>
        this.api.getDocument(projectId, documentId),
      getOperation: (projectId, operationId) =>
        this.api.getDocumentOperation(projectId, operationId),
      cancelOperation: (projectId, operationId) =>
        this.api.cancelDocumentOperation(projectId, operationId),
      errorMessage: (error) => this.getUploadErrorMessage(error),
      errorCode: (error) => this.getUploadErrorCode(error),
      runtimeMissing: () => this.handleMissingOcrRuntime(),
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
  readonly languageHint = signal<LanguageHint>('auto');
  readonly uploadBatchSize = signal(DEFAULT_UPLOAD_BATCH_SIZE);
  readonly uploadItems = signal<SourceUploadItem[]>([]);
  readonly documentPollingError = signal<string | null>(null);
  readonly documentProcessingActions = signal<
    ReadonlyMap<string, DocumentProcessingActionView>
  >(new Map());
  readonly selectedFiles = computed(() =>
    this.uploadItems().map((item) => item.file),
  );
  readonly selectedFile = computed(() => this.selectedFiles()[0] ?? null);
  readonly isUploading = computed(() =>
    this.uploadItems().some((item) =>
      ['uploading', 'cancel_requested'].includes(item.status),
    ),
  );
  readonly pendingUploadCount = computed(
    () => this.uploadItems().filter((item) => item.status === 'queued').length,
  );
  readonly failedUploadCount = computed(
    () =>
      this.uploadItems().filter((item) =>
        ['failed', 'status_unavailable'].includes(item.status),
      ).length,
  );
  readonly selectedFileLabel = computed(() => {
    const files = this.selectedFiles();
    if (files.length === 0) {
      return this.activeDocument()?.filename ?? 'No PDF selected';
    }
    if (files.length === 1) {
      return files[0]?.name ?? 'No PDF selected';
    }
    return `${files.length} PDFs selected`;
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
  readonly isParsing = computed(
    () =>
      this.activeDocument()?.status === 'processing' &&
      this.documentPollingError() === null,
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
      return 'No source PDF uploaded.';
    }
    if (this.documentPollingError() !== null) {
      return 'Parsing status is unavailable.';
    }
    if (document.status === 'processing') {
      return document.chunks_count > 0
        ? 'Parsing continues; completed chunks are already available.'
        : 'Parsing started; waiting for the first completed page.';
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
      this.pendingUploadCount() > 0 &&
      !this.health.isOcrHealthLoading() &&
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

  chooseFiles(files: readonly File[]): void {
    this.invalidateUploadContext();
    this.uploadItems.set(
      files.map((file) => ({
        id: `source-upload-${++this.uploadItemCounter}`,
        file,
        status: 'queued',
        document: null,
        error: null,
      })),
    );
    this.library.clearActiveDocument();
  }

  reset(): void {
    this.invalidateUploadContext();
    this.uploadItems.set([]);
    this.library.reset();
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

  async uploadDocuments(): Promise<DocumentRead[]> {
    const project = this.projects.selectedProject();
    const itemIds = this.uploadItems()
      .filter((item) => item.status === 'queued')
      .map((item) => item.id);
    if (project === null || itemIds.length === 0) {
      this.operations.fail('Choose a project and one or more PDFs before uploading.');
      return [];
    }
    if (this.uploadLifecycle.hasActiveRun() || this.operations.isBusyFor('upload')) {
      return [];
    }
    if (this.health.isOcrHealthLoading()) {
      this.operations.fail(
        'OCR runtime is warming up. Try again when runtime health finishes.',
      );
      return [];
    }
    return this.runUploadTransports(project.id, itemIds);
  }

  canCancelUpload(item: SourceUploadItem): boolean {
    return ['queued', 'uploading', 'cancel_requested'].includes(item.status);
  }

  canRetryUpload(item: SourceUploadItem): boolean {
    if (item.status === 'status_unavailable') {
      return true;
    }
    return (
      item.document === null &&
      ['failed', 'canceled'].includes(item.status)
    );
  }

  documentProcessingState(
    documentId: string,
  ): DocumentProcessingActionView | null {
    return this.documentProcessingActions().get(documentId) ?? null;
  }

  documentProcessingError(documentId: string): string | null {
    return this.documentProcessingState(documentId)?.error ?? null;
  }

  canCancelDocumentProcessing(document: DocumentRead): boolean {
    const action = this.documentProcessingState(document.id);
    if (this.documentProcessingLifecycle.hasActiveAttempt(document.id)) {
      return action?.kind === 'retry' && action.cancellable;
    }
    return ACTIVE_DOCUMENT_STATUSES.has(document.status);
  }

  canRetryDocumentProcessing(document: DocumentRead): boolean {
    return (
      RETRYABLE_DOCUMENT_STATUSES.has(document.status) &&
      !this.documentProcessingLifecycle.hasActiveAttempt(document.id) &&
      !this.health.isOcrHealthLoading()
    );
  }

  canRetryDocumentActionStatus(documentId: string): boolean {
    return (
      this.documentProcessingLifecycle.hasActiveAttempt(documentId) &&
      this.documentProcessingState(documentId)?.status ===
        'status_unavailable'
    );
  }

  async cancelUpload(itemId: string): Promise<void> {
    const item = this.uploadItems().find((candidate) => candidate.id === itemId);
    if (item === undefined || !this.canCancelUpload(item)) {
      return;
    }
    this.uploadLifecycle.cancel(itemId);
  }

  async retryUpload(itemId: string): Promise<void> {
    const projectId = this.projects.selectedProject()?.id;
    const item = this.uploadItems().find((candidate) => candidate.id === itemId);
    if (projectId !== undefined && item?.status === 'status_unavailable') {
      const resumed = this.uploadLifecycle.resume(itemId);
      if (resumed?.kind === 'new-run') {
        await this.finishUploadTransports(projectId, [itemId], resumed.run);
      }
      return;
    }
    if (
      projectId === undefined ||
      item === undefined ||
      item.document !== null ||
      !this.canRetryUpload(item) ||
      this.health.isOcrHealthLoading() ||
      !this.updateUploadItem(itemId, { status: 'queued', error: null })
    ) {
      return;
    }
    if (this.uploadLifecycle.hasActiveRun()) {
      this.uploadLifecycle.begin(
        projectId,
        this.contextEpoch,
        [itemId],
        this.uploadBatchSize(),
      );
      return;
    }
    await this.runUploadTransports(projectId, [itemId]);
  }

  async cancelDocumentProcessing(documentId: string): Promise<boolean> {
    const projectId = this.projects.selectedProject()?.id;
    const document = this.findProjectDocument(documentId);
    if (
      projectId === undefined ||
      document === null ||
      !this.canCancelDocumentProcessing(document)
    ) {
      return false;
    }
    return this.documentProcessingLifecycle.cancel(
      projectId,
      this.contextEpoch,
      documentId,
    );
  }

  async retryDocumentProcessing(documentId: string): Promise<boolean> {
    const projectId = this.projects.selectedProject()?.id;
    const document = this.findProjectDocument(documentId);
    if (
      projectId === undefined ||
      document === null ||
      !this.canRetryDocumentProcessing(document)
    ) {
      return false;
    }
    if (this.activeDocumentId() === documentId) {
      this.library.clearChunks();
    }
    return this.documentProcessingLifecycle.retry(
      projectId,
      this.contextEpoch,
      documentId,
    );
  }

  async retryDocumentActionStatus(documentId: string): Promise<boolean> {
    if (!this.canRetryDocumentActionStatus(documentId)) {
      return false;
    }
    return this.documentProcessingLifecycle.resume(documentId);
  }

  async loadLatestDocument(projectId: string): Promise<void> {
    const requestEpoch = ++this.documentListRequestEpoch;
    const documents = await this.api.listDocuments(projectId);
    if (
      requestEpoch !== this.documentListRequestEpoch ||
      this.projects.selectedProject()?.id !== projectId
    ) {
      return;
    }
    this.library.setDocuments(documents.items);
    const activeDocument = this.library.chooseActiveFromDocuments();
    this.setActiveDocument(activeDocument);
    if (activeDocument === null) {
      this.chunks.set([]);
      this.resetDocumentPollingState();
      return;
    }
    await this.refreshUploadedDocument(projectId, activeDocument.id);
  }

  setActiveDocumentId(documentId: string | null): void {
    if (this.library.setActiveDocumentId(documentId)) {
      this.documentRefreshRequestEpoch += 1;
      this.resetDocumentPollingState();
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
    }

    await this.refreshUploadedDocument(projectId, documentId);
  }

  async retryDocumentPolling(): Promise<void> {
    const projectId = this.projects.selectedProject()?.id;
    const documentId = this.activeDocumentId();
    if (
      projectId === undefined ||
      documentId === null ||
      this.documentPollingError() === null
    ) {
      return;
    }
    this.resetDocumentPollingState();
    await this.refreshUploadedDocument(projectId, documentId);
  }

  async refreshUploadedDocument(
    projectId?: string,
    documentId?: string,
  ): Promise<void> {
    const project = projectId ?? this.projects.selectedProject()?.id;
    const document =
      documentId ?? this.activeDocumentId() ?? this.activeDocument()?.id;
    if (
      project === undefined ||
      document === undefined ||
      this.projects.selectedProject()?.id !== project
    ) {
      return;
    }
    if (documentId !== undefined && this.activeDocumentId() !== documentId) {
      this.activeDocumentId.set(documentId);
      this.documentRefreshRequestEpoch += 1;
    }
    const requestEpoch = ++this.documentRefreshRequestEpoch;

    try {
      const [nextDocument, chunks] = await Promise.all([
        this.api.getDocument(project, document),
        this.loadDocumentChunks(project, document),
      ]);
      if (!this.ownsDocumentRefresh(requestEpoch, project, document)) {
        return;
      }
      this.recordDocumentPollingSuccess();
      this.library.upsertDocument(nextDocument);
      this.setActiveDocument(nextDocument);
      this.library.setChunks(chunks);
      this.updateUploadDocumentSnapshot(nextDocument);
      if (ACTIVE_DOCUMENT_STATUSES.has(nextDocument.status)) {
        this.scheduleDocumentPolling(project, document);
      } else {
        this.stopDocumentPolling();
      }
    } catch {
      this.handleDocumentPollingFailure(requestEpoch, project, document);
    }
  }

  private async loadDocumentChunks(
    projectId: string,
    documentId: string,
  ): Promise<ChunkRead[]> {
    try {
      const chunks = await this.api.listDocumentChunks(projectId, documentId);
      return chunks.items;
    } catch {
      return [];
    }
  }

  private async runUploadTransports(
    projectId: string,
    itemIds: readonly string[],
  ): Promise<DocumentRead[]> {
    const contextEpoch = this.contextEpoch;
    const run = this.uploadLifecycle.begin(
      projectId,
      contextEpoch,
      itemIds,
      this.uploadBatchSize(),
    );
    return this.finishUploadTransports(projectId, itemIds, run);
  }

  private async finishUploadTransports(
    projectId: string,
    itemIds: readonly string[],
    run: UploadTransportRun,
  ): Promise<DocumentRead[]> {
    const result = await this.operations.run(
      'upload',
      (documents) => this.uploadOutcomeMessage(itemIds, documents),
      async () => {
        await run.done;
        return [...run.documents];
      },
      () => this.isCurrentContext(projectId, run.contextEpoch),
    );
    if (!this.isCurrentContext(projectId, run.contextEpoch)) {
      return [];
    }
    if (
      run.runtimePromptNeeded &&
      this.isCurrentContext(projectId, run.contextEpoch)
    ) {
      await this.refreshRuntimeHealth();
      if (this.isCurrentContext(projectId, run.contextEpoch)) {
        this.health.openOcrRuntimeInstallConsent();
      }
    }
    const failedCount = this.failedUploadCount();
    if (
      failedCount > 0 &&
      this.isCurrentContext(projectId, run.contextEpoch)
    ) {
      this.operations.error.set(
        failedCount === 1
          ? '1 PDF failed to upload.'
          : `${failedCount} PDFs failed to upload.`,
      );
    }
    return result ?? [];
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
          ? '1 PDF upload accepted'
          : `${acceptedCount} PDF uploads accepted`;
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
        ? 'PDF upload canceled'
        : `${itemIds.length} PDF uploads canceled`;
    }
    return itemIds.length === 1
      ? 'PDF upload did not complete'
      : 'No PDF uploads completed';
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
    return updated;
  }

  private acceptLifecycleDocument(
    document: DocumentRead,
    pollDocument: boolean,
  ): void {
    this.library.upsertDocument(document);
    this.setActiveDocument(document);
    if (ACTIVE_DOCUMENT_STATUSES.has(document.status) && pollDocument) {
      this.scheduleDocumentPolling(document.project_id, document.id);
    }
  }

  private invalidateUploadContext(): void {
    this.documentProcessingLifecycle.invalidate();
    this.contextEpoch += 1;
    this.documentListRequestEpoch += 1;
    this.documentRefreshRequestEpoch += 1;
    this.resetDocumentPollingState();
    this.uploadLifecycle.invalidate();
  }

  private setDocumentProcessingView(
    documentId: string,
    view: DocumentProcessingActionView | null,
  ): void {
    const actions = new Map(this.documentProcessingActions());
    if (view === null) {
      actions.delete(documentId);
    } else {
      actions.set(documentId, view);
    }
    this.documentProcessingActions.set(actions);

    if (this.activeDocumentId() !== documentId) {
      return;
    }
    this.resetDocumentPollingState();
    if (view !== null && view.status !== 'failed') {
      return;
    }

    const document = this.activeDocument();
    const projectId = this.projects.selectedProject()?.id;
    if (document === null || projectId === undefined) {
      return;
    }
    if (ACTIVE_DOCUMENT_STATUSES.has(document.status)) {
      this.scheduleDocumentPolling(projectId, document.id);
    } else if (view === null && document.status === 'ready') {
      void this.refreshDocumentChunksAfterAction(projectId, document.id);
    }
  }

  private acceptDocumentProcessingDocument(document: DocumentRead): void {
    if (this.projects.selectedProject()?.id !== document.project_id) {
      return;
    }
    this.library.upsertDocument(document);
    this.updateUploadDocumentSnapshot(document);
    if (this.activeDocumentId() !== document.id) {
      return;
    }

    this.documentRefreshRequestEpoch += 1;
    this.resetDocumentPollingState();
    this.library.setActiveDocument(document);
    if (document.chunks_count === 0) {
      this.library.clearChunks();
    }
  }

  private async refreshDocumentChunksAfterAction(
    projectId: string,
    documentId: string,
  ): Promise<void> {
    const contextEpoch = this.contextEpoch;
    try {
      const chunks = await this.api.listDocumentChunks(projectId, documentId);
      if (
        this.isCurrentContext(projectId, contextEpoch) &&
        this.activeDocumentId() === documentId &&
        !this.documentProcessingLifecycle.hasActiveAttempt(documentId)
      ) {
        this.library.setChunks(chunks.items);
      }
    } catch {
      // Keep the last visible chunks; document status remains authoritative.
    }
  }

  private findProjectDocument(documentId: string): DocumentRead | null {
    const projectId = this.projects.selectedProject()?.id;
    if (projectId === undefined) {
      return null;
    }
    const document =
      this.documents().find((candidate) => candidate.id === documentId) ??
      this.uploadItems().find((item) => item.document?.id === documentId)
        ?.document ??
      null;
    return document?.project_id === projectId ? document : null;
  }

  private handleMissingOcrRuntime(): void {
    const contextEpoch = this.contextEpoch;
    void (async () => {
      await this.refreshRuntimeHealth();
      if (contextEpoch === this.contextEpoch) {
        this.health.openOcrRuntimeInstallConsent();
      }
    })();
  }

  private setActiveDocument(document: DocumentRead | null): void {
    if (this.library.setActiveDocument(document)) {
      this.documentRefreshRequestEpoch += 1;
      this.resetDocumentPollingState();
    }
  }

  private async refreshRuntimeHealth(): Promise<void> {
    try {
      await this.health.load();
    } catch {
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

  private scheduleDocumentPolling(
    projectId: string,
    documentId: string,
    delayMs = this.documentPollIntervalMs(),
  ): void {
    this.stopDocumentPolling();
    this.documentPollTimer = setTimeout(() => {
      this.documentPollTimer = null;
      void this.pollDocument(projectId, documentId);
    }, delayMs);
  }

  private handleDocumentPollingFailure(
    requestEpoch: number,
    projectId: string,
    documentId: string,
  ): void {
    if (!this.ownsDocumentRefresh(requestEpoch, projectId, documentId)) {
      return;
    }
    this.stopDocumentPolling();
    if (
      this.documentPollFailureCount >= DOCUMENT_POLL_RETRY_DELAYS_MS.length
    ) {
      this.documentPollingError.set(
        'Document status could not be refreshed. Retry status.',
      );
      return;
    }
    const delay =
      DOCUMENT_POLL_RETRY_DELAYS_MS[this.documentPollFailureCount];
    this.documentPollFailureCount += 1;
    this.scheduleDocumentPolling(projectId, documentId, delay);
  }

  private recordDocumentPollingSuccess(): void {
    this.documentPollFailureCount = 0;
    this.documentPollingError.set(null);
  }

  private documentPollIntervalMs(): number {
    const document = this.activeDocument();
    return document?.status === 'processing' &&
      this.chunks().length === 0
      ? FIRST_CHUNK_POLL_INTERVAL_MS
      : DOCUMENT_POLL_INTERVAL_MS;
  }

  private async pollDocument(
    projectId: string,
    documentId: string,
  ): Promise<void> {
    if (!this.isCurrentProjectDocument(projectId, documentId)) {
      return;
    }
    const requestEpoch = ++this.documentRefreshRequestEpoch;

    try {
      const [document, chunks] = await Promise.all([
        this.api.getDocument(projectId, documentId),
        this.loadDocumentChunks(projectId, documentId),
      ]);
      if (!this.ownsDocumentRefresh(requestEpoch, projectId, documentId)) {
        return;
      }
      this.recordDocumentPollingSuccess();
      this.library.upsertDocument(document);
      this.setActiveDocument(document);
      this.library.setChunks(chunks);
      this.updateUploadDocumentSnapshot(document);
      if (ACTIVE_DOCUMENT_STATUSES.has(document.status)) {
        this.scheduleDocumentPolling(projectId, documentId);
      }
    } catch {
      this.handleDocumentPollingFailure(
        requestEpoch,
        projectId,
        documentId,
      );
    }
  }

  private stopDocumentPolling(): void {
    if (this.documentPollTimer !== null) {
      clearTimeout(this.documentPollTimer);
      this.documentPollTimer = null;
    }
  }

  private resetDocumentPollingState(): void {
    this.stopDocumentPolling();
    this.documentPollFailureCount = 0;
    this.documentPollingError.set(null);
  }

  private isCurrentProjectDocument(projectId: string, documentId: string): boolean {
    return (
      this.projects.selectedProject()?.id === projectId &&
      this.activeDocumentId() === documentId
    );
  }

  private ownsDocumentRefresh(
    requestEpoch: number,
    projectId: string,
    documentId: string,
  ): boolean {
    return (
      requestEpoch === this.documentRefreshRequestEpoch &&
      this.isCurrentProjectDocument(projectId, documentId)
    );
  }

  private updateUploadDocumentSnapshot(document: DocumentRead): void {
    this.uploadItems.update((items) =>
      items.map((item) =>
        item.document?.id === document.id ? { ...item, document } : item,
      ),
    );
  }

  private isCurrentContext(projectId: string, contextEpoch: number): boolean {
    return (
      this.contextEpoch === contextEpoch &&
      this.projects.selectedProject()?.id === projectId
    );
  }
}
