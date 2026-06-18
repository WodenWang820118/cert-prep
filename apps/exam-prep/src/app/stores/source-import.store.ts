import { computed, inject, Injectable, signal } from '@angular/core';
import { ChunkRead, DocumentRead, EXAM_PREP_API } from '../exam-prep-api';
import { HealthStore } from './health.store';
import { OperationStore } from './operation.store';
import { ProjectStore } from './project.store';

export type LanguageHint = 'auto' | 'ja' | 'zh-Hant' | 'zh-Hans' | 'en' | 'mixed';

const DOCUMENT_POLL_INTERVAL_MS = 1500;
const INITIAL_CHUNK_PREVIEW_LIMIT = 6;
const CHUNK_PREVIEW_STEP = 6;
const FINAL_DOCUMENT_STATUSES = new Set([
  'ready',
  'exam_failed',
  'no_text_detected',
  'ocr_failed',
]);

const PARSING_METRIC_DEFINITIONS: readonly ParsingMetricDefinition[] = [
  {
    label: 'Parse wall time',
    kind: 'duration',
    keys: [
      'parse_wall_time_ms',
      'parse_wall_time_seconds',
      'parse_wall_duration_ms',
      'parseWallTimeMs',
      'parseWallDurationMs',
      'parse_duration_ms',
      'parseDurationMs',
      'parse_elapsed_ms',
      'parseElapsedMs',
    ],
  },
  {
    label: 'Render time',
    kind: 'duration',
    keys: [
      'render_time_ms',
      'render_time_seconds',
      'render_duration_ms',
      'renderDurationMs',
      'pdf_render_duration_ms',
      'pdfRenderDurationMs',
      'page_render_time_ms',
      'pageRenderTimeMs',
      'render_ms',
      'renderMs',
    ],
  },
  {
    label: 'OCR engine time',
    kind: 'duration',
    keys: [
      'ocr_engine_time_ms',
      'ocrEngineTimeMs',
      'ocr_engine_duration_ms',
      'ocrEngineDurationMs',
      'ocr_time_ms',
      'ocrTimeMs',
      'ocr_duration_ms',
      'ocrDurationMs',
    ],
  },
  {
    label: 'Worker count',
    kind: 'count',
    keys: [
      'worker_count',
      'workerCount',
      'workers',
      'ocr_worker_count',
      'ocrWorkerCount',
    ],
  },
  {
    label: 'First chunk time',
    kind: 'duration',
    keys: [
      'first_chunk_time_ms',
      'firstChunkTimeMs',
      'first_chunk_duration_ms',
      'firstChunkDurationMs',
      'first_chunk_latency_ms',
      'firstChunkLatencyMs',
      'first_chunk_ms',
      'firstChunkMs',
      'time_to_first_chunk_ms',
      'timeToFirstChunkMs',
    ],
  },
];

@Injectable({ providedIn: 'root' })
export class SourceImportStore {
  private readonly api = inject(EXAM_PREP_API);
  private readonly health = inject(HealthStore);
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
  readonly progressPercent = computed(() => {
    const document = this.uploadedDocument();
    if (document === null || document.page_count <= 0) {
      return 0;
    }
    const completedPages = completedPageCount(document);
    return Math.min(
      100,
      Math.round((completedPages / document.page_count) * 100),
    );
  });
  readonly progressLabel = computed(() => {
    const document = this.uploadedDocument();
    if (document === null) {
      return '0/0 pages';
    }
    return `${completedPageCount(document)}/${document.page_count} pages`;
  });
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
    return 'Draft generation needs attention.';
  });
  readonly elapsedTime = computed(() => {
    const document = this.uploadedDocument();
    if (document === null) {
      return '0s';
    }
    const startedAt = Date.parse(document.created_at);
    if (!Number.isFinite(startedAt)) {
      return '0s';
    }
    const updatedAt = Date.parse(document.updated_at);
    const currentTime =
      document.status === 'processing' || !Number.isFinite(updatedAt)
        ? Date.now()
        : updatedAt;
    return formatElapsed(currentTime - startedAt);
  });
  readonly canUpload = computed(
    () => this.projects.selectedProject() !== null && this.selectedFile() !== null,
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
    return PARSING_METRIC_DEFINITIONS.flatMap((definition) => {
      const value = readMetricNumber(document, definition.keys);
      if (value === null) {
        return [];
      }

      return [
        {
          label: definition.label,
          value:
            definition.kind === 'duration'
              ? formatMetricDuration(value)
              : formatMetricCount(value),
        },
      ];
    });
  }

  async uploadDocument(): Promise<DocumentRead | null> {
    const project = this.projects.selectedProject();
    const file = this.selectedFile();
    if (project === null || file === null) {
      this.operations.fail('Choose a project and PDF before uploading.');
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
    } else if (this.operations.errorCode() === 'paddle_runtime_missing') {
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
    }, DOCUMENT_POLL_INTERVAL_MS);
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

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

export interface DocumentParsingMetric {
  readonly label: string;
  readonly value: string;
}

interface ParsingMetricDefinition {
  readonly label: string;
  readonly kind: 'duration' | 'count';
  readonly keys: readonly string[];
}

function readMetricNumber(
  document: DocumentRead,
  keys: readonly string[],
): number | null {
  const record = document as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return key.endsWith('_seconds') ? value * 1000 : value;
    }
  }

  return null;
}

function completedPageCount(document: DocumentRead): number {
  const pageCount = Math.max(0, document.page_count);
  if (pageCount === 0) {
    return 0;
  }

  if (
    document.processed_page_count >= pageCount ||
    (document.status === 'ready' && document.chunks_count >= pageCount)
  ) {
    return pageCount;
  }

  return Math.max(0, Math.min(pageCount, document.processed_page_count));
}

function formatMetricDuration(milliseconds: number): string {
  return `${Math.max(0, Math.round(milliseconds))} ms`;
}

function formatMetricCount(count: number): string {
  return Math.max(0, Math.round(count)).toString();
}
