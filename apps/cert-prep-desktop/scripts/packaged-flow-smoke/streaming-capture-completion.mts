import { setTimeout as delay } from 'node:timers/promises';

import { streamingJobCompletionState } from './streaming-evidence.mts';
import type {
  SmokeRunState,
  StreamingDraftJobSnapshot,
  StreamingJobCompletionState,
  StreamingQuestionSnapshot,
  UploadedDocumentRef,
} from './types.mts';
import { screenshot } from './runner-context.mts';
import { pollStreamingDraftApis } from './streaming-capture-api.mts';
import { proveOwnedFastFlowReleaseBeforeClose } from './owned-fastflow-process-lifecycle.mts';
import {
  latestStreamingJobSnapshot,
  latestStreamingQuestionSnapshot,
} from './streaming-capture-snapshots.mts';

export const EXPECTED_BASELINE_PAGES = 46;
export const EXPECTED_BASELINE_CHUNKS = 46;
const STREAMING_COMPLETE_STABLE_POLLS = 3;
const STREAMING_COMPLETE_POLL_INTERVAL_MS = 5_000;

export async function waitForStreamingJobsComplete(
  run: SmokeRunState,
  uploadedDocument: UploadedDocumentRef,
  parseStart: number,
): Promise<void> {
  const deadline = Date.now() + run.options.streamingCompleteTimeoutMs;
  let stableTerminalPolls = 0;
  let previousTerminalJobCount: number | null = null;
  let latestState: StreamingJobCompletionState | null = null;

  while (Date.now() < deadline) {
    const elapsedMs = Date.now() - parseStart;
    await pollStreamingDraftApis(run, uploadedDocument, elapsedMs);
    const latestJob = latestStreamingJobSnapshot(run);
    const latestQuestion = latestStreamingQuestionSnapshot(run);

    if (latestJob) {
      latestState = streamingJobCompletionState(latestJob.status_counts);
      if (
        latestState.all_terminal &&
        latestJob.item_count === previousTerminalJobCount
      ) {
        stableTerminalPolls += 1;
      } else {
        stableTerminalPolls = latestState.all_terminal ? 1 : 0;
      }
      previousTerminalJobCount = latestJob.item_count;

      if (stableTerminalPolls >= STREAMING_COMPLETE_STABLE_POLLS) {
        run.metrics.ui_timings_ms.streaming_all_jobs_terminal = elapsedMs;
        run.metrics.streaming_questions.all_jobs_terminal_ms = elapsedMs;
        assertSuccessfulStreamingBaseline(run, latestJob, latestQuestion, latestState);
        await proveOwnedFastFlowReleaseBeforeClose(run);
        await screenshot(run, 'streaming-baseline-complete');
        return;
      }
    }

    await delay(STREAMING_COMPLETE_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Streaming question jobs did not reach a stable terminal state within ${run.options.streamingCompleteTimeoutMs}ms. Last state: ${JSON.stringify(
      latestState,
    )}`,
  );
}

function assertSuccessfulStreamingBaseline(
  run: SmokeRunState,
  latestJob: StreamingDraftJobSnapshot,
  latestQuestion: StreamingQuestionSnapshot | null,
  state: StreamingJobCompletionState,
): void {
  const usableQuestionCount = latestQuestion?.usable_question_count ?? 0;
  if (!state.all_succeeded) {
    throw new Error(
      `Streaming jobs reached terminal state without all succeeding: ${JSON.stringify(
        latestJob.status_counts,
      )}`,
    );
  }
  if (latestJob.generated_count < 1 || usableQuestionCount < 1) {
    throw new Error(
      `Streaming baseline produced no usable questions (generated=${latestJob.generated_count}, usable=${usableQuestionCount}).`,
    );
  }
  if (latestJob.generated_count !== usableQuestionCount) {
    throw new Error(
      `Streaming generated question count (${latestJob.generated_count}) did not match usable question count (${usableQuestionCount}).`,
    );
  }
  const firstUsable =
    run.metrics.streaming_questions.first_usable_question_visible_ms;
  const parseComplete = run.metrics.ui_timings_ms.parse_complete_visible;
  if (firstUsable === undefined || parseComplete === undefined) {
    throw new Error('Streaming baseline missed first usable or parse-complete timing.');
  }
  if (firstUsable < parseComplete) {
    throw new Error(
      `First usable qwen question (${firstUsable}ms) was visible before OCR parse completion (${parseComplete}ms).`,
    );
  }
  const ocr = run.metrics.ocr_completion;
  if (
    ocr?.pages_processed !== EXPECTED_BASELINE_PAGES ||
    ocr.total_pages !== EXPECTED_BASELINE_PAGES ||
    !ocrChunksAccepted(run)
  ) {
    throw new Error(
      `OCR completion did not match expected ${EXPECTED_BASELINE_PAGES} pages / ${EXPECTED_BASELINE_CHUNKS} chunks: ${JSON.stringify(
        ocr,
      )}`,
    );
  }
}

function ocrChunksAccepted(run: SmokeRunState): boolean {
  const chunks = run.metrics.ocr_completion?.chunks;
  if (chunks === EXPECTED_BASELINE_CHUNKS) {
    return true;
  }
  return (
    run.options.allowOcrChunkVariance &&
    chunks !== null &&
    chunks !== undefined &&
    chunks > 0 &&
    chunks <= EXPECTED_BASELINE_CHUNKS
  );
}
