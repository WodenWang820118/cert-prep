import {
  mergeStatusCounts,
  sanitizeQuestionJobSnapshot,
  sanitizeQuestionSnapshot,
} from './question-generation-evidence.mts';
import type {
  SmokeRunState,
  QuestionJobSnapshot,
  QuestionSnapshot,
} from './types.mts';

export function recordQuestionJobSnapshot(
  run: SmokeRunState,
  payload: unknown,
  elapsedMs: number,
): void {
  const snapshot = sanitizeQuestionJobSnapshot(payload, elapsedMs);
  run.metrics.question_generation.job_snapshots.push(snapshot);
  mergeStatusCounts(
    run.metrics.question_generation.status_counts,
    snapshot.status_counts,
  );
  if (
    run.metrics.question_generation.first_job_visible_ms === undefined &&
    snapshot.item_count > 0
  ) {
    run.metrics.question_generation.first_job_visible_ms = snapshot.elapsed_ms;
  }
  if (
    run.metrics.question_generation.first_status_visible_ms === undefined &&
    Object.keys(snapshot.status_counts).length > 0
  ) {
    run.metrics.question_generation.first_status_visible_ms = snapshot.elapsed_ms;
  }
  if (snapshot.blocker && !run.metrics.question_generation.blocker) {
    run.metrics.question_generation.blocker = snapshot.blocker;
  }
}

export function recordQuestionSnapshot(
  run: SmokeRunState,
  payload: unknown,
  elapsedMs: number,
): void {
  const snapshot = sanitizeQuestionSnapshot(payload, elapsedMs);
  run.metrics.question_generation.question_snapshots.push(snapshot);
  if (
    run.metrics.question_generation.first_question_visible_ms === undefined &&
    snapshot.item_count > 0
  ) {
    run.metrics.question_generation.first_question_visible_ms = snapshot.elapsed_ms;
  }
  if (
    run.metrics.question_generation.first_usable_question_visible_ms === undefined &&
    snapshot.usable_question_count > 0
  ) {
    run.metrics.question_generation.first_usable_question_visible_ms =
      snapshot.elapsed_ms;
  }
}

export function latestQuestionGenerationJobSnapshot(
  run: SmokeRunState,
): QuestionJobSnapshot | null {
  return (
    run.metrics.question_generation.job_snapshots[
      run.metrics.question_generation.job_snapshots.length - 1
    ] ?? null
  );
}

export function latestQuestionSnapshot(
  run: SmokeRunState,
): QuestionSnapshot | null {
  return (
    run.metrics.question_generation.question_snapshots[
      run.metrics.question_generation.question_snapshots.length - 1
    ] ?? null
  );
}
