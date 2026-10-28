import {
  Component,
  computed,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import type { WrongAnswerRead } from '../../contracts/api.contracts';
import { ReviewDisplayService } from '../../services/review-display.service';
import { displayChoice } from '../../services/choice-display';
import { DraftReviewStore } from '../../stores/draft-review/draft-review.store';
import { OperationStore } from '../../stores/operation.store';
import { ReviewRetryNavigationService } from '../../stores/practice/review-retry-navigation.service';
import { ProjectStore } from '../../stores/project.store';
import { SourceImportStore } from '../../stores/source-import/source-import.store';
import { WrongAnswerReviewStore } from '../../stores/wrong-answer-review.store';
import { AiInferredAnswerBadgeComponent } from '../ui/ai-inferred-answer-badge.component';
import { AppIconComponent } from '../ui/app-icon.component';

@Component({
  selector: 'app-wrong-answer-review',
  imports: [AiInferredAnswerBadgeComponent, AppIconComponent],
  templateUrl: './wrong-answer-review.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './wrong-answer-review.component.css',
})
export class WrongAnswerReviewComponent {
  protected readonly operations = inject(OperationStore);
  protected readonly projects = inject(ProjectStore);
  protected readonly review = inject(WrongAnswerReviewStore);
  protected readonly sourceImport = inject(SourceImportStore);
  private readonly display = inject(ReviewDisplayService);
  private readonly drafts = inject(DraftReviewStore);
  private readonly retryNavigation = inject(ReviewRetryNavigationService);

  protected readonly busyActions = ['review', 'session'] as const;
  protected readonly correctingQuestionId = signal<string | null>(null);
  protected readonly selectedCorrection = signal('');

  protected readonly canStartReviewQuiz = computed(
    () =>
      this.projects.selectedProject() !== null &&
      this.review.wrongAnswers().length > 0 &&
      !this.operations.isBusyFor(this.busyActions),
  );

  protected startReviewQuiz(): void {
    this.startRetrySession(
      this.review.wrongAnswers().map((wrongAnswer) => wrongAnswer.attempt_id),
    );
  }

  protected retryWrongAnswer(
    wrongAnswer: WrongAnswerRead,
  ): void {
    this.startRetrySession([wrongAnswer.attempt_id]);
  }

  protected documentLabel(documentId: string | null): string | null {
    return this.display.documentLabel(this.sourceImport.documents(), documentId);
  }

  protected lastWrongDateLabel(value: string | null): string {
    return this.display.reviewDateLabel(value);
  }

  protected answerLabel(wrong: WrongAnswerRead, answer: string): string {
    return displayChoice(this.correctionChoices(wrong), answer);
  }

  protected correctionChoices(wrong: WrongAnswerRead): readonly string[] {
    return (
      this.drafts.drafts().find((draft) => draft.id === wrong.question_id)
        ?.choices ?? []
    );
  }

  protected correctionBusy(wrong: WrongAnswerRead): boolean {
    const correction = this.review.answerKeyCorrection();
    return correction.saving && correction.questionId === wrong.question_id;
  }

  protected correctionMessage(wrong: WrongAnswerRead): string | null {
    const correction = this.review.answerKeyCorrection();
    return correction.questionId === wrong.question_id ? correction.message : null;
  }

  protected correctionError(wrong: WrongAnswerRead): string | null {
    const correction = this.review.answerKeyCorrection();
    return correction.questionId === wrong.question_id ? correction.error : null;
  }

  protected clearedCorrectionMessage(): string | null {
    const correction = this.review.answerKeyCorrection();
    if (correction.message === null || correction.questionId === null) {
      return null;
    }
    const listed = this.review
      .wrongAnswers()
      .some((wrong) => wrong.question_id === correction.questionId);
    return listed ? null : correction.message;
  }

  protected beginAnswerKeyCorrection(questionId: string): void {
    this.correctingQuestionId.set(questionId);
    this.selectedCorrection.set('');
  }

  protected cancelAnswerKeyCorrection(): void {
    this.correctingQuestionId.set(null);
    this.selectedCorrection.set('');
  }

  protected saveCorrectAnswer(wrong: WrongAnswerRead): void {
    const answer = this.selectedCorrection();
    if (answer.length === 0 || this.correctionBusy(wrong)) {
      return;
    }
    this.review.correctAnswerKey(wrong.question_id, answer);
  }

  private startRetrySession(
    attemptIds: readonly string[],
  ): void {
    this.retryNavigation.start(attemptIds).subscribe();
  }
}
