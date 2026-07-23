import { Component, computed, inject, ChangeDetectionStrategy } from '@angular/core';
import type { WrongAnswerRead } from '../../cert-prep-api';
import { OperationStore } from '../../stores/operation.store';
import { ReviewRetryNavigationService } from '../../stores/practice/review-retry-navigation.service';
import { ProjectStore } from '../../stores/project.store';
import { SourceImportStore } from '../../stores/source-import/source-import.store';
import { WrongAnswerReviewStore } from '../../stores/wrong-answer-review.store';
import { documentLabel, reviewDateLabel } from '../../utils/review-display';

@Component({
  selector: 'app-wrong-answer-review',
  templateUrl: './wrong-answer-review.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './wrong-answer-review.component.css',
})
export class WrongAnswerReviewComponent {
  protected readonly operations = inject(OperationStore);
  protected readonly projects = inject(ProjectStore);
  protected readonly review = inject(WrongAnswerReviewStore);
  protected readonly sourceImport = inject(SourceImportStore);
  private readonly retryNavigation = inject(ReviewRetryNavigationService);

  protected readonly busyActions = ['review', 'session'] as const;

  protected readonly canStartReviewQuiz = computed(
    () =>
      this.projects.selectedProject() !== null &&
      this.review.wrongAnswers().length > 0 &&
      !this.operations.isBusyFor(this.busyActions),
  );

  protected async startReviewQuiz(): Promise<void> {
    await this.startRetrySession(
      this.review.wrongAnswers().map((wrongAnswer) => wrongAnswer.attempt_id),
    );
  }

  protected async retryWrongAnswer(
    wrongAnswer: WrongAnswerRead,
  ): Promise<void> {
    await this.startRetrySession([wrongAnswer.attempt_id]);
  }

  protected documentLabel(documentId: string | null): string | null {
    return documentLabel(this.sourceImport.documents(), documentId);
  }

  protected lastWrongDateLabel(value: string | null): string {
    return reviewDateLabel(value);
  }

  private async startRetrySession(
    attemptIds: readonly string[],
  ): Promise<void> {
    await this.retryNavigation.start(attemptIds);
  }
}
