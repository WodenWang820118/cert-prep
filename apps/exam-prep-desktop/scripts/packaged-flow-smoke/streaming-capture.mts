import { setTimeout as delay } from 'node:timers/promises';

import type { Page, Response } from 'playwright';

import {
  classifyStreamingQuestionStatus,
  FIRST_CHUNK_GATE_MS,
  firstChunkGateMetrics,
  mergeStatusCounts,
  sanitizeDraftJobSnapshot,
  sanitizeQuestionSnapshot,
  streamingJobCompletionState,
} from './streaming-evidence.mts';
import { errorMessage } from './text-utils.mts';
import type {
  SmokeRunState,
  StreamingDraftJobSnapshot,
  StreamingJobCompletionState,
  StreamingQuestionSnapshot,
  UploadedDocumentRef,
} from './types.mts';
import { activePage, bodyText, log, screenshot } from './runner-context.mts';

const STREAMING_QUESTION_STATUS_PATTERN =
  /Generating \d+\/\d+|[1-9]\d* questions ready|Model missing|Reasoning unavailable|Question generation needs attention/i;
export const EXPECTED_BASELINE_PAGES = 46;
export const EXPECTED_BASELINE_CHUNKS = 46;
const STREAMING_COMPLETE_STABLE_POLLS = 3;
const STREAMING_COMPLETE_POLL_INTERVAL_MS = 5_000;
export const FIRST_CHUNK_TEXT_PATTERN = /Extracted text|Page \d+|\b[1-9]\d* chunks\b/;
const FIRST_CHUNK_VISIBLE_TIMEOUT_MS = FIRST_CHUNK_GATE_MS + 260_000;

interface FirstChunkObservation {
  readonly done: Promise<void>;
  stop(): void;
}

export function observeStreamingApiResponses(run: SmokeRunState, currentPage: Page): void {
  currentPage.on('response', (response) => {
    void recordStreamingApiResponse(run, response);
  });
}

async function recordStreamingApiResponse(run: SmokeRunState, response: Response): Promise<void> {
  if (!run.streamingDraftCaptureOpen || run.streamingDraftParseStartedAt === null) {
    return;
  }
  if (response.request().method().toUpperCase() !== 'GET') {
    return;
  }

  const url = response.url();
  const capturesDraftJobs = url.includes('/draft-jobs');
  const capturesQuestionDrafts = url.includes('/question-drafts');
  if (!capturesDraftJobs && !capturesQuestionDrafts) {
    return;
  }

  const payload = await response.json().catch(() => null);
  if (!payload) {
    return;
  }
  const elapsedMs = Date.now() - run.streamingDraftParseStartedAt;
  if (capturesDraftJobs) {
    recordStreamingDraftJobSnapshot(run, payload, elapsedMs);
  } else {
    recordStreamingQuestionSnapshot(run, payload, elapsedMs);
  }
}

function recordStreamingDraftJobSnapshot(run: SmokeRunState, payload: unknown, elapsedMs: number): void {
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

function recordStreamingQuestionSnapshot(run: SmokeRunState, payload: unknown, elapsedMs: number): void {
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

export function refreshFirstChunkGateMetrics(run: SmokeRunState): void {
  const gate = firstChunkGateMetrics(
    run.metrics.ui_timings_ms.first_chunk_visible,
    FIRST_CHUNK_GATE_MS,
  );
  run.metrics.first_chunk_gate_ms = gate.first_chunk_gate_ms;
  run.metrics.first_chunk_under_gate = gate.first_chunk_under_gate;
}

export function recordFirstChunkVisible(run: SmokeRunState, parseStart: number): void {
  if (run.metrics.ui_timings_ms.first_chunk_visible === undefined) {
    run.metrics.ui_timings_ms.first_chunk_visible = Date.now() - parseStart;
  }
  refreshFirstChunkGateMetrics(run);
}

export function observeFirstChunkVisibleFromParseStart(
  run: SmokeRunState,
  parseStart: number,
): FirstChunkObservation {
  let stopped = false;
  const firstChunkStart = Date.now();
  const done = (async () => {
    try {
      while (
        !stopped &&
        Date.now() - firstChunkStart < FIRST_CHUNK_VISIBLE_TIMEOUT_MS
      ) {
        const text = await bodyText(run);
        if (FIRST_CHUNK_TEXT_PATTERN.test(text)) {
          const elapsed = Date.now() - firstChunkStart;
          log(run, `first extracted chunk visible after ${elapsed}ms`);
          recordFirstChunkVisible(run, parseStart);
          return;
        }
        await delay(500);
      }

      if (!stopped) {
        const text = await bodyText(run);
        throw new Error(
          `Timed out waiting for first extracted chunk visible. Pattern=${FIRST_CHUNK_TEXT_PATTERN}. Body=${text.slice(0, 1400)}`,
        );
      }
    } catch (error) {
      if (!stopped) {
        run.metrics.errors.push(`first chunk wait failed: ${errorMessage(error)}`);
        refreshFirstChunkGateMetrics(run);
      }
    } finally {
      if (
        !stopped ||
        run.metrics.ui_timings_ms.first_chunk_wait_window === undefined
      ) {
        run.metrics.ui_timings_ms.first_chunk_wait_window =
          Date.now() - firstChunkStart;
      }
    }
  })();

  return {
    done,
    stop(): void {
      stopped = true;
    },
  };
}

export async function waitForUploadDocumentResponse(run: SmokeRunState): Promise<UploadedDocumentRef | null> {
  const response = await activePage(run)
    .waitForResponse(
      (candidate) =>
        candidate.request().method().toUpperCase() === 'POST' &&
        isDocumentsCollectionUrl(candidate.url()),
      { timeout: 120_000 },
    )
    .catch((error) => {
      run.metrics.observations.push(
        `Upload document response capture timed out: ${errorMessage(error)}`,
      );
      return null;
    });
  if (!response) {
    return null;
  }

  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== 'object') {
    run.metrics.observations.push('Upload document response was not valid JSON.');
    return null;
  }

  return uploadedDocumentRefFromResponse(run, response, payload);
}

function uploadedDocumentRefFromResponse(
  run: SmokeRunState,
  response: Response,
  payload: object,
): UploadedDocumentRef | null {
  const id = valueString(payload, 'id');
  const projectId = valueString(payload, 'project_id');
  if (!id || !projectId) {
    run.metrics.observations.push(
      'Upload document response did not include project_id and id.',
    );
    return null;
  }

  const apiBaseUrl = apiBaseUrlFromResponse(response);
  if (!apiBaseUrl) {
    run.metrics.observations.push(
      'Upload document response URL could not be converted to an API base URL.',
    );
    return null;
  }

  const requestHeaders = response.request().headers();
  return {
    apiBaseUrl,
    authorization: requestHeaders.authorization ?? null,
    projectId,
    documentId: id,
  };
}

function isDocumentsCollectionUrl(value: string): boolean {
  try {
    return /\/projects\/[^/]+\/documents\/?$/.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

function apiBaseUrlFromResponse(response: Response): string | null {
  try {
    const parsed = new URL(response.url());
    const markerIndex = parsed.pathname.indexOf('/projects/');
    if (markerIndex < 0) {
      return null;
    }
    const basePath = parsed.pathname.slice(0, markerIndex).replace(/\/+$/, '');
    return `${parsed.origin}${basePath}`;
  } catch {
    return null;
  }
}

function valueString(payload: object, key: string): string | null {
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function valueNumber(payload: object, key: string): number | null {
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function pollStreamingDraftApis(
  run: SmokeRunState,
  uploadedDocument: UploadedDocumentRef,
  elapsedMs: number,
): Promise<void> {
  const [jobs, drafts] = await Promise.all([
    streamingApiGet(
      run,
      uploadedDocument,
      `/projects/${encodeURIComponent(uploadedDocument.projectId)}/documents/${encodeURIComponent(
        uploadedDocument.documentId,
      )}/draft-jobs`,
    ),
    streamingApiGet(
      run,
      uploadedDocument,
      `/projects/${encodeURIComponent(uploadedDocument.projectId)}/question-drafts`,
    ),
  ]);

  if (jobs) {
    recordStreamingDraftJobSnapshot(run, jobs, elapsedMs);
  }
  if (drafts) {
    recordStreamingQuestionSnapshot(run, drafts, elapsedMs);
  }
}

async function streamingApiGet(
  run: SmokeRunState,
  uploadedDocument: UploadedDocumentRef,
  path: string,
): Promise<unknown | null> {
  try {
    const headers = uploadedDocument.authorization
      ? { Authorization: uploadedDocument.authorization }
      : undefined;
    const response = await activePage(run).request.get(
      `${uploadedDocument.apiBaseUrl}${path}`,
      {
        headers,
        timeout: 10_000,
      },
    );
    if (!response.ok()) {
      recordStreamingApiPollError(
        run,
        `Streaming API poll ${path} returned HTTP ${response.status()}.`,
      );
      return null;
    }
    return await response.json();
  } catch (error) {
    recordStreamingApiPollError(
      run,
      `Streaming API poll ${path} failed: ${errorMessage(error)}`,
    );
    return null;
  }
}

export async function createPackagedSmokeQuestion(
  run: SmokeRunState,
  uploadedDocument: UploadedDocumentRef,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const headers = uploadedDocument.authorization
    ? { Authorization: uploadedDocument.authorization }
    : undefined;
  const response = await activePage(run).request.post(
    `${uploadedDocument.apiBaseUrl}/projects/${encodeURIComponent(
      uploadedDocument.projectId,
    )}/question-drafts`,
    {
      data: payload,
      headers,
      timeout: 30_000,
    },
  );
  if (!response.ok()) {
    throw new Error(
      `Creating packaged smoke question failed with HTTP ${response.status()}: ${await response.text()}`,
    );
  }
  return await response.json();
}

export async function firstSourceChunk(
  run: SmokeRunState,
  uploadedDocument: UploadedDocumentRef,
): Promise<{ id: string; pageNumber: number; sourceExcerpt: string }> {
  const payload = await streamingApiGet(
      run,
      uploadedDocument,
    `/projects/${encodeURIComponent(uploadedDocument.projectId)}/documents/${encodeURIComponent(
      uploadedDocument.documentId,
    )}/chunks`,
  );
  const items = responseItems(payload);
  const first = items[0];
  if (!first || typeof first !== 'object') {
    throw new Error('Cannot create QA question because no source chunks were returned.');
  }
  const id = valueString(first, 'id');
  if (!id) {
    throw new Error('Cannot create QA question because the first source chunk had no id.');
  }
  return {
    id,
    pageNumber: valueNumber(first, 'page_number') ?? 1,
    sourceExcerpt:
      valueString(first, 'source_excerpt') ??
      valueString(first, 'text') ??
      'Packaged smoke source excerpt.',
  };
}

function normalizedVisibleText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export async function answerForVisiblePracticeQuestion(
  run: SmokeRunState,
  questionText: string,
): Promise<string> {
  if (!run.uploadedDocument) {
    throw new Error('Cannot answer practice question because no document API reference was captured.');
  }
  const payload = await streamingApiGet(
    run,
    run.uploadedDocument,
    `/projects/${encodeURIComponent(run.uploadedDocument.projectId)}/question-drafts`,
  );
  const question = normalizedVisibleText(questionText);
  const match = responseItems(payload).find(
    (item) => normalizedVisibleText(valueString(item, 'question') ?? '') === question,
  );
  const answer = match ? valueString(match, 'answer') : null;
  if (!answer) {
    throw new Error(
      `Cannot answer practice question because no answer matched visible question: ${question.slice(0, 120)}`,
    );
  }
  return answer;
}

function responseItems(payload: unknown): object[] {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !Array.isArray((payload as { items?: unknown }).items)
  ) {
    return [];
  }
  return (payload as { items: unknown[] }).items.filter(
    (item): item is object => typeof item === 'object' && item !== null,
  );
}

function recordStreamingApiPollError(run: SmokeRunState, message: string): void {
  if (run.streamingApiPollErrorCaptured) {
    return;
  }
  run.streamingApiPollErrorCaptured = true;
  run.metrics.errors.push(message);
}

export async function observeStreamingDraftUiUntil(
  run: SmokeRunState,
  parseStart: number,
  completion: Promise<void>,
  uploadedDocument: UploadedDocumentRef | null,
): Promise<void> {
  let completed = false;
  completion.then(
    () => {
      completed = true;
    },
    () => {
      completed = true;
    },
  );

  let statusCaptured =
    run.metrics.ui_timings_ms.streaming_question_status_visible !== undefined;
  let usableCaptured =
    run.metrics.ui_timings_ms.streaming_first_usable_question_visible !== undefined;

  while (!completed && (!statusCaptured || !usableCaptured)) {
    if (uploadedDocument) {
      await pollStreamingDraftApis(run, uploadedDocument, Date.now() - parseStart);
    }
    const text = await bodyText(run);
    if (!statusCaptured && STREAMING_QUESTION_STATUS_PATTERN.test(text)) {
      const elapsedMs = Date.now() - parseStart;
      const streamingStatus = classifyStreamingQuestionStatus(text);
      run.metrics.ui_timings_ms.streaming_question_status_visible = elapsedMs;
      run.metrics.observations.push(`Streaming question status: ${streamingStatus}.`);
      if (streamingStatus === 'ready') {
        run.metrics.ui_timings_ms.streaming_first_question_ready_visible = elapsedMs;
      } else if (streamingStatus === 'blocked') {
        run.metrics.ui_timings_ms.streaming_question_blocker_visible = elapsedMs;
      }
      await screenshot(run, 'streaming-question-status-visible');
      statusCaptured = true;
    }

    if (!usableCaptured && (await firstUsableQuestionArticleVisible(run))) {
      const elapsedMs = Date.now() - parseStart;
      run.metrics.ui_timings_ms.streaming_first_usable_question_visible = elapsedMs;
      run.metrics.streaming_questions.first_usable_question_visible_ms ??= elapsedMs;
      await screenshot(run, 'streaming-first-usable-question-visible');
      usableCaptured = true;
    }

    await Promise.race([
      delay(1_000),
      completion.catch(() => undefined),
    ]);
  }

  if (uploadedDocument) {
    await pollStreamingDraftApis(run, uploadedDocument, Date.now() - parseStart);
  }

  if (run.metrics.ui_timings_ms.streaming_question_status_visible === undefined) {
    run.metrics.observations.push(
      'Streaming question status was not visible before parse completion.',
    );
  }
}

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
  if (firstUsable >= parseComplete) {
    throw new Error(
      `First usable qwen question (${firstUsable}ms) was not visible before parse completion (${parseComplete}ms).`,
    );
  }
  const ocr = run.metrics.ocr_completion;
  if (
    ocr?.pages_processed !== EXPECTED_BASELINE_PAGES ||
    ocr.total_pages !== EXPECTED_BASELINE_PAGES ||
    ocr.chunks !== EXPECTED_BASELINE_CHUNKS
  ) {
    throw new Error(
      `OCR completion did not match expected ${EXPECTED_BASELINE_PAGES} pages / ${EXPECTED_BASELINE_CHUNKS} chunks: ${JSON.stringify(
        ocr,
      )}`,
    );
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

async function firstUsableQuestionArticleVisible(
  run: SmokeRunState,
): Promise<boolean> {
  if (!run.page) {
    return false;
  }
  try {
    return await run.page.locator('app-draft-review-panel article').evaluateAll(
      (articles) =>
        articles.some((article) => {
          const question = article.querySelector('h3')?.textContent?.trim() ?? '';
          const choices = Array.from(article.querySelectorAll('ol li')).filter(
            (choice) => (choice.textContent ?? '').trim().length > 0,
          );
          return question.length > 0 && choices.length >= 2;
        }),
    );
  } catch (error) {
    if (errorMessage(error).includes('Execution context was destroyed')) {
      return false;
    }
    throw error;
  }
}
