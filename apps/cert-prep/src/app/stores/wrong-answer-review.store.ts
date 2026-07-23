import { effect, inject, Injectable, signal } from '@angular/core';
import {
  CERT_PREP_API,
  type CertPrepGeneratedClient,
  type WrongAnswerRead,
} from '../cert-prep-api';
import { CertPrepHttpResourceClient } from '../cert-prep-http-resource-client';
import { OperationStore } from './operation.store';
import { ProjectStore } from './project.store';

export interface WrongAnswerExplanationState {
  loading: boolean;
  result: string | null;
  error: string | null;
  fallback: boolean;
}

type WrongAnswerExplanationRead = Awaited<
  ReturnType<CertPrepGeneratedClient['explainWrongAnswer']>
>;
type WrongAnswerSummaryRead = Awaited<
  ReturnType<CertPrepGeneratedClient['summarizeWrongAnswers']>
>;
const EMPTY_EXPLANATION_STATE: WrongAnswerExplanationState = {
  loading: false,
  result: null,
  error: null,
  fallback: false,
};

@Injectable({ providedIn: 'root' })
export class WrongAnswerReviewStore {
  private readonly api = inject(CERT_PREP_API);
  private readonly operations = inject(OperationStore);
  private readonly projects = inject(ProjectStore);
  private readonly resources = inject(CertPrepHttpResourceClient);
  private readonly reviewQueryEnabled = signal(false);

  private readonly wrongAnswersResource = this.resources.wrongAnswers(() =>
    this.reviewQueryEnabled() ? this.projects.selectedProjectId() : null,
  );
  private readonly summaryResource = this.resources.wrongAnswerSummary(() =>
    this.reviewQueryEnabled() ? this.projects.selectedProjectId() : null,
  );
  readonly wrongAnswers = signal<WrongAnswerRead[]>([]);
  readonly summary = signal<WrongAnswerSummaryRead | null>(null);
  readonly explanations = signal<Record<string, WrongAnswerExplanationState>>(
    {},
  );
  private readonly explanationSync = effect(() => {
    const status = this.wrongAnswersResource.status();
    if (status === 'resolved' || status === 'local') {
      const wrongAnswers = this.wrongAnswersResource.value();
      this.wrongAnswers.set(wrongAnswers);
      this.pruneExplanations(wrongAnswers);
    }

    const summaryStatus = this.summaryResource.status();
    if (summaryStatus === 'resolved' || summaryStatus === 'local') {
      this.summary.set(this.summaryResource.value());
    }
  });

  load(projectId: string): void {
    if (this.projects.selectedProject()?.id !== projectId) {
      return;
    }
    if (!this.reviewQueryEnabled()) {
      this.reviewQueryEnabled.set(true);
      return;
    }
    this.wrongAnswersResource.reload();
    this.summaryResource.reload();
  }

  reset(): void {
    this.wrongAnswers.set([]);
    this.summary.set(null);
    this.wrongAnswersResource.set([]);
    this.summaryResource.set(null);
    this.explanations.set({});
  }

  refresh(): void {
    const project = this.projects.selectedProject();
    if (project === null) {
      this.operations.fail('Select a project before refreshing review.');
      return;
    }

    if (!this.reviewQueryEnabled()) {
      this.reviewQueryEnabled.set(true);
      this.operations.status.set('Review refreshed');
      return;
    }
    this.wrongAnswersResource.reload();
    this.summaryResource.reload();
    this.operations.status.set('Review refreshed');
  }

  explanationFor(attemptId: string): WrongAnswerExplanationState {
    return this.explanations()[attemptId] ?? EMPTY_EXPLANATION_STATE;
  }

  async discussMistake(wrongAnswer: WrongAnswerRead): Promise<void> {
    const project = this.projects.selectedProject();
    if (project === null) {
      this.setFallback(
        wrongAnswer,
        'Select a project before requesting an AI explanation.',
      );
      return;
    }

    this.setExplanation(wrongAnswer.attempt_id, {
      loading: true,
      result: null,
      error: null,
      fallback: false,
    });

    const explanationRequest = this.api.explainWrongAnswer(
      project.id,
      wrongAnswer.attempt_id,
    );

    try {
      const response = await explanationRequest;
      const explanation = this.extractExplanation(response);
      if (explanation === null) {
        this.setFallback(wrongAnswer, 'The AI explanation response was empty.');
        return;
      }

      this.setExplanation(wrongAnswer.attempt_id, {
        loading: false,
        result: explanation,
        error: null,
        fallback: response.fallback,
      });
    } catch (error) {
      this.setFallback(wrongAnswer, this.errorMessage(error));
    }
  }

  private extractExplanation(
    response: WrongAnswerExplanationRead,
  ): string | null {
    return this.nonEmpty(response.explanation);
  }

  private nonEmpty(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0
      ? value.trim()
      : null;
  }

  private setFallback(wrongAnswer: WrongAnswerRead, error: string): void {
    this.setExplanation(wrongAnswer.attempt_id, {
      loading: false,
      result: this.fallbackExplanation(wrongAnswer),
      error,
      fallback: true,
    });
  }

  private fallbackExplanation(wrongAnswer: WrongAnswerRead): string {
    const selected = wrongAnswer.selected_answer || 'the selected answer';
    const correct = wrongAnswer.correct_answer || 'the recorded correct answer';
    const rationale =
      wrongAnswer.rationale ||
      'The stored rationale was not provided for this attempt.';
    const source =
      wrongAnswer.source_excerpt ||
      'No source excerpt was recorded for this attempt.';
    const page =
      wrongAnswer.citation_page === null
        ? 'the cited source'
        : `page ${wrongAnswer.citation_page}`;

    return `You chose ${selected}, but the recorded correct answer is ${correct}. The rationale says: ${rationale} The source on ${page} says: ${source}`;
  }

  private errorMessage(error: unknown): string {
    const httpError = error as { error?: unknown; message?: unknown };
    if (
      typeof httpError.error === 'object' &&
      httpError.error !== null &&
      'message' in httpError.error &&
      typeof (httpError.error as { message?: unknown }).message === 'string'
    ) {
      return (httpError.error as { message: string }).message;
    }

    if (typeof httpError.error === 'string' && httpError.error.length > 0) {
      return httpError.error;
    }

    if (typeof httpError.message === 'string' && httpError.message.length > 0) {
      return httpError.message;
    }

    return 'AI explanation is unavailable right now.';
  }

  private setExplanation(
    attemptId: string,
    state: WrongAnswerExplanationState,
  ): void {
    this.explanations.update((explanations) => ({
      ...explanations,
      [attemptId]: state,
    }));
  }

  private pruneExplanations(wrongAnswers: WrongAnswerRead[]): void {
    const activeAttemptIds = new Set(
      wrongAnswers.map((wrongAnswer) => wrongAnswer.attempt_id),
    );
    this.explanations.update((explanations) =>
      Object.fromEntries(
        Object.entries(explanations).filter(([attemptId]) =>
          activeAttemptIds.has(attemptId),
        ),
      ),
    );
  }
}
