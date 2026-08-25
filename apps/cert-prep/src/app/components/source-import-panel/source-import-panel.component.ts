import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { DraftReviewStore } from '../../stores/draft-review/draft-review.store';
import { OperationStore } from '../../stores/operation.store';
import { ProjectStore } from '../../stores/project.store';
import { SourceImportStore } from '../../stores/source-import/source-import.store';
import { SourceImageCropDialogComponent } from './source-image-crop-dialog.component';
import { SourceImageCropService } from './source-image-crop.service';
import { SourceAudioPreviewService } from './source-audio-preview.service';
import { SourceDocumentStatusComponent } from './source-document-status.component';
import { SourceEvidencePreviewComponent } from './source-evidence-preview.component';
import type {
  SourceDocumentStatusViewModel,
  SourceEvidenceViewModel,
  SourceImportAction,
  SourceUploadQueueViewModel,
} from './source-import-panel.contracts';
import { SourceUploadQueueComponent } from './source-upload-queue.component';

@Component({
  selector: 'app-source-import-panel',
  imports: [
    SourceDocumentStatusComponent,
    SourceEvidencePreviewComponent,
    SourceImageCropDialogComponent,
    SourceUploadQueueComponent,
  ],
  providers: [SourceAudioPreviewService],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <section class="workbench-panel" aria-label="Source import">
      <app-source-upload-queue
        [model]="uploadQueueModel()"
        (action)="handleAction($event)"
      />
      <div class="workbench-panel-body">
        <app-source-document-status
          [model]="documentStatusModel()"
          (action)="handleAction($event)"
        />
        <app-source-evidence-preview
          [model]="evidenceModel()"
          (action)="handleAction($event)"
        />
        <app-source-image-crop-dialog
          [sourceFile]="cropSourceFile()"
          [position]="cropPosition()"
          [total]="cropTotal()"
          (action)="handleAction($event)"
        />
      </div>
    </section>
  `,
})
export class SourceImportPanelComponent {
  private readonly cropService = inject(SourceImageCropService);
  private readonly audioPreview = inject(SourceAudioPreviewService);
  private readonly uploadQueue = viewChild(SourceUploadQueueComponent);
  private readonly cropDialog = viewChild(SourceImageCropDialogComponent);

  protected readonly drafts = inject(DraftReviewStore);
  protected readonly operations = inject(OperationStore);
  protected readonly projects = inject(ProjectStore);
  protected readonly sourceImport = inject(SourceImportStore);
  protected readonly cropImagesBeforeUpload = signal(false);
  protected readonly cropSourceFile = signal<File | null>(null);
  protected readonly cropPosition = signal(0);
  protected readonly cropTotal = signal(0);

  protected readonly uploadQueueModel = computed<SourceUploadQueueViewModel>(
    () => ({
      accept: this.sourceImport.sourceFileAccept,
      items: this.sourceImport.uploadItems(),
      selectedFileLabel: this.sourceImport.selectedFileLabel(),
      canUpload: this.sourceImport.canUpload(),
      uploadBusy: this.isUploadBusy(),
      fileSelectionBlocked: this.cropSourceFile() !== null,
      cropImagesBeforeUpload: this.cropImagesBeforeUpload(),
      languageHint: this.sourceImport.languageHint(),
      languageHints: this.sourceImport.languageHints,
      operationError: this.operations.error(),
    }),
  );

  protected readonly documentStatusModel =
    computed<SourceDocumentStatusViewModel>(() => ({
      documents: this.sourceImport.documents(),
      activeDocumentId: this.sourceImport.activeDocumentId(),
      document: this.sourceImport.activeDocument(),
      streamError: this.sourceImport.streamError(),
      cancelBusy: this.operations.isBusyFor('document-cancel'),
      retryBusy: this.operations.isBusyFor('document-retry'),
    }));

  protected readonly evidenceModel = computed<SourceEvidenceViewModel>(() => ({
    document: this.sourceImport.activeDocument(),
    chunks: this.sourceImport.previewChunks(),
    hiddenChunkCount: this.sourceImport.hiddenChunkCount(),
    audio: this.audioPreview.state(),
    transcriptMutationBusy: this.sourceImport.isTranscriptMutationBusy(),
  }));

  private pendingSelectedFiles: File[] = [];
  private pendingCropIndexes: number[] = [];
  private pendingCropCursor = 0;
  private pendingSelectionAppendIntent = false;
  private pendingSelectionAutoUploadIntent = false;

  constructor() {
    effect(() => {
      const projectId = this.projects.selectedProject()?.id ?? null;
      const document = this.sourceImport.activeDocument();
      this.audioPreview.load(
        projectId,
        document?.source_kind === 'audio' && document.chunks_count > 0
          ? document.id
          : null,
      );
    });
    effect(() => {
      const projectId = this.projects.selectedProject()?.id ?? null;
      const documentId = this.sourceImport.activeDocumentId();
      if (projectId !== null && documentId !== null) {
        // An upload can finish after the initial draft query was enabled. Reload
        // when the source becomes active so the first empty response is not
        // mistaken for a project with no drafts.
        this.drafts.load(projectId);
      }
    });
  }

  protected handleAction(action: SourceImportAction): void {
    switch (action.type) {
      case 'choose-files':
        this.chooseFiles(action.files);
        return;
      case 'set-language':
        this.sourceImport.setLanguageHint(action.value);
        return;
      case 'set-crop-images':
        this.setCropImagesBeforeUpload(action.enabled);
        return;
      case 'upload':
        this.uploadDocument();
        return;
      case 'cancel-upload':
        this.sourceImport.cancelUploadItem(action.itemId);
        return;
      case 'retry-upload':
        this.sourceImport.retryUploadItem(action.itemId);
        return;
      case 'select-document':
        this.selectDocument(action.documentId);
        return;
      case 'cancel-processing':
        this.sourceImport.cancelActiveDocumentProcessing();
        return;
      case 'retry-processing':
        this.sourceImport.retryActiveDocumentProcessing();
        return;
      case 'retry-progress':
        this.sourceImport.retryDocumentStream();
        return;
      case 'retry-audio':
        this.audioPreview.retry();
        return;
      case 'update-transcript':
        this.sourceImport.updateTranscriptChunk(action.chunkId, action.text);
        return;
      case 'translate-transcript':
        this.sourceImport.translateTranscriptChunk(action.chunkId);
        return;
      case 'translate-stale-transcript':
        this.sourceImport.translateStaleTranscriptChunks();
        return;
      case 'show-more-evidence':
        this.sourceImport.showMoreChunks();
        return;
      case 'crop-applied':
        this.applyCroppedImage(action.file);
        return;
      case 'keep-original-image':
        this.keepOriginalImage();
        return;
    }
  }

  private chooseFiles(files: readonly File[]): void {
    if (this.cropSourceFile() !== null) {
      return;
    }
    const appendSelection = this.sourceImport.shouldAppendNewSelection();
    const selectionOptions = {
      append: appendSelection,
      autoUpload: appendSelection,
    };
    if (
      !this.cropImagesBeforeUpload() ||
      !files.some((file) => this.cropService.isCroppableImageFile(file))
    ) {
      this.sourceImport.chooseFiles(files, selectionOptions);
      return;
    }

    this.pendingSelectionAppendIntent = appendSelection;
    this.pendingSelectionAutoUploadIntent = appendSelection;
    this.pendingSelectedFiles = [...files];
    this.pendingCropIndexes = files.flatMap((file, index) =>
      this.cropService.isCroppableImageFile(file) ? [index] : [],
    );
    this.pendingCropCursor = 0;
    this.cropTotal.set(this.pendingCropIndexes.length);
    this.openCurrentCrop();
  }

  private setCropImagesBeforeUpload(enabled: boolean): void {
    if (!this.isUploadBusy()) {
      this.cropImagesBeforeUpload.set(enabled);
    }
  }

  private applyCroppedImage(file: File): void {
    const fileIndex = this.pendingCropIndexes[this.pendingCropCursor];
    if (fileIndex === undefined) {
      return;
    }
    this.pendingSelectedFiles[fileIndex] = file;
    this.advanceCropReview();
  }

  private keepOriginalImage(): void {
    if (this.pendingCropIndexes[this.pendingCropCursor] !== undefined) {
      this.advanceCropReview();
    }
  }

  private uploadDocument(): void {
    this.sourceImport.uploadDocuments();
    const project = this.projects.selectedProject();
    if (project !== null) {
      this.drafts.load(project.id);
    }
  }

  private selectDocument(documentId: string): void {
    this.sourceImport.selectDocument(documentId);
    const project = this.projects.selectedProject();
    if (project !== null) {
      this.drafts.load(project.id);
    }
  }

  private isUploadBusy(): boolean {
    return (
      this.cropSourceFile() !== null ||
      this.sourceImport.isUploading() ||
      this.operations.isBusyFor('upload')
    );
  }

  private openCurrentCrop(): void {
    const fileIndex = this.pendingCropIndexes[this.pendingCropCursor];
    const file =
      fileIndex === undefined ? undefined : this.pendingSelectedFiles[fileIndex];
    if (file === undefined) {
      this.commitPendingFileSelection();
      return;
    }

    this.cropPosition.set(this.pendingCropCursor + 1);
    this.cropSourceFile.set(file);
    this.cropDialog()?.focusReviewStatus();
  }

  private advanceCropReview(): void {
    this.pendingCropCursor += 1;
    this.openCurrentCrop();
  }

  private commitPendingFileSelection(): void {
    const files = [...this.pendingSelectedFiles];
    const appendSelection = this.pendingSelectionAppendIntent;
    const autoUpload = this.pendingSelectionAutoUploadIntent;
    this.cropSourceFile.set(null);
    this.cropPosition.set(0);
    this.cropTotal.set(0);
    this.pendingSelectedFiles = [];
    this.pendingCropIndexes = [];
    this.pendingCropCursor = 0;
    this.pendingSelectionAppendIntent = false;
    this.pendingSelectionAutoUploadIntent = false;
    this.sourceImport.chooseFiles(files, {
      append: appendSelection,
      autoUpload,
    });
    queueMicrotask(() => this.uploadQueue()?.focusChooseFiles());
  }
}
