import { computed, inject, Injectable, signal } from '@angular/core';
import { ChunkRead, DocumentRead, CERT_PREP_API } from '../../cert-prep-api';
import type {
  DocumentParsingMetric,
  LanguageHint,
  SourceUploadItem,
} from './contracts/source-import.contracts';
import { DocumentParsingMetricsService } from './document-parsing-metrics.service';
import { DocumentLibraryStore } from './document-library.store';
import { HealthStore } from '../health/health.store';
import { OperationStore } from '../operation.store';
import { ProjectStore } from '../project.store';

const DOCUMENT_POLL_INTERVAL_MS = 1500;
const FIRST_CHUNK_POLL_INTERVAL_MS = 500;
const FINAL_DOCUMENT_STATUSES = new Set([
  'ready',
  'exam_failed',
  'no_text_detected',
  'ocr_failed',
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
  private uploadItemCounter = 0;

  readonly languageHints: readonly LanguageHint[] = [
    'auto',
    'ja',
    'zh-Hant',
    'zh-Hans',
    'en',
    'mixed',
  ];
  readonly languageHint = signal<LanguageHint>('auto');
  readonly uploadItems = signal<SourceUploadItem[]>([]);
  readonly selectedFiles = computed(() =>
    this.uploadItems().map((item) => item.file),
  );
  readonly selectedFile = computed(() => this.selectedFiles()[0] ?? null);
  readonly isUploading = computed(() =>
    this.uploadItems().some((item) => item.status === 'uploading'),
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
    () => this.uploadItems().filter((item) => item.status === 'failed').length,
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
    () => this.activeDocument()?.status === 'processing',
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

  chooseFile(file: File | null): void {
    this.chooseFiles(file === null ? [] : [file]);
  }

  chooseFiles(files: readonly File[]): void {
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
    this.stopDocumentPolling();
  }

  reset(): void {
    this.uploadItems.set([]);
    this.library.reset();
    this.stopDocumentPolling();
  }

  setLanguageHint(value: string): void {
    const next = this.languageHints.includes(value as LanguageHint)
      ? (value as LanguageHint)
      : 'auto';
    this.languageHint.set(next);
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
    const uploadItems = this.uploadItems().filter((item) =>
      ['queued', 'failed'].includes(item.status),
    );
    if (project === null || uploadItems.length === 0) {
      this.operations.fail('Choose a project and one or more PDFs before uploading.');
      return [];
    }
    if (this.isUploading() || this.operations.busy() === 'upload') {
      return [];
    }
    if (this.health.isOcrHealthLoading()) {
      this.operations.fail(
        'OCR runtime is warming up. Try again when runtime health finishes.',
      );
      return [];
    }

    const uploadedDocuments: DocumentRead[] = [];
    let runtimePromptNeeded = false;

    this.operations.busy.set('upload');
    this.operations.error.set(null);
    this.operations.errorCode.set(null);
    this.markUploadItems(uploadItems, {
      status: 'queued',
      error: null,
    });

    try {
      for (const item of uploadItems) {
        this.updateUploadItem(item.id, {
          status: 'uploading',
          error: null,
        });

        try {
          const document = await this.uploadSingleDocument(project.id, item.file);
          uploadedDocuments.push(document);
          this.updateUploadItem(item.id, {
            status: 'uploaded',
            document,
            error: null,
          });
          this.library.upsertDocument(document);
        } catch (error) {
          const errorCode = this.getUploadErrorCode(error);
          runtimePromptNeeded ||=
            errorCode === 'paddle_runtime_missing' ||
            errorCode === 'windowsml_runtime_missing';
          this.updateUploadItem(item.id, {
            status: 'failed',
            error: this.getUploadErrorMessage(error),
          });
        }
      }
    } finally {
      if (this.operations.busy() === 'upload') {
        this.operations.busy.set(null);
      }
    }

    if (runtimePromptNeeded) {
      await this.refreshRuntimeHealth();
      this.health.openOcrRuntimeInstallConsent();
    }

    const activeDocument =
      uploadedDocuments.length > 0
        ? uploadedDocuments[uploadedDocuments.length - 1]
        : null;
    if (activeDocument !== null) {
      this.setActiveDocument(activeDocument);
      await this.refreshUploadedDocument(project.id, activeDocument.id);
    }

    const failedCount = this.failedUploadCount();
    if (uploadedDocuments.length > 0) {
      this.operations.status.set(
        uploadedDocuments.length === 1
          ? 'PDF uploaded'
          : `${uploadedDocuments.length} PDFs uploaded`,
      );
    }
    if (failedCount > 0) {
      this.operations.error.set(
        failedCount === 1
          ? '1 PDF failed to upload.'
          : `${failedCount} PDFs failed to upload.`,
      );
    }

    return uploadedDocuments;
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
      if (nextDocument.status === 'processing') {
        this.scheduleDocumentPolling(project, document);
      } else {
        this.stopDocumentPolling();
      }
    } catch {
      this.stopDocumentPolling();
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

  private async uploadSingleDocument(
    projectId: string,
    file: File,
  ): Promise<DocumentRead> {
    const formData = new FormData();
    formData.append('file', file, file.name);
    formData.append('language_hint', this.languageHint());
    return this.api.uploadDocument(projectId, formData);
  }

  private markUploadItems(
    items: readonly SourceUploadItem[],
    patch: Partial<Omit<SourceUploadItem, 'id' | 'file'>>,
  ): void {
    const ids = new Set(items.map((item) => item.id));
    this.uploadItems.update((currentItems) =>
      currentItems.map((item) =>
        ids.has(item.id)
          ? {
              ...item,
              ...patch,
            }
          : item,
      ),
    );
  }

  private updateUploadItem(
    id: string,
    patch: Partial<Omit<SourceUploadItem, 'id' | 'file'>>,
  ): void {
    this.uploadItems.update((items) =>
      items.map((item) =>
        item.id === id
          ? {
              ...item,
              ...patch,
            }
          : item,
      ),
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
      if (!FINAL_DOCUMENT_STATUSES.has(document.status)) {
        this.scheduleDocumentPolling(projectId, documentId);
      }
    } catch {
      this.stopDocumentPolling();
    }
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
}
