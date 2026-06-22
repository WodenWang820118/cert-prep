import {
  mergeStatusCounts,
  sanitizeDraftJobSnapshot,
  sanitizeQuestionSnapshot,
} from './streaming-evidence.mts';
import type {
  SmokeRunState,
  StreamingDraftJobSnapshot,
  StreamingQuestionSnapshot,
} from './types.mts';

export function recordStreamingDraftJobSnapshot(
  run: SmokeRunState,
  payload: unknown,
  elapsedMs: number,
): void {
  const snapshot = sanitizeDraftJobSnapshot(payload, elapsedMs);
  run.metrics.streaming_questions.job_snapshots.push(snapshot);
  mergeStatusCounts(
    run.metrics.streaming_questions.status_counts,
    snapshot.status_counts,
  );
  if (
    run.metrics.streaming_questions.first_job_visible_ms === undefined &&
    snapshot.item_count > 0
  ) {
    run.metrics.streaming_questions.first_job_visible_ms = snapshot.elapsed_ms;
  }
  if (
    run.metrics.streaming_questions.first_status_visible_ms === undefined &&
    Object.keys(snapshot.status_counts).length > 0
  ) {
    run.metrics.streaming_questions.first_status_visible_ms = snapshot.elapsed_ms;
  }
  if (snapshot.blocker && !run.metrics.streaming_questions.blocker) {
    run.metrics.streaming_questions.blocker = snapshot.blocker;
  }
}

export function recordStreamingQuestionSnapshot(
  run: SmokeRunState,
  payload: unknown,
  elapsedMs: number,
): void {
  const snapshot = sanitizeQuestionSnapshot(payload, elapsedMs);
  run.metrics.streaming_questions.question_snapshots.push(snapshot);
  if (
    run.metrics.streaming_questions.first_question_visible_ms === undefined &&
    snapshot.item_count > 0
  ) {
    run.metrics.streaming_questions.first_question_visible_ms = snapshot.elapsed_ms;
  }
  if (
    run.metrics.streaming_questions.first_usable_question_visible_ms === undefined &&
    snapshot.usable_question_count > 0
  ) {
    run.metrics.streaming_questions.first_usable_question_visible_ms =
      snapshot.elapsed_ms;
  }
}

export function latestStreamingJobSnapshot(
  run: SmokeRunState,
): StreamingDraftJobSnapshot | null {
  return (
    run.metrics.streaming_questions.job_snapshots[
      run.metrics.streaming_questions.job_snapshots.length - 1
    ] ?? null
  );
}

export function latestStreamingQuestionSnapshot(
  run: SmokeRunState,
): StreamingQuestionSnapshot | null {
  return (
    run.metrics.streaming_questions.question_snapshots[
      run.metrics.streaming_questions.question_snapshots.length - 1
    ] ?? null
  );
}
