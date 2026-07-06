import { Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import type { WrongAnswerRead } from '../../cert-prep-api';
import { OperationStore } from '../../stores/operation.store';
import { PracticeStore } from '../../stores/practice/practice.store';
import { ProjectStore } from '../../stores/project.store';
import { SourceImportStore } from '../../stores/source-import/source-import.store';
import { WrongAnswerReviewStore } from '../../stores/wrong-answer-review.store';

@Component({
  selector: 'app-wrong-answer-review',
  templateUrl: './wrong-answer-review.component.html',
  styleUrl: './wrong-answer-review.component.css',
})
export class WrongAnswerReviewComponent {
  protected readonly operations = inject(OperationStore);
  protected readonly practice = inject(PracticeStore);
  protected readonly projects = inject(ProjectStore);
  protected readonly review = inject(WrongAnswerReviewStore);
  protected readonly sourceImport = inject(SourceImportStore);
  private readonly router = inject(Router);

  protected readonly canStartReviewQuiz = computed(
    () =>
      this.projects.selectedProject() !== null &&
      this.review.wrongAnswers().length > 0 &&
      !this.operations.isBusyFor('session'),
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
    if (documentId === null) {
      return null;
    }
    return (
      this.sourceImport
        .documents()
        .find((document) => document.id === documentId)?.filename ?? documentId
    );
  }

  protected lastWrongDateLabel(value: string | null): string {
    return value === null ? 'None' : value.slice(0, 10);
  }

  private async startRetrySession(
    attemptIds: readonly string[],
  ): Promise<void> {
    const started = await this.practice.createReviewRetrySession(attemptIds);
    if (started) {
      await this.router.navigateByUrl('/random-quiz');
    }
  }
}
