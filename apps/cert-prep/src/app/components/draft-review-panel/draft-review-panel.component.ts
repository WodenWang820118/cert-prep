import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InputText } from 'primeng/inputtext';
import { RouterLink } from '@angular/router';
import { DraftReviewStore } from '../../stores/draft-review/draft-review.store';
import { OperationStore } from '../../stores/operation.store';
import { SourceImportStore } from '../../stores/source-import/source-import.store';
import { DraftGenerationStatusComponent } from './draft-generation-status.component';
import { DraftQuestionEditorCardComponent } from './draft-question-editor-card.component';
import type {
  DraftGenerationAction,
  DraftGenerationStatusViewModel,
  DraftQuestionEditorAction,
  DraftQuestionEditorViewModel,
} from './draft-review-panel.contracts';
import {
  cloneDraftEdit,
  formatDraftGenerationMessage,
  formatDraftQuestionStatus,
} from './draft-review-panel.formatters';

@Component({
  selector: 'app-draft-review-panel',
  imports: [
    DraftGenerationStatusComponent,
    DraftQuestionEditorCardComponent,
    FormsModule,
    InputText,
    RouterLink,
  ],
  templateUrl: './draft-review-panel.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './draft-review-panel.component.css',
})
export class DraftReviewPanelComponent {
  protected readonly drafts = inject(DraftReviewStore);
  protected readonly operations = inject(OperationStore);
  protected readonly sourceImport = inject(SourceImportStore);

  protected readonly generationStatus =
    computed<DraftGenerationStatusViewModel>(() => {
      const operation = this.drafts.manualDraftOperation();
      const jobSummary = this.drafts.draftJobSummary();
      const hasQuestions =
        this.drafts.activeDocumentPlayableQuestions().length > 0;
      const isPreparing =
        this.drafts.isManualDraftOperationActive() || jobSummary.active > 0;
      const hasGenerationError =
        operation?.status === 'failed' ||
        jobSummary.failed > 0 ||
        (jobSummary.skipped > 0 && jobSummary.succeeded === 0) ||
        this.drafts.manualDraftStreamError() !== null ||
        this.drafts.streamError() !== null;
      const reviewEvidence = (operation?.unavailable_blocks ?? [])
        .map((block) => ({
          citationPage: block.citation_page ?? null,
          sourceExcerpt: block.source_excerpt?.trim() || null,
        }))
        .filter(
          (evidence) =>
            evidence.citationPage !== null || evidence.sourceExcerpt !== null,
        );
      const message = formatDraftGenerationMessage({
        sourceReady: this.sourceImport.canGenerateDrafts(),
        sourceProcessing: this.sourceImport.isParsing(),
        hasQuestions,
        isPreparing,
        hasGenerationError,
        hasReviewEvidence: reviewEvidence.length > 0,
      });

      return {
        ...message,
        canGenerate: this.sourceImport.canGenerateDrafts() && !isPreparing,
        generateBusy: this.operations.isBusyFor('questions') || isPreparing,
        canRetry:
          operation?.status === 'failed' ||
          this.drafts.canRetryDraftJobs() ||
          this.drafts.manualDraftStreamError() !== null ||
          this.drafts.streamError() !== null,
        retryBusy: this.operations.isBusyFor('questions'),
        canCancel:
          this.drafts.canCancelManualDraftOperation() ||
          this.drafts.canCancelActiveDraftJobs(),
        cancelBusy:
          this.drafts.manualDraftCanceling() ||
          this.drafts.cancelingDraftJobs(),
        reviewEvidence,
      };
    });

  protected readonly questionCards = computed<
    readonly DraftQuestionEditorViewModel[]
  >(() =>
    this.drafts.activeDocumentPlayableQuestions().map((draft) => {
        const isEditing = this.drafts.isEditing(draft);
        return {
          id: draft.id,
          fieldPrefix: `question-${draft.id}`,
          statusLabel: formatDraftQuestionStatus(
            this.drafts.isPlayableDraft(draft),
          ),
          question: draft.question,
          choices: [...draft.choices],
          answer: draft.answer ?? '',
          rationale: draft.rationale ?? '',
          citationPage: draft.citation_page,
          sourceExcerpt: draft.source_excerpt?.trim() || null,
          isEditing,
          edit: isEditing ? cloneDraftEdit(this.drafts.draftEdit(draft)) : null,
          saveBusy: this.operations.isBusyFor('saveDraft'),
        };
      }),
  );

  protected readonly hasPlayableQuestions = computed(
    () => this.drafts.activeDocumentPlayableQuestions().length > 0,
  );

  protected readonly saveResult = computed(() =>
    this.operations.status() === 'Question saved' ? 'Question saved.' : null,
  );

  protected handleGenerationAction(action: DraftGenerationAction): void {
    switch (action.type) {
      case 'generate':
        this.drafts.generateDrafts('hybrid_reasoning');
        return;
      case 'cancel':
        if (this.drafts.canCancelManualDraftOperation()) {
          this.drafts.cancelManualDraftOperation();
        }
        if (this.drafts.canCancelActiveDraftJobs()) {
          this.drafts.cancelActiveDraftJobs();
        }
        return;
      case 'retry':
        this.retryGeneration();
        return;
    }
  }

  protected handleQuestionAction(
    card: DraftQuestionEditorViewModel,
    action: DraftQuestionEditorAction,
  ): void {
    const draft = this.drafts
      .activeDocumentDrafts()
      .find((candidate) => candidate.id === card.id);
    if (draft === undefined) {
      return;
    }

    switch (action.type) {
      case 'start-edit':
        this.drafts.startEdit(draft);
        return;
      case 'cancel-edit':
        this.drafts.cancelEdit(draft);
        return;
      case 'save':
        this.drafts.saveDraft(draft);
        return;
      case 'set-question':
        this.drafts.setEditQuestion(draft.id, action.value);
        return;
      case 'set-choice':
        this.drafts.setEditChoice(draft.id, action.index, action.value);
        return;
      case 'add-choice':
        this.drafts.addEditChoice(draft.id);
        return;
      case 'remove-choice':
        this.drafts.removeEditChoice(draft.id, action.index);
        return;
      case 'set-answer':
        this.drafts.setEditAnswer(draft.id, action.value);
        return;
      case 'set-rationale':
        this.drafts.setEditRationale(draft.id, action.value);
        return;
    }
  }

  private retryGeneration(): void {
    const operation = this.drafts.manualDraftOperation();
    if (operation?.status === 'failed') {
      this.drafts.generateDrafts('hybrid_reasoning');
      return;
    }
    if (
      this.drafts.manualDraftStreamError() !== null &&
      this.drafts.isManualDraftOperationActive()
    ) {
      this.drafts.retryManualDraftStream();
      return;
    }
    if (this.drafts.canRetryDraftJobs()) {
      this.drafts.retryDraftJobs();
      return;
    }
    if (this.drafts.streamError() !== null) {
      this.drafts.retryDraftStream();
      return;
    }
    this.drafts.generateDrafts('hybrid_reasoning');
  }
}
