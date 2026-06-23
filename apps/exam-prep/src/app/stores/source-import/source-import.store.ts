import { computed, inject, Injectable, signal } from '@angular/core';
import { ChunkRead, DocumentRead, EXAM_PREP_API } from '../../exam-prep-api';
import type {
  DocumentParsingMetric,
  LanguageHint,
} from './contracts/source-import.contracts';
import { DocumentParsingMetricsService } from './document-parsing-metrics.service';
import { HealthStore } from '../health/health.store';
import { OperationStore } from '../operation.store';
import { ProjectStore } from '../project.store';

const DOCUMENT_POLL_INTERVAL_MS = 1500;
const FIRST_CHUNK_POLL_INTERVAL_MS = 500;
const INITIAL_CHUNK_PREVIEW_LIMIT = 6;
const CHUNK_PREVIEW_STEP = 6;
const FINAL_DOCUMENT_STATUSES = new Set([
  'ready',
  'exam_failed',
  'no_text_detected',
  'ocr_failed',
]);

@Injectable({ providedIn: 'root' })
export class SourceImportStore {
  private readonly api = inject(EXAM_PREP_API);
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
  readonly documents = signal<DocumentRead[]>([]);
  readonly uploadedDocument = signal<DocumentRead | null>(null);
  readonly chunks = signal<ChunkRead[]>([]);
  readonly visibleChunkLimit = signal(INITIAL_CHUNK_PREVIEW_LIMIT);
  readonly previewChunks = computed(() =>
    this.chunks().slice(0, this.visibleChunkLimit()),
  );
  readonly hiddenChunkCount = computed(() =>
    Math.max(0, this.chunks().length - this.previewChunks().length),
  );
  readonly isParsing = computed(
    () => this.uploadedDocument()?.status === 'processing',
  );
  readonly progressPercent = computed(() =>
    this.metrics.progressPercent(this.uploadedDocument()),
  );
  readonly progressLabel = computed(() =>
    this.metrics.progressLabel(this.uploadedDocument()),
  );
  readonly parseStageText = computed(() => {
    const document = this.uploadedDocument();
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
    this.metrics.elapsedTime(this.uploadedDocument()),
  );
  readonly canUpload = computed(
    () =>
      this.projects.selectedProject() !== null &&
      this.selectedFile() !== null &&
      !this.health.isOcrHealthLoading(),
  );
  readonly canGenerateDrafts = computed(() => {
    const document = this.uploadedDocument();
    return (
      this.projects.selectedProject() !== null &&
      document !== null &&
      document.has_text &&
      document.chunks_count > 0
    );
  });

  chooseFile(file: File | null): void {
    this.selectedFile.set(file);
    this.uploadedDocument.set(null);
    this.chunks.set([]);
    this.visibleChunkLimit.set(INITIAL_CHUNK_PREVIEW_LIMIT);
    this.stopDocumentPolling();
  }

  reset(): void {
    this.selectedFile.set(null);
    this.documents.set([]);
    this.uploadedDocument.set(null);
    this.chunks.set([]);
    this.visibleChunkLimit.set(INITIAL_CHUNK_PREVIEW_LIMIT);
    this.stopDocumentPolling();
  }

  setLanguageHint(value: string): void {
    const next = this.languageHints.includes(value as LanguageHint)
      ? (value as LanguageHint)
      : 'auto';
    this.languageHint.set(next);
  }

  showMoreChunks(): void {
    this.visibleChunkLimit.update((limit) => limit + CHUNK_PREVIEW_STEP);
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
      this.uploadedDocument.set(document);
      this.upsertDocument(document);
      this.visibleChunkLimit.set(INITIAL_CHUNK_PREVIEW_LIMIT);
      await this.refreshUploadedDocument(project.id, document.id);
    } else if (
      [
        'paddle_runtime_missing',
        'directml_runtime_missing',
        'amd_npu_runtime_missing',
      ].includes(this.operations.errorCode() ?? '')
    ) {
      await this.refreshRuntimeHealth();
      this.health.openOcrRuntimeInstallConsent();
    }
    return document;
  }

  async loadLatestDocument(projectId: string): Promise<void> {
    const documents = await this.api.listDocuments(projectId);
    this.documents.set(documents.items);
    const document = documents.items[0] ?? null;
    this.uploadedDocument.set(document);
    if (document === null) {
      this.chunks.set([]);
      this.stopDocumentPolling();
      return;
    }
    await this.refreshUploadedDocument(projectId, document.id);
  }

  async refreshUploadedDocument(
    projectId?: string,
    documentId?: string,
  ): Promise<void> {
    const project = projectId ?? this.projects.selectedProject()?.id;
    const document = documentId ?? this.uploadedDocument()?.id;
    if (project === undefined || document === undefined) {
      return;
    }

    try {
      const [nextDocument] = await Promise.all([
        this.api.getDocument(project, document),
        this.loadDocumentChunks(project, document),
      ]);
      this.uploadedDocument.set(nextDocument);
      this.upsertDocument(nextDocument);
      if (nextDocument.status === 'processing') {
        this.scheduleDocumentPolling(project, document);
      } else {
        this.stopDocumentPolling();
      }
    } catch {
      this.stopDocumentPolling();
    }
  }

  private async loadDocumentChunks(projectId: string, documentId: string): Promise<void> {
    try {
      const chunks = await this.api.listDocumentChunks(projectId, documentId);
      this.chunks.set(chunks.items);
    } catch {
      this.chunks.set([]);
    }
  }

  private upsertDocument(document: DocumentRead): void {
    this.documents.update((documents) => {
      const existingIndex = documents.findIndex((item) => item.id === document.id);
      if (existingIndex === -1) {
        return [document, ...documents];
      }

      return documents.map((item, index) =>
        index === existingIndex ? document : item,
      );
    });
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
    const document = this.uploadedDocument();
    return document?.status === 'processing' &&
      this.chunks().length === 0
      ? FIRST_CHUNK_POLL_INTERVAL_MS
      : DOCUMENT_POLL_INTERVAL_MS;
  }

  private async pollDocument(projectId: string, documentId: string): Promise<void> {
    const currentProject = this.projects.selectedProject()?.id;
    const currentDocument = this.uploadedDocument()?.id;
    if (currentProject !== projectId || currentDocument !== documentId) {
      return;
    }

    try {
      const document = await this.api.getDocument(projectId, documentId);
      this.uploadedDocument.set(document);
      this.upsertDocument(document);
      await this.loadDocumentChunks(projectId, documentId);
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
}
