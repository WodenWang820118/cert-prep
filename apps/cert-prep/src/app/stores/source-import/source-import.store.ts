import { computed, inject, Injectable, signal } from '@angular/core';
import { ChunkRead, DocumentRead, CERT_PREP_API } from '../../cert-prep-api';
import type {
  DocumentParsingMetric,
  LanguageHint,
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

  readonly languageHints: readonly LanguageHint[] = [
    'auto',
    'ja',
    'zh-Hant',
    'zh-Hans',
    'en',
    'mixed',
  ];
  readonly languageHint = signal<LanguageHint>('auto');
  readonly selectedFile = signal<File | null>(null);
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
      this.selectedFile() !== null &&
      !this.health.isOcrHealthLoading(),
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
    this.selectedFile.set(file);
    this.library.clearActiveDocument();
    this.stopDocumentPolling();
  }

  reset(): void {
    this.selectedFile.set(null);
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
    const project = this.projects.selectedProject();
    const file = this.selectedFile();
    if (project === null || file === null) {
      this.operations.fail('Choose a project and PDF before uploading.');
      return null;
    }
    if (this.health.isOcrHealthLoading()) {
      this.operations.fail(
        'OCR runtime is warming up. Try again when runtime health finishes.',
      );
      return null;
    }

    const formData = new FormData();
    formData.append('file', file, file.name);
    formData.append('language_hint', this.languageHint());

    const document = await this.operations.run('upload', 'PDF uploaded', () =>
      this.api.uploadDocument(project.id, formData),
    );
    if (document !== null) {
      this.library.upsertDocument(document);
      this.setActiveDocument(document);
      await this.refreshUploadedDocument(project.id, document.id);
    } else if (
      [
        'paddle_runtime_missing',
        'windowsml_runtime_missing',
      ].includes(this.operations.errorCode() ?? '')
    ) {
      await this.refreshRuntimeHealth();
      this.health.openOcrRuntimeInstallConsent();
    }
    return document;
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
