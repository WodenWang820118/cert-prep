import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { QuestionsStore } from '../../data';
import { OperationStore } from '../../../core/data';
import { SourceImportStore } from '../../../source-library/data';
import { QuestionGenerationStatusComponent } from '../../ui';
import { QuestionEditorCardComponent } from '../../ui';
import type {
  QuestionGenerationAction,
  QuestionGenerationStatusViewModel,
  QuestionEditorAction,
  QuestionEditorViewModel,
} from '../../domain';
import {
  cloneQuestionEdit,
  formatQuestionGenerationMessage,
} from '../../domain';
import { AppIconComponent } from '../../../core/ui';
import { HlmInput } from '@spartan-ng/helm/input';

@Component({
  selector: 'app-questions-panel',
  imports: [QuestionGenerationStatusComponent, QuestionEditorCardComponent, FormsModule, RouterLink, AppIconComponent, HlmInput],
  templateUrl: './questions-panel.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './questions-panel.component.css',
})
export class QuestionsPanelComponent {
  protected readonly questionsStore = inject(QuestionsStore);
  protected readonly operations = inject(OperationStore);
  protected readonly sourceImport = inject(SourceImportStore);

  protected readonly generationStatus =
    computed<QuestionGenerationStatusViewModel>(() => {
      const operation = this.questionsStore.manualQuestionGeneration();
      const generatedCount = operation && 'generatedCount' in operation
        ? operation.generatedCount
        : operation?.generated_count;
      const source = this.sourceImport.activeSource();
      const jobSummary = this.questionsStore.questionJobSummary();
      const hasQuestions =
        this.questionsStore.activeSourcePlayableQuestions().length > 0;
      const isPreparing =
        this.questionsStore.isManualQuestionGenerationActive() || jobSummary.active > 0;
      const hasGenerationError =
        operation?.status === 'failed' ||
        jobSummary.failed > 0 ||
        (jobSummary.skipped > 0 && jobSummary.succeeded === 0) ||
        this.questionsStore.manualQuestionGenerationStreamError() !== null ||
        this.questionsStore.streamError() !== null;
      const reviewEvidence = (operation?.unavailable_blocks ?? [])
        .map((block) => ({
          citationPage: block.citation_page ?? null,
          sourceExcerpt: block.source_excerpt?.trim() || null,
        }))
        .filter(
          (evidence) =>
            evidence.citationPage !== null || evidence.sourceExcerpt !== null,
        );
      const message = formatQuestionGenerationMessage({
        sourceReady: this.sourceImport.canGenerateQuestions(),
        sourceProcessing: this.sourceImport.isParsing(),
        hasQuestions,
        isPreparing,
        hasGenerationError,
        hasReviewEvidence: reviewEvidence.length > 0,
        zeroQuestionsGenerated:
          operation?.status === 'succeeded' &&
          operation.source_id === source?.id &&
          operation.project_id === source?.project_id &&
          generatedCount === 0,
      });

      return {
        ...message,
        canGenerate: this.sourceImport.canGenerateQuestions() && !isPreparing,
        generateBusy: this.operations.isBusyFor('questions') || isPreparing,
        canRetry:
          operation?.status === 'failed' ||
          this.questionsStore.canRetryQuestionJobs() ||
          this.questionsStore.manualQuestionGenerationStreamError() !== null ||
          this.questionsStore.streamError() !== null,
        retryBusy: this.operations.isBusyFor('questions'),
        canCancel:
          this.questionsStore.canCancelManualQuestionGeneration() ||
          this.questionsStore.canCancelActiveQuestionJobs(),
        cancelBusy:
          this.questionsStore.manualQuestionGenerationCanceling() ||
          this.questionsStore.cancelingQuestionJobs(),
        reviewEvidence,
      };
    });

  protected readonly questionCards = computed<
    readonly QuestionEditorViewModel[]
  >(() =>
    this.questionsStore.activeSourcePlayableQuestions().map((question) => {
        const isEditing = this.questionsStore.isEditing(question);
        return {
          id: question.id,
          fieldPrefix: `question-${question.id}`,
          question: question.question,
          choices: [...question.choices],
          answer: question.answer ?? '',
          rationale: question.rationale ?? '',
          citationPage: question.citation_page,
          sourceExcerpt: question.source_excerpt?.trim() || null,
          isEditing,
          edit: isEditing ? cloneQuestionEdit(this.questionsStore.questionEdit(question)) : null,
          saveBusy: this.operations.isBusyFor('saveQuestion'),
          answerKeySource: question.answer_key_source,
        };
      }),
  );

  protected readonly hasPlayableQuestions = computed(
    () => this.questionsStore.activeSourcePlayableQuestions().length > 0,
  );

  protected readonly saveResult = computed(() =>
    this.operations.status() === 'Question saved' ? 'Question saved.' : null,
  );

  protected handleGenerationAction(action: QuestionGenerationAction): void {
    switch (action.type) {
      case 'generate':
        this.questionsStore.generateQuestions('hybrid_reasoning');
        return;
      case 'cancel':
        if (this.questionsStore.canCancelManualQuestionGeneration()) {
          this.questionsStore.cancelManualQuestionGeneration();
        }
        if (this.questionsStore.canCancelActiveQuestionJobs()) {
          this.questionsStore.cancelActiveQuestionJobs();
        }
        return;
      case 'retry':
        this.retryGeneration();
        return;
    }
  }

  protected handleQuestionAction(
    card: QuestionEditorViewModel,
    action: QuestionEditorAction,
  ): void {
    const question = this.questionsStore
      .activeSourceQuestions()
      .find((candidate) => candidate.id === card.id);
    if (question === undefined) {
      return;
    }

    switch (action.type) {
      case 'start-edit':
        this.questionsStore.startEdit(question);
        return;
      case 'cancel-edit':
        this.questionsStore.cancelEdit(question);
        return;
      case 'save':
        this.questionsStore.saveQuestion(question);
        return;
      case 'set-question':
        this.questionsStore.setEditQuestion(question.id, action.value);
        return;
      case 'set-choice':
        this.questionsStore.setEditChoice(question.id, action.index, action.value);
        return;
      case 'add-choice':
        this.questionsStore.addEditChoice(question.id);
        return;
      case 'remove-choice':
        this.questionsStore.removeEditChoice(question.id, action.index);
        return;
      case 'set-answer':
        this.questionsStore.setEditAnswer(question.id, action.value);
        return;
      case 'set-rationale':
        this.questionsStore.setEditRationale(question.id, action.value);
        return;
    }
  }

  private retryGeneration(): void {
    const operation = this.questionsStore.manualQuestionGeneration();
    if (operation?.status === 'failed') {
      this.questionsStore.generateQuestions('hybrid_reasoning');
      return;
    }
    if (
      this.questionsStore.manualQuestionGenerationStreamError() !== null &&
      this.questionsStore.isManualQuestionGenerationActive()
    ) {
      this.questionsStore.retryManualQuestionGenerationStream();
      return;
    }
    if (this.questionsStore.canRetryQuestionJobs()) {
      this.questionsStore.retryQuestionJobs();
      return;
    }
    if (this.questionsStore.streamError() !== null) {
      this.questionsStore.retryQuestionStream();
      return;
    }
    this.questionsStore.generateQuestions('hybrid_reasoning');
  }
}
