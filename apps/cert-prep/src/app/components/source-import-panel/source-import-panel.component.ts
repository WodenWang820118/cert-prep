import {
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ProgressBar } from 'primeng/progressbar';
import { Tag } from 'primeng/tag';
import { ToggleSwitch } from 'primeng/toggleswitch';
import { DraftReviewStore } from '../../stores/draft-review/draft-review.store';
import { OperationStore } from '../../stores/operation.store';
import { ProjectStore } from '../../stores/project.store';
import { SourceImportStore } from '../../stores/source-import/source-import.store';
import { CERT_PREP_API, type ChunkRead } from '../../cert-prep-api';
import { SourceImageCropDialogComponent } from './source-image-crop-dialog.component';
import { isCroppableImageFile } from './source-image-crop.service';

@Component({
  selector: 'app-source-import-panel',
  imports: [
    FormsModule,
    ProgressBar,
    SourceImageCropDialogComponent,
    Tag,
    ToggleSwitch,
  ],
  template: `
    <section class="workbench-panel" aria-labelledby="source-heading">
      <header class="workbench-panel-header">
        <div class="workbench-panel-title">
          <span class="workbench-panel-icon" aria-hidden="true">
            <i class="pi pi-file"></i>
          </span>
          <h2 id="source-heading">Step 01: Source files</h2>
        </div>
        <label
          #chooseFilesControl
          class="workbench-secondary-button"
          tabindex="-1"
          [attr.for]="isUploadBusy() ? null : 'sourceFiles'"
          [attr.aria-disabled]="isUploadBusy()"
        >
          <i class="pi pi-upload" aria-hidden="true"></i>
          <span>Choose files</span>
        </label>
      </header>

      <div class="workbench-panel-body">
        <input
          id="sourceFiles"
          class="sr-only"
          type="file"
          [accept]="sourceImport.sourceFileAccept"
          multiple
          aria-label="Source files"
          [disabled]="isUploadBusy()"
          (change)="chooseFiles($event)"
        />

        <div
          class="flex flex-wrap items-center justify-between gap-3 rounded-md border border-surface-200 bg-surface-50 p-3"
        >
          <div class="min-w-0 flex-1">
            <label
              id="crop-images-label"
              class="block cursor-pointer text-sm font-semibold text-color"
              for="cropImagesBeforeUpload"
            >
              Crop images before upload
            </label>
            <p class="m-0 mt-1 text-xs leading-5 text-muted-color">
              Review PNG, JPEG, and WebP images one at a time. PDF files stay
              unchanged.
            </p>
          </div>
          <p-toggleswitch
            inputId="cropImagesBeforeUpload"
            ariaLabelledBy="crop-images-label"
            [ngModel]="cropImagesBeforeUpload()"
            [disabled]="isUploadBusy()"
            (ngModelChange)="setCropImagesBeforeUpload($event)"
          />
        </div>

        <div class="workbench-file-row">
          <div class="workbench-file-name">
            <i class="pi pi-file" aria-hidden="true"></i>
            <span>{{ sourceImport.selectedFileLabel() }}</span>
          </div>
          <span class="workbench-tag">
            {{
              sourceImport.isUploading()
                ? 'Uploading'
                : (sourceImport.activeDocument()?.status ?? 'Waiting')
            }}
          </span>
        </div>

        @if (sourceImport.hasSelectedAudio()) {
          <section
            class="grid gap-2 rounded-md border border-surface-200 bg-surface-50 p-3"
            aria-label="Whisper model preflight"
            aria-live="polite"
          >
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="min-w-0 flex-1">
                <p class="m-0 text-sm font-semibold text-color">
                  Whisper speech models
                </p>
                <p class="m-0 mt-1 text-xs leading-5 text-muted-color">
                  @if (sourceImport.whisperModelsReady()) {
                    large-v3-turbo and the CPU small fallback are ready.
                  } @else if (sourceImport.whisperModelInstall(); as install) {
                    {{ install.message }}
                  } @else if (sourceImport.whisperModelsRequirement()) {
                    Download consent is required before audio can be uploaded.
                  } @else {
                    Checking the local model inventory.
                  }
                </p>
              </div>
              <p-tag
                [value]="sourceImport.whisperModelsReady() ? 'Ready' : 'Required'"
                [severity]="sourceImport.whisperModelsReady() ? 'success' : 'warn'"
                [rounded]="true"
              />
              @if (sourceImport.canCancelWhisperModelDownload()) {
                <button
                  class="workbench-secondary-button"
                  type="button"
                  (click)="sourceImport.cancelWhisperModelDownload()"
                >
                  <i class="pi pi-times" aria-hidden="true"></i>
                  <span>Cancel model download</span>
                </button>
              }
            </div>
            @if (sourceImport.whisperModelInstall(); as install) {
              @if (install.progress !== null) {
                <p-progressbar [value]="install.progress" />
              }
            }
          </section>
        }

        @if (sourceImport.uploadItems().length > 0) {
          <div
            class="grid gap-2"
            aria-label="Selected source file upload status"
          >
            @for (item of sourceImport.uploadItems(); track item.id) {
              <div
                class="flex flex-wrap items-center justify-between gap-2 rounded-md border border-surface-200 bg-surface-0 p-3"
              >
                <div class="min-w-0 flex-1">
                  <p class="m-0 truncate text-sm font-semibold text-color">
                    {{ item.file.name }}
                  </p>
                  <p class="m-0 mt-1 text-xs font-semibold text-muted-color">
                    {{ formatFileSize(item.file) }}
                    @if (item.document) {
                      / {{ item.document.chunks_count }} chunks
                    }
                    @if (item.error) {
                      / {{ item.error }}
                    }
                  </p>
                </div>
                <p-tag
                  [value]="uploadStatusLabel(item.status)"
                  [severity]="uploadStatusSeverity(item.status)"
                  [rounded]="true"
                />
                @if (sourceImport.canCancelUploadItem(item)) {
                  <button
                    class="workbench-secondary-button"
                    type="button"
                    [disabled]="item.status === 'cancel_requested'"
                    (click)="sourceImport.cancelUploadItem(item.id)"
                  >
                    <i class="pi pi-times" aria-hidden="true"></i>
                    <span>
                      {{
                        item.status === 'cancel_requested'
                          ? 'Canceling'
                          : 'Cancel'
                      }}
                    </span>
                  </button>
                }
              </div>
            }
          </div>
        }

        <div class="flex flex-wrap items-end gap-3">
          <label class="workbench-field min-w-32 flex-1">
            <span>Language</span>
            <select
              [ngModel]="sourceImport.languageHint()"
              (ngModelChange)="sourceImport.setLanguageHint($event)"
            >
              @for (language of sourceImport.languageHints; track language) {
                <option [value]="language">{{ language }}</option>
              }
            </select>
          </label>
          <label class="workbench-field min-w-32 flex-1">
            <span>Batch size</span>
            <select
              [ngModel]="sourceImport.uploadBatchSize()"
              [disabled]="isUploadBusy()"
              (ngModelChange)="sourceImport.setUploadBatchSize($event)"
            >
              @for (size of sourceImport.uploadBatchSizes; track size) {
                <option [value]="size">{{ size }}</option>
              }
            </select>
          </label>
          <button
            class="workbench-action-button min-w-32 flex-none"
            type="button"
            [disabled]="
              isUploadBusy() ||
              operations.isBusyFor('upload') ||
              !sourceImport.canUpload()
            "
            (click)="uploadDocument()"
          >
            <i
              [class]="
                operations.isBusyFor('upload')
                  ? 'pi pi-spin pi-spinner'
                  : 'pi pi-upload'
              "
              aria-hidden="true"
            ></i>
            <span>Upload files</span>
          </button>
        </div>

        @if (sourceImport.documents().length > 0) {
          <label class="workbench-field">
            <span>Project document library</span>
            <select
              [ngModel]="sourceImport.activeDocumentSelectValue()"
              (ngModelChange)="selectDocument($event)"
            >
              @for (document of sourceImport.documents(); track document.id) {
                <option [value]="document.id">
                  {{ document.filename }} - {{ document.status }} -
                  {{ document.chunks_count }} chunks
                </option>
              }
            </select>
          </label>
        }

        @if (sourceImport.activeDocument(); as document) {
          <section class="grid gap-3" aria-live="polite">
            <div
              class="flex flex-wrap items-center justify-between gap-2 rounded-md border border-surface-200 bg-surface-50 p-3"
            >
              <div class="min-w-0 flex-1">
                <p class="m-0 truncate text-sm font-semibold text-color">
                  {{ sourceImport.parseStageText() }}
                </p>
                <p class="m-0 mt-1 text-xs font-semibold text-muted-color">
                  {{ sourceImport.progressLabel() }} /
                  {{ document.chunks_count }} chunks /
                  {{ sourceImport.elapsedTime() }}
                </p>
              </div>
              <p-tag
                [value]="document.status"
                [severity]="
                  document.status === 'processing'
                    ? 'info'
                    : document.status === 'ready'
                      ? 'success'
                      : 'warn'
                "
                [rounded]="true"
              />
              @if (
                document.status === 'processing' ||
                document.status === 'cancel_requested'
              ) {
                <button
                  class="workbench-secondary-button"
                  type="button"
                  [disabled]="
                    document.status === 'cancel_requested' ||
                    operations.isBusyFor('document-cancel')
                  "
                  (click)="sourceImport.cancelActiveDocumentProcessing()"
                >
                  <i class="pi pi-times" aria-hidden="true"></i>
                  <span>
                    {{
                      document.status === 'cancel_requested'
                        ? 'Canceling'
                        : document.source_kind === 'audio'
                          ? 'Cancel audio processing'
                          : 'Cancel parsing'
                    }}
                  </span>
                </button>
              } @else if (
                document.status === 'canceled' ||
                document.status === 'ocr_failed' ||
                document.status === 'transcription_failed' ||
                document.status === 'no_text_detected' ||
                document.status === 'exam_failed'
              ) {
                <button
                  class="workbench-secondary-button"
                  type="button"
                  [disabled]="operations.isBusyFor('document-retry')"
                  (click)="sourceImport.retryActiveDocumentProcessing()"
                >
                  <i class="pi pi-refresh" aria-hidden="true"></i>
                  <span>
                    {{
                      document.source_kind === 'audio'
                        ? 'Retry audio processing'
                        : 'Retry parsing'
                    }}
                  </span>
                </button>
              }
            </div>
            <p-progressbar
              [value]="sourceImport.progressPercent()"
              [showValue]="false"
            />
            @if (sourceImport.pollingError(); as pollingError) {
              <div
                class="flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 p-3"
                role="alert"
              >
                <span class="text-sm font-semibold text-red-900">
                  {{ pollingError }}
                </span>
                <button
                  class="workbench-secondary-button"
                  type="button"
                  (click)="sourceImport.retryDocumentPolling()"
                >
                  <i class="pi pi-refresh" aria-hidden="true"></i>
                  <span>Retry progress</span>
                </button>
              </div>
            }
          </section>

          <dl class="workbench-metrics">
            <div class="workbench-metric">
              <dt>File Size</dt>
              <dd>{{ formatFileSize(activeDocumentFile()) }}</dd>
            </div>
            @if (document.source_kind === 'audio') {
              <div class="workbench-metric">
                <dt>Duration</dt>
                <dd>{{ formatDuration(document.duration_ms) }}</dd>
              </div>
            } @else {
              <div class="workbench-metric">
                <dt>Pages</dt>
                <dd>{{ document.page_count }}</dd>
              </div>
            }
            <div class="workbench-metric">
              <dt>Text Chunks</dt>
              <dd>{{ document.chunks_count }}</dd>
            </div>
            <div class="workbench-metric">
              <dt>Mock Items</dt>
              <dd>
                {{ document.exam_item_count }}
              </dd>
            </div>
            @if (document.source_kind !== 'audio') {
              <div class="workbench-metric">
                <dt>Processed</dt>
                <dd>
                  {{ document.processed_page_count }}
                </dd>
              </div>
            }
            <div class="workbench-metric">
              <dt>Language</dt>
              <dd>
                {{ document.language_hint }}
              </dd>
            </div>
            <div class="workbench-metric">
              <dt>Status</dt>
              <dd>{{ document.status }}</dd>
            </div>
            <div class="workbench-metric">
              <dt>Extraction</dt>
              <dd>{{ document.extraction_method }}</dd>
            </div>
            @if (document.source_kind === 'audio') {
              <div class="workbench-metric">
                <dt>Transcription</dt>
                <dd>{{ document.transcription_status || 'pending' }}</dd>
              </div>
              <div class="workbench-metric">
                <dt>Translation</dt>
                <dd>{{ document.translation_status || 'pending' }}</dd>
              </div>
              <div class="workbench-metric">
                <dt>Configured ASR Model</dt>
                <dd>{{ document.configured_transcription_model || 'pending' }}</dd>
              </div>
              <div class="workbench-metric">
                <dt>Effective ASR Model</dt>
                <dd>{{ document.effective_transcription_model || 'pending' }}</dd>
              </div>
              <div class="workbench-metric">
                <dt>ASR Device</dt>
                <dd>{{ document.transcription_device || 'pending' }}</dd>
              </div>
            } @else {
              <div class="workbench-metric">
                <dt>OCR Device</dt>
                <dd>
                  {{ document.ocr_device || 'none' }}
                </dd>
              </div>
              @for (
                metric of sourceImport.parsingMetrics(document);
                track metric.label
              ) {
                <div class="workbench-metric">
                  <dt>{{ metric.label }}</dt>
                  <dd>{{ metric.value }}</dd>
                </div>
              }
            }
            @if (
              document.source_kind === 'audio' && document.transcription_warning
            ) {
              <div
                class="rounded-md border border-amber-200 bg-amber-50 p-3 xl:col-span-2"
              >
                <dt class="text-xs font-bold uppercase text-amber-700">
                  ASR warning
                </dt>
                <dd class="m-0 mt-1 text-sm font-semibold text-amber-900">
                  {{ document.transcription_warning }}
                </dd>
              </div>
            } @else if (document.ocr_fallback_reason) {
              <div
                class="rounded-md border border-amber-200 bg-amber-50 p-3 xl:col-span-2"
              >
                <dt class="text-xs font-bold uppercase text-amber-700">
                  OCR fallback
                </dt>
                <dd class="m-0 mt-1 text-sm font-semibold text-amber-900">
                  {{ document.ocr_fallback_reason }}
                </dd>
              </div>
            }
          </dl>

          @if (sourceImport.previewChunks().length > 0) {
            <section
              class="workbench-preview"
              aria-labelledby="extracted-text-heading"
            >
              <div class="workbench-preview-header">
                <h3 id="extracted-text-heading">Extracted Text Preview</h3>
                @if (document.source_kind === 'audio') {
                  <button
                    class="workbench-secondary-button"
                    type="button"
                    [disabled]="sourceImport.isTranscriptMutationBusy()"
                    (click)="sourceImport.translateStaleTranscriptChunks()"
                  >
                    重翻所有過期片段
                  </button>
                } @else {
                  <i class="pi pi-search" aria-hidden="true"></i>
                }
              </div>
              @if (document.source_kind === 'audio') {
                <div
                  class="rounded-md border border-surface-200 bg-surface-50 p-3"
                >
                  @if (audioSourceLoading()) {
                    <p class="m-0 text-sm font-semibold text-muted-color">
                      Loading authenticated source audio…
                    </p>
                  } @else if (audioSourceError(); as sourceError) {
                    <p class="m-0 text-sm font-semibold text-red-700" role="alert">
                      {{ sourceError }}
                    </p>
                    <button
                      class="workbench-secondary-button mt-2"
                      type="button"
                      (click)="retryAudioSource()"
                    >
                      <i class="pi pi-refresh" aria-hidden="true"></i>
                      <span>Retry audio playback</span>
                    </button>
                  } @else if (audioSourceUrl()) {
                    <audio
                      #audioPlayer
                      class="w-full"
                      controls
                      preload="metadata"
                      [src]="audioSourceUrl()"
                      aria-label="Source audio playback"
                    ></audio>
                  }
                </div>
              }
              <div class="workbench-preview-list">
                @for (chunk of sourceImport.previewChunks(); track chunk.id) {
                  <article class="workbench-preview-chunk">
                    <strong>
                      @if (chunk.locator_kind === 'time') {
                        {{ formatTimestamp(chunk.start_ms) }}–{{ formatTimestamp(chunk.end_ms) }}
                      } @else {
                        Page {{ chunk.page_number }} - Chunk {{ chunk.chunk_index + 1 }}
                      }
                    </strong>
                    @if (chunk.locator_kind === 'time') {
                      <button
                        class="workbench-secondary-button mt-2"
                        type="button"
                        [disabled]="audioSourceUrl() === null"
                        [attr.aria-label]="segmentPlaybackLabel(chunk)"
                        (click)="playTranscriptChunk(chunk)"
                      >
                        <i class="pi pi-play" aria-hidden="true"></i>
                        <span>從此片段播放</span>
                      </button>
                      <label class="workbench-field mt-2">
                        <span>日文原文</span>
                        <textarea #japaneseText rows="3">{{ chunk.text }}</textarea>
                      </label>
                      <div class="mt-2 flex flex-wrap gap-2">
                        <button class="workbench-secondary-button" type="button"
                          [disabled]="sourceImport.isTranscriptMutationBusy()"
                          (click)="sourceImport.updateTranscriptChunk(chunk.id, japaneseText.value)">
                          儲存日文
                        </button>
                        <button class="workbench-secondary-button" type="button"
                          [disabled]="sourceImport.isTranscriptMutationBusy()"
                          (click)="sourceImport.translateTranscriptChunk(chunk.id)">
                          重新翻譯
                        </button>
                      </div>
                      <p class="mt-3 whitespace-pre-wrap">
                        <strong>繁體中文</strong><br />
                        {{ chunk.translated_text || '尚未完成翻譯' }}
                      </p>
                      @if (chunk.translation_stale) {
                        <p class="text-sm font-semibold text-amber-700">翻譯已過期</p>
                      }
                    } @else {
                      <p class="whitespace-pre-wrap">{{ chunk.text }}</p>
                    }
                  </article>
                }
                @if (sourceImport.hiddenChunkCount() > 0) {
                  <div
                    class="flex flex-wrap items-center justify-between gap-2 p-3"
                  >
                    <p class="m-0 text-sm text-muted-color">
                      {{ sourceImport.hiddenChunkCount() }} more chunks
                      available.
                    </p>
                    <button
                      class="workbench-secondary-button"
                      type="button"
                      (click)="sourceImport.showMoreChunks()"
                    >
                      <i class="pi pi-chevron-down" aria-hidden="true"></i>
                      <span>Show more</span>
                    </button>
                  </div>
                }
              </div>
            </section>
          } @else if (sourceImport.isParsing()) {
            <p
              class="m-0 rounded-md border border-dashed border-surface-300 bg-surface-0 p-3 text-sm text-muted-color"
            >
              Waiting for the first extracted chunk.
            </p>
          }
        } @else {
          <p
            class="m-0 rounded-md border border-dashed border-surface-300 bg-surface-0 p-3 text-sm text-muted-color"
          >
            Choose PDF, PNG, JPEG, WebP, MP3, WAV, or M4A files and upload them to
            start extraction.
          </p>
        }
      </div>

      <app-source-image-crop-dialog
        [sourceFile]="cropSourceFile()"
        [position]="cropPosition()"
        [total]="cropTotal()"
        (cropApplied)="applyCroppedImage($event)"
        (originalKept)="keepOriginalImage()"
      />
    </section>
  `,
})
export class SourceImportPanelComponent {
  private readonly api = inject(CERT_PREP_API);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly drafts = inject(DraftReviewStore);
  protected readonly operations = inject(OperationStore);
  protected readonly projects = inject(ProjectStore);
  protected readonly sourceImport = inject(SourceImportStore);
  protected readonly cropImagesBeforeUpload = signal(false);
  protected readonly cropSourceFile = signal<File | null>(null);
  protected readonly cropPosition = signal(0);
  protected readonly cropTotal = signal(0);
  protected readonly audioSourceUrl = signal<string | null>(null);
  protected readonly audioSourceLoading = signal(false);
  protected readonly audioSourceError = signal<string | null>(null);
  private readonly chooseFilesControl =
    viewChild<ElementRef<HTMLLabelElement>>('chooseFilesControl');
  private readonly audioPlayer =
    viewChild<ElementRef<HTMLAudioElement>>('audioPlayer');
  private readonly cropDialog = viewChild(SourceImageCropDialogComponent);
  private pendingSelectedFiles: File[] = [];
  private pendingCropIndexes: number[] = [];
  private pendingCropCursor = 0;
  private audioSourceObjectUrl: string | null = null;
  private audioSourceAbortController: AbortController | null = null;
  private audioSourceLoadId = 0;
  private requestedAudioSourceKey: string | null = null;

  constructor() {
    effect(() => {
      const projectId = this.projects.selectedProject()?.id ?? null;
      const document = this.sourceImport.activeDocument();
      void this.loadAudioSource(
        projectId,
        document?.source_kind === 'audio' && document.chunks_count > 0
          ? document.id
          : null,
      );
    });
    this.destroyRef.onDestroy(() => {
      this.audioSourceLoadId += 1;
      this.cancelAudioSourceLoad();
      this.releaseAudioSourceUrl();
    });
  }

  protected chooseFiles(event: Event): void {
    if (this.isUploadBusy()) {
      return;
    }
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (
      !this.cropImagesBeforeUpload() ||
      !files.some((file) => isCroppableImageFile(file))
    ) {
      this.sourceImport.chooseFiles(files);
      return;
    }

    this.pendingSelectedFiles = [...files];
    this.pendingCropIndexes = files.flatMap((file, index) =>
      isCroppableImageFile(file) ? [index] : [],
    );
    this.pendingCropCursor = 0;
    this.cropTotal.set(this.pendingCropIndexes.length);
    this.openCurrentCrop();
  }

  protected setCropImagesBeforeUpload(enabled: boolean): void {
    if (!this.isUploadBusy()) {
      this.cropImagesBeforeUpload.set(enabled);
    }
  }

  protected applyCroppedImage(file: File): void {
    const fileIndex = this.pendingCropIndexes[this.pendingCropCursor];
    if (fileIndex === undefined) {
      return;
    }
    this.pendingSelectedFiles[fileIndex] = file;
    this.advanceCropReview();
  }

  protected keepOriginalImage(): void {
    if (this.pendingCropIndexes[this.pendingCropCursor] !== undefined) {
      this.advanceCropReview();
    }
  }

  protected async uploadDocument(): Promise<void> {
    const documents = await this.sourceImport.uploadDocuments();
    const project = this.projects.selectedProject();
    if (documents.length > 0 && project !== null) {
      await this.drafts.load(project.id);
    }
  }

  protected async selectDocument(documentId: string): Promise<void> {
    await this.sourceImport.selectDocument(documentId);
    const project = this.projects.selectedProject();
    if (project !== null) {
      await this.drafts.load(project.id);
    }
  }

  protected formatFileSize(file: File | null): string {
    if (file === null) {
      return '-';
    }
    const megaBytes = file.size / (1024 * 1024);
    if (megaBytes >= 1) {
      return `${megaBytes.toFixed(1)} MB`;
    }
    return `${Math.max(1, Math.round(file.size / 1024))} KB`;
  }

  protected formatTimestamp(value: number | null | undefined): string {
    const totalSeconds = Math.max(0, Math.floor((value ?? 0) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  protected segmentPlaybackLabel(chunk: ChunkRead): string {
    return `從 ${this.formatTimestamp(chunk.start_ms)} 播放來源音訊`;
  }

  protected playTranscriptChunk(chunk: ChunkRead): void {
    const player = this.audioPlayer()?.nativeElement;
    if (
      player === undefined ||
      this.audioSourceUrl() === null ||
      chunk.start_ms === null ||
      chunk.start_ms === undefined
    ) {
      return;
    }
    player.currentTime = Math.max(0, chunk.start_ms / 1000);
    void player.play().catch(() => {
      // Native controls remain available if autoplay policy blocks play().
    });
  }

  protected retryAudioSource(): void {
    const projectId = this.projects.selectedProject()?.id ?? null;
    const document = this.sourceImport.activeDocument();
    if (
      projectId === null ||
      document?.source_kind !== 'audio' ||
      document.chunks_count <= 0
    ) {
      return;
    }
    this.requestedAudioSourceKey = null;
    void this.loadAudioSource(projectId, document.id);
  }

  protected formatDuration(value: number | null | undefined): string {
    if (value === null || value === undefined) {
      return 'pending';
    }
    const totalSeconds = Math.max(0, Math.round(value / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes === 0) {
      return `${seconds}s`;
    }
    return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  }

  protected activeDocumentFile(): File | null {
    const document = this.sourceImport.activeDocument();
    if (document === null) {
      return this.sourceImport.selectedFile();
    }

    return (
      this.sourceImport
        .uploadItems()
        .find((item) => item.document?.id === document.id)?.file ?? null
    );
  }

  protected isUploadBusy(): boolean {
    return (
      this.cropSourceFile() !== null ||
      this.sourceImport.isUploading() ||
      this.operations.isBusyFor('upload')
    );
  }

  private openCurrentCrop(): void {
    const fileIndex = this.pendingCropIndexes[this.pendingCropCursor];
    const file =
      fileIndex === undefined
        ? undefined
        : this.pendingSelectedFiles[fileIndex];
    if (file === undefined) {
      this.commitPendingFileSelection();
      return;
    }

    this.cropPosition.set(this.pendingCropCursor + 1);
    this.cropSourceFile.set(file);
    this.cropDialog()?.focusReviewStatus();
  }

  private async loadAudioSource(
    projectId: string | null,
    documentId: string | null,
  ): Promise<void> {
    const sourceKey =
      projectId === null || documentId === null
        ? null
        : `${projectId}:${documentId}`;
    if (sourceKey === this.requestedAudioSourceKey) {
      return;
    }
    this.requestedAudioSourceKey = sourceKey;
    const loadId = ++this.audioSourceLoadId;
    this.cancelAudioSourceLoad();
    this.releaseAudioSourceUrl();
    this.audioSourceError.set(null);
    if (projectId === null || documentId === null) {
      this.audioSourceLoading.set(false);
      return;
    }

    this.audioSourceLoading.set(true);
    const controller = new AbortController();
    this.audioSourceAbortController = controller;
    try {
      const source = await this.api.getDocumentAudioSource(projectId, documentId, {
        signal: controller.signal,
      });
      if (loadId !== this.audioSourceLoadId) {
        return;
      }
      if (typeof URL.createObjectURL !== 'function') {
        throw new Error('Audio playback is unavailable in this environment.');
      }
      const objectUrl = URL.createObjectURL(source);
      if (loadId !== this.audioSourceLoadId) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      this.audioSourceObjectUrl = objectUrl;
      this.audioSourceUrl.set(objectUrl);
    } catch {
      if (loadId === this.audioSourceLoadId && !controller.signal.aborted) {
        this.requestedAudioSourceKey = null;
        this.audioSourceError.set('The source audio could not be loaded.');
      }
    } finally {
      if (this.audioSourceAbortController === controller) {
        this.audioSourceAbortController = null;
      }
      if (loadId === this.audioSourceLoadId) {
        this.audioSourceLoading.set(false);
      }
    }
  }

  private cancelAudioSourceLoad(): void {
    this.audioSourceAbortController?.abort();
    this.audioSourceAbortController = null;
  }

  private releaseAudioSourceUrl(): void {
    if (this.audioSourceObjectUrl !== null) {
      URL.revokeObjectURL(this.audioSourceObjectUrl);
      this.audioSourceObjectUrl = null;
    }
    this.audioSourceUrl.set(null);
  }

  private advanceCropReview(): void {
    this.pendingCropCursor += 1;
    this.openCurrentCrop();
  }

  private commitPendingFileSelection(): void {
    const files = [...this.pendingSelectedFiles];
    this.cropSourceFile.set(null);
    this.cropPosition.set(0);
    this.cropTotal.set(0);
    this.pendingSelectedFiles = [];
    this.pendingCropIndexes = [];
    this.pendingCropCursor = 0;
    this.sourceImport.chooseFiles(files);
    queueMicrotask(() => {
      this.chooseFilesControl()?.nativeElement.focus();
    });
  }

  protected uploadStatusLabel(status: string): string {
    if (status === 'queued') {
      return 'Queued';
    }
    if (status === 'uploading') {
      return 'Uploading';
    }
    if (status === 'uploaded') {
      return 'Uploaded';
    }
    if (status === 'cancel_requested') {
      return 'Canceling';
    }
    if (status === 'canceled') {
      return 'Canceled';
    }
    return 'Failed';
  }

  protected uploadStatusSeverity(
    status: string,
  ): 'success' | 'info' | 'warn' | 'danger' {
    if (status === 'uploaded') {
      return 'success';
    }
    if (status === 'uploading') {
      return 'info';
    }
    if (status === 'failed') {
      return 'danger';
    }
    if (status === 'canceled' || status === 'cancel_requested') {
      return 'warn';
    }
    return 'warn';
  }
}
