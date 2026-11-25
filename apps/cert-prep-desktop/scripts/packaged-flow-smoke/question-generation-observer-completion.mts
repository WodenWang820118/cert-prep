import { setTimeout as delay } from 'node:timers/promises';

import { questionJobCompletionState } from './question-generation-evidence.mts';
import type {
  SmokeRunState,
  QuestionJobSnapshot,
  QuestionJobCompletionState,
  QuestionSnapshot,
  UploadedDocumentRef,
} from './types.mts';
import { screenshot } from './runner-context.mts';
import { pollQuestionGenerationApis } from './question-generation-observer-api.mts';
import {
  latestQuestionGenerationJobSnapshot,
  latestQuestionSnapshot,
} from './question-generation-observer-snapshots.mts';

export const EXPECTED_BASELINE_PAGES = 46;
export const EXPECTED_BASELINE_CHUNKS = 46;
const QUESTION_JOBS_COMPLETE_STABLE_POLLS = 3;
const QUESTION_JOBS_COMPLETE_POLL_INTERVAL_MS = 5_000;

export async function waitForQuestionJobsComplete(
  run: SmokeRunState,
  uploadedDocument: UploadedDocumentRef,
  parseStart: number,
): Promise<void> {
  const deadline = Date.now() + run.options.questionJobsCompleteTimeoutMs;
  let stableTerminalPolls = 0;
  let previousTerminalJobCount: number | null = null;
  let latestState: QuestionJobCompletionState | null = null;

  while (Date.now() < deadline) {
    const elapsedMs = Date.now() - parseStart;
    await pollQuestionGenerationApis(run, uploadedDocument, elapsedMs);
    const latestJob = latestQuestionGenerationJobSnapshot(run);
    const latestQuestion = latestQuestionSnapshot(run);

    if (latestJob) {
      latestState = questionJobCompletionState(latestJob.status_counts);
      if (
        latestState.all_terminal &&
        latestJob.item_count === previousTerminalJobCount
      ) {
        stableTerminalPolls += 1;
      } else {
        stableTerminalPolls = latestState.all_terminal ? 1 : 0;
      }
      previousTerminalJobCount = latestJob.item_count;

      if (stableTerminalPolls >= QUESTION_JOBS_COMPLETE_STABLE_POLLS) {
        run.metrics.ui_timings_ms.question_generation_all_jobs_terminal = elapsedMs;
        run.metrics.question_generation.all_jobs_terminal_ms = elapsedMs;
        assertSuccessfulQuestionGenerationBaseline(
          run,
          latestJob,
          latestQuestion,
          latestState,
        );
        await screenshot(run, 'question-generation-baseline-complete');
        return;
      }
    }

    await delay(QUESTION_JOBS_COMPLETE_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Question generation question jobs did not reach a stable terminal state within ${run.options.questionJobsCompleteTimeoutMs}ms. Last state: ${JSON.stringify(
      latestState,
    )}`,
  );
}

function assertSuccessfulQuestionGenerationBaseline(
  run: SmokeRunState,
  latestJob: QuestionJobSnapshot,
  latestQuestion: QuestionSnapshot | null,
  state: QuestionJobCompletionState,
): void {
  const usableQuestionCount = latestQuestion?.usable_question_count ?? 0;
  if (!state.all_succeeded) {
    throw new Error(
      `Question generation jobs reached terminal state without all succeeding: ${JSON.stringify(
        latestJob.status_counts,
      )}`,
    );
  }
  if (latestJob.generated_count < 1 || usableQuestionCount < 1) {
    throw new Error(
      `Question generation baseline produced no usable questions (generated=${latestJob.generated_count}, usable=${usableQuestionCount}).`,
    );
  }
  if (latestJob.generated_count !== usableQuestionCount) {
    throw new Error(
      `Question generation generated question count (${latestJob.generated_count}) did not match usable question count (${usableQuestionCount}).`,
    );
  }
  const firstUsable =
    run.metrics.question_generation.first_usable_question_visible_ms;
  const parseComplete = run.metrics.ui_timings_ms.parse_complete_visible;
  if (firstUsable === undefined || parseComplete === undefined) {
    throw new Error(
      'Question generation baseline missed first usable or parse-complete timing.',
    );
  }
  if (firstUsable < parseComplete) {
    throw new Error(
      `First usable qwen question (${firstUsable}ms) was visible before OCR parse completion (${parseComplete}ms).`,
    );
  }
  const ocr = run.metrics.ocr_completion;
  const expectedPages =
    run.options.acceptancePdfPageScope === 'page-1'
      ? 1
      : EXPECTED_BASELINE_PAGES;
  const expectedChunks =
    run.options.acceptancePdfPageScope === 'page-1'
      ? 1
      : EXPECTED_BASELINE_CHUNKS;
  const sourcePageCount = ocr?.total_pages;
  if (
    ocr?.pages_processed !== expectedPages ||
    (run.options.acceptancePdfPageScope === 'page-1'
      ? !isPositivePageCount(sourcePageCount)
      : ocr.total_pages !== expectedPages) ||
    !ocrChunksAccepted(run, expectedChunks)
  ) {
    throw new Error(
      `OCR completion did not match expected ${expectedPages} processed pages / ${expectedChunks} chunks: ${JSON.stringify(
        ocr,
      )}`,
    );
  }
}

function ocrChunksAccepted(run: SmokeRunState, expectedChunks: number): boolean {
  const chunks = run.metrics.ocr_completion?.chunks;
  if (chunks === expectedChunks) {
    return true;
  }
  if (run.options.acceptancePdfPageScope === 'page-1') return false;
  return (
    run.options.allowCaptureChunkVariance &&
    chunks !== null &&
    chunks !== undefined &&
    chunks > 0 &&
    chunks <= expectedChunks
  );
}

function isPositivePageCount(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isSafeInteger(value) && value >= 1;
}
