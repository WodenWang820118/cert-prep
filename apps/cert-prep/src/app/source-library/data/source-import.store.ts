import {
  computed,
  effect,
  inject,
  Injectable,
  signal,
  untracked,
} from '@angular/core';
import { forkJoin, from, map, Subscription } from 'rxjs';
import { CERT_PREP_API } from '../../core/data';
import type { ChunkRead, SourceRead } from '../../core/domain';
import { isSourceOperationEventTerminal } from '../../core/domain';
import type { SourceOperationEvent } from '../../core/domain';
import { CertPrepHttpResourceClient } from '../../core/data';
import { CertPrepSseClient } from '../../core/data';
import type {
  LanguageHint,
  SourceActivity,
  SourceFileSelectionOptions,
  SourceUploadItem,
  UploadTransportRun,
} from '../domain';
import { SourcePreparationMetricsService } from './source-preparation-metrics.service';
import { SourceLibraryStore } from './source-library.store';
import { OperationStore } from '../../core/data';
import { ProjectStore } from '../../projects/data';
import { SourceUploadLifecycle } from './source-upload-lifecycle';
import {
  DEFAULT_UPLOAD_BATCH_SIZE,
  FINAL_SOURCE_STATUSES,
  MAX_UPLOAD_BATCH_SIZE,
  MIN_UPLOAD_BATCH_SIZE,
  SOURCE_FILE_ACCEPT,
  SUPPORTED_SOURCE_FILE_EXTENSIONS,
  SUPPORTED_SOURCE_MIME_TYPES,
  TRANSCRIPT_MUTATION_ACTIONS,
} from '../domain';

@Injectable({ providedIn: 'root' })
export class SourceImportStore {
  private readonly api = inject(CERT_PREP_API);
  private readonly library = inject(SourceLibraryStore);
  private readonly metrics = inject(SourcePreparationMetricsService);
  private readonly operations = inject(OperationStore);
  private readonly projects = inject(ProjectStore);
  private readonly resources = inject(CertPrepHttpResourceClient);
  private readonly sse = inject(CertPrepSseClient);
  private readonly sourceQueryEnabled = signal(false);
  private readonly sourcesResource = this.resources.sources(() =>
    this.sourceQueryEnabled() ? this.projects.selectedProjectId() : null,
  );
  private readonly activeSourceResource = this.resources.source(
    () =>
      this.sourceQueryEnabled() ? this.projects.selectedProjectId() : null,
    () =>
      this.sourceQueryEnabled() ? this.library.activeSourceId() : null,
  );
  private readonly chunksResource = this.resources.sourceChunks(
    () =>
      this.sourceQueryEnabled() ? this.projects.selectedProjectId() : null,
    () =>
      this.sourceQueryEnabled() ? this.library.activeSourceId() : null,
  );
  private sourceStreamSubscription: Subscription | null = null;
  private sourceStreamKey: string | null = null;
  private sourceStreamOperationId: string | null = null;
  private sourceStreamTerminalSeen = false;
  private sourceChunksSubscription: Subscription | null = null;
  private sourceChunksRequestRevision = 0;
  private contextEpoch = 0;
  private uploadItemCounter = 0;
  private readonly pendingAutoUploadItemIds = new Set<string>();
  private readonly pendingAutoUploadRevision = signal(0);
  private autoUploadEnqueueScheduled = false;
  private readonly uploadLifecycle = inject(SourceUploadLifecycle);

  private configureUploadLifecycle(): void {
    this.uploadLifecycle.configure({
      item: (itemId) =>
        this.uploadItems().find((candidate) => candidate.id === itemId),
      current: (projectId, contextEpoch) =>
        this.isCurrentUploadContext(projectId, contextEpoch),
      patch: (itemId, patch) => this.updateUploadItem(itemId, patch),
      accept: (source, operationId) =>
        this.acceptLifecycleSource(source, operationId),
      upload: (projectId, item, operationId, signal) => {
        const formData = new FormData();
        formData.append('file', item.file, item.file.name);
        formData.append('language_hint', this.languageHint());
        return from(this.api.uploadSource(projectId, formData, {
          headers: { 'X-Cert-Prep-Operation-Id': operationId },
          signal,
        }));
      },
      getSource: (projectId, sourceId) =>
        from(this.api.getSource(projectId, sourceId)),
      getOperation: (projectId, operationId) =>
        from(this.api.getSourceOperation(projectId, operationId)),
      streamOperation: (projectId, operationId) =>
        this.streamSourceOperation(projectId, '', operationId),
      cancelOperation: (projectId, operationId) =>
        from(this.api.cancelSourceOperation(projectId, operationId)),
      newOperationId: () => this.newOperationId(),
      errorMessage: (error) => this.getUploadErrorMessage(error),
    });
  }

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
  // Cert Prep is a Japanese study workflow. Keep Japanese as the safe default
  // so the first upload already carries the language needed by OCR/parsing;
  // users can still opt into auto-detection or another supported hint.
  readonly languageHint = signal<LanguageHint>('ja');
  readonly uploadBatchSize = signal(DEFAULT_UPLOAD_BATCH_SIZE);
  readonly uploadItems = signal<SourceUploadItem[]>([]);
  readonly streamError = signal<string | null>(null);
  private readonly latestSourceActivity =
    signal<SourceActivity | null>(null);
  /**
   * The selected project's latest source activity: an upload, a
   * source selection (re-selecting the same source included) or a
   * source becoming active (an upload can finish after the first question
   * query ran). Source Library is upstream of Question Authoring and does not
   * know about questions; Authoring's `QuestionsStore` reloads the project's
   * questions on every activity (D19).
   */
  readonly sourceActivity = this.latestSourceActivity.asReadonly();
  readonly selectedFiles = computed(() =>
    this.uploadItems().map((item) => item.file),
  );
  readonly selectedFile = computed(() => this.selectedFiles()[0] ?? null);
  readonly hasSelectedAudio = computed(() =>
    this.uploadItems().some((item) => this.isAudioSourceFile(item.file)),
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
      return this.activeSource()?.filename ?? 'No source file selected';
    }
    if (files.length === 1) {
      return files[0]?.name ?? 'No source file selected';
    }
    return `${files.length} files selected`;
  });
  readonly sources = this.library.sources;
  readonly sourcesLoading = this.sourcesResource.isLoading;
  readonly sourcesError = this.sourcesResource.error;
  readonly activeSourceId = this.library.activeSourceId;
  readonly uploadedSource = this.library.uploadedSource;
  readonly chunks = this.library.chunks;
  readonly visibleChunkLimit = this.library.visibleChunkLimit;
  readonly activeSource = this.library.activeSource;
  readonly activeSourceSelectValue = this.library.activeSourceSelectValue;
  readonly previewChunks = this.library.previewChunks;
  readonly hiddenChunkCount = this.library.hiddenChunkCount;
  readonly isParsing = computed(() =>
    ['processing', 'cancel_requested'].includes(
      this.activeSource()?.status ?? '',
    ),
  );
  readonly progressPercent = computed(() =>
    this.metrics.progressPercent(this.activeSource()),
  );
  readonly progressLabel = computed(() =>
    this.metrics.progressLabel(this.activeSource()),
  );
  readonly elapsedTime = computed(() =>
    this.metrics.elapsedTime(this.activeSource()),
  );
  readonly canUpload = computed(
    () =>
      this.projects.selectedProject() !== null &&
      this.uploadItems().some(
        (item) =>
          ['queued', 'failed'].includes(item.status) &&
          this.isUploadItemReady(item),
      ) &&
      !this.isUploading(),
  );
  readonly canGenerateQuestions = computed(() => {
    const source = this.activeSource();
    return (
      this.projects.selectedProject() !== null &&
      source !== null &&
      source.has_text &&
      source.chunks_count > 0
    );
  });

  constructor() {
    this.configureUploadLifecycle();
    effect(() => {
      if (this.isResourceSettled(this.sourcesResource.status())) {
        const sources = this.sourcesResource.value();
        untracked(() => {
          this.library.setSources(this.mergeSourceResourceValue(sources));
          this.setActiveSource(this.library.chooseActiveFromSources());
        });
      }

      if (this.isResourceSettled(this.activeSourceResource.status())) {
        const source = this.activeSourceResource.value();
        if (source !== null) {
          untracked(() => {
            this.library.upsertSource(source);
            if (this.activeSourceId() === source.id) {
              this.setActiveSource(source);
              if (
                ['processing', 'cancel_requested'].includes(source.status) &&
                this.sourceStreamSubscription === null
              ) {
                this.startSourceStream(source.project_id, source.id, null);
              }
            }
          });
        }
      }

      if (this.isResourceSettled(this.chunksResource.status())) {
        untracked(() => this.library.setChunks(this.chunksResource.value()));
      }
    });
    effect(() => {
      const projectId = this.projects.selectedProject()?.id ?? null;
      const sourceId = this.activeSourceId();
      if (projectId !== null && sourceId !== null) {
        untracked(() => this.latestSourceActivity.set({ projectId }));
      }
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
      source: null,
      error: null,
    }));
    const appendSelection = options.append ?? this.shouldAppendNewSelection();
    const autoUpload = options.autoUpload ?? appendSelection;
    if (appendSelection) {
      this.uploadItems.update((items) => [...items, ...nextItems]);
    } else {
      this.invalidateUploadContext();
      this.uploadItems.set(nextItems);
      this.library.clearActiveSource();
      this.stopSourceStream();
      this.resetSourceStreamError();
    }
    if (autoUpload) {
      this.rememberPendingAutoUploads(nextItems.map((item) => item.id));
      this.startReadyAutoUploads();
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
    this.resetSourceStreamError();
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

  uploadSource(): void {
    this.uploadSources();
  }

  uploadSources(): void {
    this.startUploads();
    this.reportSourceActivity();
  }

  private startUploads(): void {
    const project = this.projects.selectedProject();
    const uploadItems = this.uploadItems().filter((item) =>
      ['queued', 'failed'].includes(item.status),
    );
    if (project === null) {
      this.operations.fail(
        'Choose a project and one or more source files before uploading.',
      );
      return;
    }
    if (uploadItems.length === 0) {
      if (!this.uploadLifecycle.hasActiveRun()) {
        this.operations.fail(
          'Choose a project and one or more source files before uploading.',
        );
      }
      return;
    }
    this.rememberPendingAutoUploads(uploadItems.map((item) => item.id));
    const readyItems = uploadItems.filter((item) => this.isUploadItemReady(item));
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
        project.id,
        this.contextEpoch,
        itemIds,
        this.uploadBatchSize(),
      );
      return;
    }
    if (
      this.operations.isBusyFor('upload') &&
      !this.uploadLifecycle.hasActiveRun()
    ) {
      this.scheduleReadyAutoUploads();
      return;
    }
    this.forgetPendingAutoUploads(itemIds);
    this.runUploadTransports(project.id, itemIds);
  }

  private runUploadTransports(
    projectId: string,
    itemIds: readonly string[],
  ): void {
    const run = this.uploadLifecycle.begin(
      projectId,
      this.contextEpoch,
      itemIds,
      this.uploadBatchSize(),
    );
    this.finishUploadTransports(projectId, run);
  }

  private finishUploadTransports(
    projectId: string,
    run: UploadTransportRun,
  ): void {
    this.operations
      .run(
        'upload',
        (sources) => this.uploadOutcomeMessage(run.itemIds, sources),
        () => run.done.pipe(map(() => [...run.sources])),
        () => this.isCurrentUploadContext(projectId, run.contextEpoch),
      )
      .subscribe((result) => {
        if (!this.isCurrentUploadContext(projectId, run.contextEpoch)) return;
        const sources = result ?? [];
        const activeSource = sources[sources.length - 1] ?? null;
        if (activeSource !== null) {
          this.setActiveSource(activeSource);
          this.refreshUploadedSource(projectId, activeSource.id);
        }
        const failedCount = this.failedUploadCount();
        if (failedCount > 0) this.operations.error.set(failedCount === 1 ? '1 source file failed to upload.' : `${failedCount} source files failed to upload.`);
        this.startReadyAutoUploads();
      });
  }

  private uploadOutcomeMessage(
    itemIds: readonly string[],
    sources: readonly SourceRead[],
  ): string {
    const acceptedCount = sources.length;
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

  loadLatestSource(projectId: string): void {
    if (this.projects.selectedProjectId() !== projectId) {
      return;
    }
    if (!this.sourceQueryEnabled()) {
      this.sourceQueryEnabled.set(true);
      return;
    }
    this.sourcesResource.reload();
  }

  setActiveSourceId(sourceId: string | null): void {
    if (this.library.setActiveSourceId(sourceId)) {
      this.stopSourceStream();
      this.resetSourceStreamError();
    }
  }

  selectSource(sourceId: string): void {
    this.showSource(sourceId);
    this.reportSourceActivity();
  }

  private showSource(sourceId: string): void {
    const projectId = this.projects.selectedProject()?.id;
    const previousSourceId = this.activeSourceId();
    this.setActiveSourceId(sourceId);
    if (projectId === undefined || this.activeSourceId() !== sourceId) {
      return;
    }
    if (previousSourceId !== sourceId) {
      this.library.clearChunks();
      this.stopSourceStream();
    }

    if (!this.sourceQueryEnabled()) {
      this.sourceQueryEnabled.set(true);
      return;
    }
    this.activeSourceResource.reload();
    this.chunksResource.reload();
  }

  private reportSourceActivity(): void {
    const project = this.projects.selectedProject();
    if (project !== null) {
      this.latestSourceActivity.set({ projectId: project.id });
    }
  }

  refreshUploadedSource(
    projectId?: string,
    sourceId?: string,
  ): void {
    const project = projectId ?? this.projects.selectedProject()?.id;
    const source =
      sourceId ?? this.activeSourceId() ?? this.activeSource()?.id;
    if (project === undefined || source === undefined) {
      return;
    }
    if (sourceId !== undefined && this.activeSourceId() !== sourceId) {
      this.activeSourceId.set(sourceId);
    }

    forkJoin({
      source: from(this.api.getSource(project, source)),
      chunks: this.loadSourceChunks(project, source),
    }).subscribe({
      next: ({ source: nextSource, chunks }) => {
        this.library.upsertSource(nextSource);
        if (!this.isCurrentProjectSource(project, source)) return;
        this.setActiveSource(nextSource);
        this.library.setChunks(chunks);
        this.updateUploadSourceSnapshot(nextSource);
        this.resetSourceStreamError();
        if (
          ['processing', 'cancel_requested'].includes(nextSource.status) &&
          this.sourceStreamSubscription === null
        ) {
          const operationId =
            this.sourceStreamKey === `${project}:${source}`
              ? this.sourceStreamOperationId
              : null;
          this.startSourceStream(project, source, operationId);
        }
      },
      error: () => this.streamError.set('Source progress could not be refreshed. Retry the event stream.'),
    });
  }

  retrySourceStream(): void {
    const projectId = this.projects.selectedProject()?.id;
    const sourceId = this.activeSourceId();
    if (projectId === undefined || sourceId === null) {
      return;
    }

    this.resetSourceStreamError();
    if (this.sourceStreamOperationId !== null) {
      this.startSourceStream(projectId, sourceId, this.sourceStreamOperationId);
    } else {
      this.refreshUploadedSource(projectId, sourceId);
    }
  }

  canCancelUploadItem(item: SourceUploadItem): boolean {
    return (
      ['queued', 'uploading', 'cancel_requested'].includes(item.status) ||
      (item.status === 'uploaded' &&
        ['processing', 'cancel_requested'].includes(item.source?.status ?? ''))
    );
  }

  canRetryUploadItem(item: SourceUploadItem): boolean {
    return (
      item.status === 'status_unavailable' ||
      (item.source === null && ['failed', 'canceled'].includes(item.status))
    );
  }

  cancelUploadItem(itemId: string): void {
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
    const source = item.source;
    if (source === null) {
      return;
    }

    this.updateUploadItem(item.id, {
      status: 'cancel_requested',
      error: null,
    });
    from(this.api.cancelSourceProcessing(projectId, source.id)).subscribe({
      next: (operation) => {
        this.startSourceStream(projectId, source.id, operation.id);
      },
      error: (error: unknown) => this.updateUploadItem(item.id, { status: 'failed', error: this.getUploadErrorMessage(error) }),
    });
  }

  retryUploadItem(itemId: string): void {
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
        this.finishUploadTransports(projectId, resumed.run);
      }
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
    if (
      this.operations.isBusyFor('upload') &&
      !this.uploadLifecycle.hasActiveRun()
    ) {
      this.scheduleReadyAutoUploads();
      return;
    }
    this.forgetPendingAutoUploads([item.id]);
    this.runUploadTransports(projectId, [item.id]);
  }

  cancelActiveSourceProcessing(): void {
    const projectId = this.projects.selectedProject()?.id;
    const source = this.activeSource();
    if (
      projectId === undefined ||
      source === null ||
      !['processing', 'cancel_requested'].includes(source.status)
    ) {
      return;
    }
    this.operations
      .run('source-cancel', 'Parsing cancellation requested', (signal) =>
        this.api.cancelSourceProcessing(projectId, source.id, { signal }),
      )
      .subscribe((canceled) => {
        if (canceled !== null) {
          this.startSourceStream(projectId, source.id, canceled.id);
        }
      });
  }

  retryActiveSourceProcessing(): void {
    const projectId = this.projects.selectedProject()?.id;
    const source = this.activeSource();
    if (
      projectId === undefined ||
      source === null ||
      ![
        'canceled',
        'extraction_failed',
        'transcription_failed',
        'no_text_detected',
      ].includes(source.status)
    ) {
      return;
    }
    this.operations
      .run('source-retry', 'Parsing restarted', (signal) =>
        this.api.retrySourceProcessing(projectId, source.id, { signal }),
      )
      .subscribe((retried) => {
        if (retried !== null) {
          this.resetSourceStreamError();
          this.startSourceStream(projectId, source.id, retried.id);
        }
      });
  }

  updateTranscriptChunk(chunkId: string, text: string): void {
    const projectId = this.projects.selectedProject()?.id;
    const sourceId = this.activeSourceId();
    if (
      projectId === undefined ||
      sourceId === null ||
      this.isTranscriptMutationBusy()
    ) {
      return;
    }
    this.operations
      .run('transcript-edit', 'Transcript saved', (signal) =>
        this.api.updateSourceChunk(projectId, sourceId, chunkId, { text }, { signal }),
        () => this.isCurrentProjectSource(projectId, sourceId),
      )
      .subscribe((updated) => {
        if (updated !== null && this.isCurrentProjectSource(projectId, sourceId)) {
          this.library.setChunks(this.chunks().map((chunk) => chunk.id === chunkId ? updated : chunk));
          this.refreshSourceMetadata(projectId, sourceId);
        }
      });
  }

  translateTranscriptChunk(chunkId: string): void {
    const projectId = this.projects.selectedProject()?.id;
    const sourceId = this.activeSourceId();
    if (
      projectId === undefined ||
      sourceId === null ||
      this.isTranscriptMutationBusy()
    ) {
      return;
    }
    this.operations
      .run('transcript-translate', 'Traditional Chinese translation updated', (signal) =>
        this.api.translateSourceChunk(projectId, sourceId, chunkId, { signal }),
        () => this.isCurrentProjectSource(projectId, sourceId),
      )
      .subscribe((translated) => {
        if (translated !== null && this.isCurrentProjectSource(projectId, sourceId)) {
          this.library.setChunks(this.chunks().map((chunk) => chunk.id === chunkId ? translated : chunk));
          this.refreshSourceMetadata(projectId, sourceId);
        }
      });
  }

  translateStaleTranscriptChunks(): void {
    const projectId = this.projects.selectedProject()?.id;
    const sourceId = this.activeSourceId();
    if (
      projectId === undefined ||
      sourceId === null ||
      this.isTranscriptMutationBusy()
    ) {
      return;
    }
    this.operations
      .run('transcript-translate-all', 'Stale translations updated', (signal) =>
        this.api.translateSourceStaleChunks(projectId, sourceId, { signal }),
        () => this.isCurrentProjectSource(projectId, sourceId),
      )
      .subscribe((translated) => {
        if (translated !== null && this.isCurrentProjectSource(projectId, sourceId)) {
          const byId = new Map(translated.items.map((chunk) => [chunk.id, chunk]));
          this.library.setChunks(this.chunks().map((chunk) => byId.get(chunk.id) ?? chunk));
          this.refreshSourceMetadata(projectId, sourceId);
        }
      });
  }

  private refreshSourceMetadata(
    projectId: string,
    sourceId: string,
  ): void {
    from(this.api.getSource(projectId, sourceId)).subscribe({
      next: (source) => {
        if (!this.isCurrentProjectSource(projectId, sourceId)) return;
        this.library.upsertSource(source);
        this.setActiveSource(source);
        this.updateUploadSourceSnapshot(source);
      },
      error: (error: unknown) => console.warn('Unable to refresh source metadata after a transcript mutation.', error),
    });
  }

  private loadSourceChunks(
    projectId: string,
    sourceId: string,
  ): import('rxjs').Observable<ChunkRead[]> {
    return from(this.api.listSourceChunks(projectId, sourceId)).pipe(map((chunks) => chunks.items));
  }

  private refreshSourceChunksFromEvent(
    projectId: string,
    sourceId: string,
  ): void {
    const requestRevision = ++this.sourceChunksRequestRevision;
    this.sourceChunksSubscription?.unsubscribe();
    this.sourceChunksSubscription = this.loadSourceChunks(
      projectId,
      sourceId,
    ).subscribe({
      next: (chunks) => {
        if (
          requestRevision !== this.sourceChunksRequestRevision ||
          !this.isCurrentProjectSource(projectId, sourceId)
        ) {
          return;
        }
        this.library.setChunks(chunks);
        this.resetSourceStreamError();
      },
      error: () => {
        if (
          requestRevision === this.sourceChunksRequestRevision &&
          this.isCurrentProjectSource(projectId, sourceId)
        ) {
          this.streamError.set(
            'Source chunks could not be refreshed from the event. Retry the event stream.',
          );
        }
      },
      complete: () => {
        if (requestRevision === this.sourceChunksRequestRevision) {
          this.sourceChunksSubscription = null;
        }
      },
    });
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
    return item.status === 'queued' || item.status === 'failed';
  }

  private scheduleReadyAutoUploads(): void {
    if (this.autoUploadEnqueueScheduled) {
      return;
    }
    if (
      this.operations.isBusyFor('upload') &&
      !this.uploadLifecycle.hasActiveRun()
    ) {
      this.autoUploadEnqueueScheduled = true;
      queueMicrotask(() => {
        this.autoUploadEnqueueScheduled = false;
        if (!this.operations.isBusyFor('upload')) {
          untracked(() => this.startReadyAutoUploads());
        }
      });
      return;
    }
    untracked(() => this.startReadyAutoUploads());
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
    this.runUploadTransports(projectId, itemIds);
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

  private acceptLifecycleSource(
    source: SourceRead,
    operationId: string,
  ): void {
    this.library.upsertSource(source);
    this.setActiveSource(source);
    this.updateUploadSourceSnapshot(source);
    if (!FINAL_SOURCE_STATUSES.has(source.status)) {
      this.startSourceStream(source.project_id, source.id, operationId);
    }
  }

  private updateUploadSourceSnapshot(source: SourceRead): void {
    this.uploadItems.update((items) =>
      items.map((item) =>
        item.source?.id === source.id ? { ...item, source } : item,
      ),
    );
  }

  private invalidateUploadContext(): void {
    this.contextEpoch += 1;
    this.clearPendingAutoUploads();
    this.stopSourceStream();
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

  private mergeSourceResourceValue(
    sources: readonly SourceRead[],
  ): SourceRead[] {
    const projectId = this.projects.selectedProjectId();
    const knownSources = this.library
      .sources()
      .filter((source) => source.project_id === projectId);
    const loadedSourceIds = new Set(sources.map((source) => source.id));
    return [
      ...knownSources.filter((source) => !loadedSourceIds.has(source.id)),
      ...sources,
    ];
  }

  private setActiveSource(source: SourceRead | null): void {
    if (this.library.setActiveSource(source)) {
      this.stopSourceStream();
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

  private startSourceStream(
    projectId: string,
    sourceId: string,
    operationId: string | null,
  ): void {
    const key = `${projectId}:${sourceId}`;
    if (this.sourceStreamKey === key && this.sourceStreamSubscription !== null) {
      return;
    }
    this.stopSourceStream();
    this.sourceStreamKey = key;
    this.sourceStreamOperationId = operationId;
    this.sourceStreamTerminalSeen = false;
    this.resetSourceStreamError();
    this.sourceStreamSubscription = this.streamSourceOperation(
      projectId,
      sourceId,
      operationId,
    ).subscribe({
      next: (event) => {
        this.sourceStreamTerminalSeen ||= isSourceOperationEventTerminal(event);
        this.applySourceOperationEvent(projectId, sourceId, event);
      },
      error: () => {
        if (this.sourceStreamKey === key) {
          this.sourceStreamSubscription = null;
          this.streamError.set('Source progress could not be refreshed. Retry the event stream.');
        }
      },
      complete: () => {
        if (this.sourceStreamKey !== key) return;
        this.sourceStreamSubscription = null;
        if (!this.sourceStreamTerminalSeen) {
          this.streamError.set('Source progress could not be refreshed. Retry the event stream.');
        }
      },
    });
  }

  private streamSourceOperation(
    projectId: string,
    sourceId: string,
    operationId: string | null,
  ): import('rxjs').Observable<SourceOperationEvent> {
    const path =
      operationId === null
        ? `/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(sourceId)}/source-operation/events`
        : `/projects/${encodeURIComponent(projectId)}/source-operations/${encodeURIComponent(operationId)}/events`;
    return this.sse.streamJson<SourceOperationEvent>(
      path,
      'source-operation',
      { isTerminal: isSourceOperationEventTerminal },
    );
  }

  private applySourceOperationEvent(
    projectId: string,
    sourceId: string,
    event: SourceOperationEvent,
  ): void {
    if (!this.isCurrentProjectSource(projectId, sourceId)) return;
    this.sourceStreamOperationId = event.operation.id;
    const source = event.source;
    if (source === null) return;
    this.library.upsertSource(source);
    this.setActiveSource(source);
    this.updateUploadSourceSnapshot(source);
    this.refreshSourceChunksFromEvent(projectId, source.id);
  }

  private resetSourceStreamError(): void {
    this.streamError.set(null);
  }

  private stopSourceStream(): void {
    this.sourceStreamSubscription?.unsubscribe();
    this.sourceStreamSubscription = null;
    this.cancelSourceChunksRefresh();
    this.sourceStreamKey = null;
    this.sourceStreamOperationId = null;
  }

  private cancelSourceChunksRefresh(): void {
    this.sourceChunksRequestRevision += 1;
    this.sourceChunksSubscription?.unsubscribe();
    this.sourceChunksSubscription = null;
  }

  private isCurrentProjectSource(projectId: string, sourceId: string): boolean {
    return (
      this.projects.selectedProjectId() === projectId &&
      this.activeSourceId() === sourceId
    );
  }

  private isResourceSettled(status: string): boolean {
    return status === 'resolved' || status === 'local';
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
