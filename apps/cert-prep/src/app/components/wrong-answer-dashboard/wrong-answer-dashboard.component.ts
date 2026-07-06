import { Component, computed, inject } from '@angular/core';
import type {
  WrongAnswerRead,
  WrongAnswerSummaryRead,
} from '../../cert-prep-api';
import { OperationStore } from '../../stores/operation.store';
import { ReviewRetryNavigationService } from '../../stores/practice/review-retry-navigation.service';
import { ProjectStore } from '../../stores/project.store';
import { SourceImportStore } from '../../stores/source-import/source-import.store';
import { WrongAnswerReviewStore } from '../../stores/wrong-answer-review.store';
import {
  pageLabel,
  requiredDocumentLabel,
  reviewDateLabel,
} from '../../utils/review-display';

type WrongAnswerCluster = WrongAnswerSummaryRead['clusters'][number];
type WrongAnswerRepeatedMiss = WrongAnswerSummaryRead['repeated_misses'][number];

interface DashboardMetric {
  readonly label: string;
  readonly value: string;
  readonly tone: 'attention' | 'progress' | 'neutral';
}

interface WeakAreaView {
  readonly key: string;
  readonly documentLabel: string;
  readonly pageLabel: string;
  readonly currentWrongCount: number;
  readonly clearedCount: number;
  readonly lastWrongLabel: string;
  readonly attemptIds: readonly string[];
}

interface RepeatedMissView {
  readonly questionId: string;
  readonly question: string;
  readonly documentLabel: string;
  readonly pageLabel: string;
  readonly sourceExcerpt: string | null;
  readonly missCount: number;
  readonly lastWrongLabel: string;
  readonly attemptIds: readonly string[];
}

interface AnswerPatternView {
  readonly key: string;
  readonly selectedAnswer: string;
  readonly correctAnswer: string;
  readonly count: number;
  readonly samples: readonly string[];
}

@Component({
  selector: 'app-wrong-answer-dashboard',
  templateUrl: './wrong-answer-dashboard.component.html',
  styleUrl: './wrong-answer-dashboard.component.css',
})
export class WrongAnswerDashboardComponent {
  protected readonly operations = inject(OperationStore);
  protected readonly projects = inject(ProjectStore);
  protected readonly review = inject(WrongAnswerReviewStore);
  protected readonly sourceImport = inject(SourceImportStore);
  private readonly retryNavigation = inject(ReviewRetryNavigationService);

  protected readonly busyActions = ['review', 'session'] as const;

  protected readonly metrics = computed<DashboardMetric[]>(() => {
    const summary = this.review.summary();
    return [
      {
        label: 'Current Wrong',
        value: String(summary?.current_wrong_count ?? 0),
        tone: 'attention',
      },
      {
        label: 'Cleared',
        value: String(summary?.cleared_count ?? 0),
        tone: 'progress',
      },
      {
        label: 'Repeated Misses',
        value: String(summary?.repeated_misses.length ?? 0),
        tone: 'attention',
      },
      {
        label: 'Weak Areas',
        value: String(summary?.clusters.length ?? 0),
        tone: 'neutral',
      },
      {
        label: 'Last Wrong',
        value: reviewDateLabel(summary?.last_wrong_date ?? null),
        tone: 'neutral',
      },
    ];
  });

  protected readonly weakAreas = computed<WeakAreaView[]>(() => {
    const summary = this.review.summary();
    if (summary === null) {
      return [];
    }

    return [...summary.clusters]
      .sort((left, right) => this.compareClusters(left, right))
      .map((cluster) => {
        const attemptIds = this.currentWrongAnswersForCluster(cluster).map(
          (wrongAnswer) => wrongAnswer.attempt_id,
        );
        return {
          key: this.clusterKey(cluster.document_id, cluster.citation_page),
          documentLabel: requiredDocumentLabel(
            this.sourceImport.documents(),
            cluster.document_id,
          ),
          pageLabel: pageLabel(cluster.citation_page),
          currentWrongCount: cluster.current_wrong_count,
          clearedCount: cluster.cleared_count,
          lastWrongLabel: reviewDateLabel(cluster.last_wrong_at),
          attemptIds,
        };
      });
  });

  protected readonly repeatedMisses = computed<RepeatedMissView[]>(() =>
    [...(this.review.summary()?.repeated_misses ?? [])]
      .sort(
        (left, right) =>
          right.miss_count - left.miss_count ||
          right.last_wrong_at.localeCompare(left.last_wrong_at),
      )
      .map((miss) => ({
        questionId: miss.question_id,
        question: miss.question,
        documentLabel: requiredDocumentLabel(
          this.sourceImport.documents(),
          miss.document_id,
        ),
        pageLabel: pageLabel(miss.citation_page),
        sourceExcerpt: miss.source_excerpt,
        missCount: miss.miss_count,
        lastWrongLabel: reviewDateLabel(miss.last_wrong_at),
        attemptIds: this.currentWrongAnswersForQuestion(miss).map(
          (wrongAnswer) => wrongAnswer.attempt_id,
        ),
      })),
  );

  protected readonly answerPatterns = computed<AnswerPatternView[]>(() => {
    const patterns = new Map<string, AnswerPatternView>();
    for (const wrongAnswer of this.review.wrongAnswers()) {
      const selectedAnswer = wrongAnswer.selected_answer || 'Blank answer';
      const correctAnswer = wrongAnswer.correct_answer ?? 'Not set';
      const key = `${selectedAnswer}\u0000${correctAnswer}`;
      const current = patterns.get(key);
      patterns.set(key, {
        key,
        selectedAnswer,
        correctAnswer,
        count: (current?.count ?? 0) + 1,
        samples: [...(current?.samples ?? []), wrongAnswer.question].slice(0, 3),
      });
    }

    return [...patterns.values()].sort(
      (left, right) =>
        right.count - left.count || left.key.localeCompare(right.key),
    );
  });

  protected readonly hasDashboardData = computed(
    () =>
      this.review.wrongAnswers().length > 0 ||
      (this.review.summary()?.cleared_count ?? 0) > 0 ||
      this.weakAreas().length > 0 ||
      this.repeatedMisses().length > 0,
  );

  protected async refresh(): Promise<void> {
    await this.review.refresh();
  }

  protected async retryAttemptIds(attemptIds: readonly string[]): Promise<void> {
    await this.retryNavigation.start(attemptIds);
  }

  protected retryLabel(attemptIds: readonly string[]): string {
    return attemptIds.length === 1
      ? 'Retry 1 question'
      : `Retry ${attemptIds.length} questions`;
  }

  private currentWrongAnswersForCluster(
    cluster: WrongAnswerCluster,
  ): WrongAnswerRead[] {
    return this.review
      .wrongAnswers()
      .filter(
        (wrongAnswer) =>
          wrongAnswer.document_id === cluster.document_id &&
          wrongAnswer.citation_page === cluster.citation_page,
      );
  }

  private currentWrongAnswersForQuestion(
    miss: WrongAnswerRepeatedMiss,
  ): WrongAnswerRead[] {
    return this.review
      .wrongAnswers()
      .filter((wrongAnswer) => wrongAnswer.question_id === miss.question_id);
  }

  private compareClusters(
    left: WrongAnswerCluster,
    right: WrongAnswerCluster,
  ): number {
    return (
      right.current_wrong_count - left.current_wrong_count ||
      right.cleared_count - left.cleared_count ||
      (right.last_wrong_at ?? '').localeCompare(left.last_wrong_at ?? '') ||
      this.clusterKey(left.document_id, left.citation_page).localeCompare(
        this.clusterKey(right.document_id, right.citation_page),
      )
    );
  }

  private clusterKey(
    documentId: string | null,
    citationPage: number | null,
  ): string {
    return `${documentId ?? 'no-document'}:${citationPage ?? 'no-page'}`;
  }

}
