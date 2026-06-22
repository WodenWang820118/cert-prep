import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Page, type Response } from 'playwright';

import { parsePackagedFlowSmokeArgs } from './args.mts';
import {
  processSnapshot,
  publicProcessRecord,
  requestWindowsCloseByPid,
  selectExamPrepResidue,
  selectNewWorkspaceNodeHelpers,
  snapshotWindowsProcesses,
  terminateProcessTreeByPid,
} from './processes.mts';
import {
  packagedAppDataDir,
  preparePackagedBackendRuntimeForSmoke,
} from './runtime-sync.mts';
import { startResourceSampling } from './resource-sampling.mts';
import {
  classifyStreamingQuestionStatus,
  FIRST_CHUNK_GATE_MS,
  firstChunkGateMetrics,
  mergeStatusCounts,
  sanitizeDraftJobSnapshot,
  sanitizeQuestionSnapshot,
  streamingJobCompletionState,
} from './streaming-evidence.mts';
import { errorMessage, normalizePath } from './text-utils.mts';
import type {
  CloseSummary,
  PublicProcessRecord,
  ResourceSamplingArtifacts,
  SmokeMetrics,
  SmokeRunState,
  StreamingDraftJobSnapshot,
  StreamingJobCompletionState,
  StreamingQuestionSnapshot,
  UploadedDocumentRef,
} from './types.mts';

const STREAMING_QUESTION_STATUS_PATTERN =
  /Generating \d+\/\d+|[1-9]\d* questions ready|Model missing|Reasoning unavailable|Question generation needs attention/i;
const EXPECTED_BASELINE_PAGES = 46;
const EXPECTED_BASELINE_CHUNKS = 46;
const STREAMING_COMPLETE_STABLE_POLLS = 3;
const STREAMING_COMPLETE_POLL_INTERVAL_MS = 5_000;
const FIRST_CHUNK_TEXT_PATTERN = /Extracted text|Page \d+|\b[1-9]\d* chunks\b/;
const FIRST_CHUNK_VISIBLE_TIMEOUT_MS = FIRST_CHUNK_GATE_MS + 260_000;

interface StreamingBaselineReport {
  schema_version: 1;
  status: 'passed' | 'failed';
  generated_at: string;
  git_commit: string | null;
  artifacts: {
    out_dir: string;
    metrics_json: string;
    baseline_json: string;
    baseline_markdown: string;
    screenshots: string[];
    gpu_sampling?: string;
    resource_sampling?: ResourceSamplingArtifacts;
  };
  input: {
    pdf_path: string;
    pdf_bytes: number;
    pdf_sha256: string;
    expected_pages: 46;
    expected_chunks: 46;
  };
  runtime: {
    exe_path: string;
    app_data_dir: string | null;
    llm_model: string;
    ocr_provider: string;
    ocr_page_workers: number;
    streaming_draft_page_limit: number | null;
    streaming_draft_workers: number | null;
    streaming_complete_timeout_ms: number;
  };
  timings_ms: Record<string, number | null>;
  ocr_completion: {
    pages_processed: number | null;
    total_pages: number | null;
    chunks: number | null;
  };
  streaming: {
    job_count: number;
    final_status_counts: Record<string, number>;
    completion_state: StreamingJobCompletionState;
    generated_count: number;
    question_count: number;
    usable_question_count: number;
    first_usable_before_parse_complete: boolean;
    job_snapshot_count: number;
    question_snapshot_count: number;
    blocker: string | null;
  };
  cleanup: {
    gracefulExited: boolean | null;
    fallbackUsed: boolean | null;
    exitCode: number | null;
    residualProcesses: PublicProcessRecord[];
    nodeClosedCount: number | null;
  };
  checks: Record<string, boolean>;
  errors: string[];
}

interface FirstChunkObservation {
  readonly done: Promise<void>;
  stop(): void;
}

let run: SmokeRunState;

async function closeAppAndCheckResidue(label: string): Promise<CloseSummary> {
  const currentApp = run.app;
  const pid = currentApp?.pid ?? null;
  if (!currentApp || !pid) {
    return {
      label,
      app_pid: null,
      normal_close_requested: false,
      exited_after_normal_close: true,
      forced: false,
      residue: [],
      gracefulExited: true,
      fallbackUsed: false,
      exitCode: null,
      residualProcesses: [],
    };
  }

  const normalCloseRequested = requestWindowsCloseByPid(pid);
  const exitedAfterNormalClose = await waitForChildExit(currentApp, 8_000);
  const exitCode = run.appExit?.code ?? currentApp.exitCode ?? null;
  let forced = false;

  if (!exitedAfterNormalClose) {
    forced = true;
    run.metrics.observations.push(
      `${label} app process ${pid} did not exit after normal close; terminating its process tree.`,
    );
    terminateProcessTreeByPid(pid);
    await waitForChildExit(currentApp, 8_000);
  }

  await run.browser?.close().catch(ignoreCleanupError);
  run.browser = null;
  run.page = null;
  run.app = null;
  run.appExit = null;

  let residue = selectExamPrepResidue(snapshotWindowsProcesses(), pid);
  if (residue.length > 0) {
    forced = true;
    for (const record of residue) {
      terminateProcessTreeByPid(record.pid);
    }
    await delay(1_000);
    residue = selectExamPrepResidue(snapshotWindowsProcesses(), pid);
  }

  const publicResidue = residue.map(publicProcessRecord);
  const summary: CloseSummary = {
    label,
    app_pid: pid,
    normal_close_requested: normalCloseRequested,
    exited_after_normal_close: exitedAfterNormalClose,
    forced,
    residue: publicResidue,
    gracefulExited:
      normalCloseRequested && exitedAfterNormalClose && publicResidue.length === 0,
    fallbackUsed: forced,
    exitCode,
    residualProcesses: publicResidue,
  };

  if (summary.residue.length > 0) {
    throw new Error(
      `${label} left process residue: ${summary.residue
        .map((record) => `${record.name}#${record.pid}`)
        .join(', ')}`,
    );
  }
  return summary;
}

async function closeNewNodeHelpers(): Promise<PublicProcessRecord[]> {
  const helpers = selectNewWorkspaceNodeHelpers({
    beforeNodePids: run.processBaseline.nodePids,
    after: snapshotWindowsProcesses(),
    ownerPid: process.pid,
    workspaceRoot: run.options.workspaceRoot,
    runMarker: run.options.outDir,
  });
  for (const helper of helpers) {
    terminateProcessTreeByPid(helper.pid);
  }
  if (helpers.length > 0) {
    await delay(1_000);
  }
  return helpers.map(publicProcessRecord);
}

function observeStreamingApiResponses(currentPage: Page): void {
  currentPage.on('response', (response) => {
    void recordStreamingApiResponse(response);
  });
}

async function recordStreamingApiResponse(response: Response): Promise<void> {
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
    recordStreamingDraftJobSnapshot(payload, elapsedMs);
  } else {
    recordStreamingQuestionSnapshot(payload, elapsedMs);
  }
}

function recordStreamingDraftJobSnapshot(payload: unknown, elapsedMs: number): void {
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

function recordStreamingQuestionSnapshot(payload: unknown, elapsedMs: number): void {
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

function refreshFirstChunkGateMetrics(): void {
  const gate = firstChunkGateMetrics(
    run.metrics.ui_timings_ms.first_chunk_visible,
    FIRST_CHUNK_GATE_MS,
  );
  run.metrics.first_chunk_gate_ms = gate.first_chunk_gate_ms;
  run.metrics.first_chunk_under_gate = gate.first_chunk_under_gate;
}

function recordFirstChunkVisible(parseStart: number): void {
  if (run.metrics.ui_timings_ms.first_chunk_visible === undefined) {
    run.metrics.ui_timings_ms.first_chunk_visible = Date.now() - parseStart;
  }
  refreshFirstChunkGateMetrics();
}

function observeFirstChunkVisibleFromParseStart(
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
        const text = await bodyText();
        if (FIRST_CHUNK_TEXT_PATTERN.test(text)) {
          const elapsed = Date.now() - firstChunkStart;
          log(`first extracted chunk visible after ${elapsed}ms`);
          recordFirstChunkVisible(parseStart);
          return;
        }
        await delay(500);
      }

      if (!stopped) {
        const text = await bodyText();
        throw new Error(
          `Timed out waiting for first extracted chunk visible. Pattern=${FIRST_CHUNK_TEXT_PATTERN}. Body=${text.slice(0, 1400)}`,
        );
      }
    } catch (error) {
      if (!stopped) {
        run.metrics.errors.push(`first chunk wait failed: ${errorMessage(error)}`);
        refreshFirstChunkGateMetrics();
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

async function waitForUploadDocumentResponse(): Promise<UploadedDocumentRef | null> {
  const response = await activePage()
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

  return uploadedDocumentRefFromResponse(response, payload);
}

function uploadedDocumentRefFromResponse(
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
  uploadedDocument: UploadedDocumentRef,
  elapsedMs: number,
): Promise<void> {
  const [jobs, drafts] = await Promise.all([
    streamingApiGet(
      uploadedDocument,
      `/projects/${encodeURIComponent(uploadedDocument.projectId)}/documents/${encodeURIComponent(
        uploadedDocument.documentId,
      )}/draft-jobs`,
    ),
    streamingApiGet(
      uploadedDocument,
      `/projects/${encodeURIComponent(uploadedDocument.projectId)}/question-drafts`,
    ),
  ]);

  if (jobs) {
    recordStreamingDraftJobSnapshot(jobs, elapsedMs);
  }
  if (drafts) {
    recordStreamingQuestionSnapshot(drafts, elapsedMs);
  }
}

async function streamingApiGet(
  uploadedDocument: UploadedDocumentRef,
  path: string,
): Promise<unknown | null> {
  try {
    const headers = uploadedDocument.authorization
      ? { Authorization: uploadedDocument.authorization }
      : undefined;
    const response = await activePage().request.get(
      `${uploadedDocument.apiBaseUrl}${path}`,
      {
        headers,
        timeout: 10_000,
      },
    );
    if (!response.ok()) {
      recordStreamingApiPollError(
        `Streaming API poll ${path} returned HTTP ${response.status()}.`,
      );
      return null;
    }
    return await response.json();
  } catch (error) {
    recordStreamingApiPollError(
      `Streaming API poll ${path} failed: ${errorMessage(error)}`,
    );
    return null;
  }
}

async function createPackagedSmokeQuestion(
  uploadedDocument: UploadedDocumentRef,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const headers = uploadedDocument.authorization
    ? { Authorization: uploadedDocument.authorization }
    : undefined;
  const response = await activePage().request.post(
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

async function firstSourceChunk(
  uploadedDocument: UploadedDocumentRef,
): Promise<{ id: string; pageNumber: number; sourceExcerpt: string }> {
  const payload = await streamingApiGet(
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

async function answerForVisiblePracticeQuestion(
  questionText: string,
): Promise<string> {
  if (!run.uploadedDocument) {
    throw new Error('Cannot answer practice question because no document API reference was captured.');
  }
  const payload = await streamingApiGet(
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

function recordStreamingApiPollError(message: string): void {
  if (run.streamingApiPollErrorCaptured) {
    return;
  }
  run.streamingApiPollErrorCaptured = true;
  run.metrics.errors.push(message);
}

async function observeStreamingDraftUiUntil(
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
      await pollStreamingDraftApis(uploadedDocument, Date.now() - parseStart);
    }
    const text = await bodyText();
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
      await screenshot('streaming-question-status-visible');
      statusCaptured = true;
    }

    if (!usableCaptured && (await firstUsableQuestionArticleVisible())) {
      const elapsedMs = Date.now() - parseStart;
      run.metrics.ui_timings_ms.streaming_first_usable_question_visible = elapsedMs;
      run.metrics.streaming_questions.first_usable_question_visible_ms ??= elapsedMs;
      await screenshot('streaming-first-usable-question-visible');
      usableCaptured = true;
    }

    await Promise.race([
      delay(1_000),
      completion.catch(() => undefined),
    ]);
  }

  if (uploadedDocument) {
    await pollStreamingDraftApis(uploadedDocument, Date.now() - parseStart);
  }

  if (run.metrics.ui_timings_ms.streaming_question_status_visible === undefined) {
    run.metrics.observations.push(
      'Streaming question status was not visible before parse completion.',
    );
  }
}

async function waitForStreamingJobsComplete(
  uploadedDocument: UploadedDocumentRef,
  parseStart: number,
): Promise<void> {
  const deadline = Date.now() + run.options.streamingCompleteTimeoutMs;
  let stableTerminalPolls = 0;
  let previousTerminalJobCount: number | null = null;
  let latestState: StreamingJobCompletionState | null = null;

  while (Date.now() < deadline) {
    const elapsedMs = Date.now() - parseStart;
    await pollStreamingDraftApis(uploadedDocument, elapsedMs);
    const latestJob = latestStreamingJobSnapshot();
    const latestQuestion = latestStreamingQuestionSnapshot();

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
        assertSuccessfulStreamingBaseline(latestJob, latestQuestion, latestState);
        await screenshot('streaming-baseline-complete');
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

function latestStreamingJobSnapshot(): StreamingDraftJobSnapshot | null {
  return (
    run.metrics.streaming_questions.job_snapshots[
      run.metrics.streaming_questions.job_snapshots.length - 1
    ] ?? null
  );
}

function latestStreamingQuestionSnapshot(): StreamingQuestionSnapshot | null {
  return (
    run.metrics.streaming_questions.question_snapshots[
      run.metrics.streaming_questions.question_snapshots.length - 1
    ] ?? null
  );
}

async function firstUsableQuestionArticleVisible(): Promise<boolean> {
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

function log(message: string): void {
  console.log(`[qa] ${message}`);
  appendFileSync(
    join(run.options.outDir, 'run.log'),
    `${new Date().toISOString()} ${message}\n`,
  );
}

function saveMetrics(): void {
  refreshFirstChunkGateMetrics();
  run.metrics.finished_at = new Date().toISOString();
  writeFileSync(
    join(run.options.outDir, 'metrics.json'),
    `${JSON.stringify(run.metrics, null, 2)}\n`,
  );
}

function writeStreamingBaselineArtifacts({
  recordFailure = true,
}: {
  readonly recordFailure?: boolean;
} = {}): void {
  if (!run.options.waitForStreamingComplete) {
    return;
  }

  let report = buildStreamingBaselineReport();
  if (report.status === 'failed' && recordFailure) {
    run.metrics.errors.push('Streaming baseline checks failed.');
    report = buildStreamingBaselineReport();
  }
  const jsonPath = join(run.options.outDir, 'streaming-baseline.json');
  const markdownPath = join(run.options.outDir, 'streaming-baseline.md');
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, renderStreamingBaselineMarkdown(report));
  run.metrics.streaming_baseline = {
    status: report.status,
    json: normalizePath(relative(run.options.workspaceRoot, jsonPath)),
    markdown: normalizePath(relative(run.options.workspaceRoot, markdownPath)),
  };
}

function buildStreamingBaselineReport(): StreamingBaselineReport {
  const latestJob = latestStreamingJobSnapshot();
  const latestQuestion = latestStreamingQuestionSnapshot();
  const finalStatusCounts = latestJob?.status_counts ?? {};
  const completionState = streamingJobCompletionState(finalStatusCounts);
  refreshFirstChunkGateMetrics();
  const timings = run.metrics.ui_timings_ms;
  const firstUsable =
    run.metrics.streaming_questions.first_usable_question_visible_ms;
  const parseComplete = timings.parse_complete_visible;
  const firstUsableBeforeParseComplete =
    firstUsable !== undefined &&
    parseComplete !== undefined &&
    firstUsable < parseComplete;
  const checks = {
    no_script_errors: run.metrics.errors.length === 0,
    graceful_close: run.metrics.final_close?.gracefulExited === true,
    no_residual_processes:
      (run.metrics.final_close?.residualProcesses.length ?? 0) === 0 &&
      (run.metrics.process_cleanup?.residue_after_close.length ?? 0) === 0,
    ocr_completed_46_pages:
      run.metrics.ocr_completion?.pages_processed === EXPECTED_BASELINE_PAGES &&
      run.metrics.ocr_completion?.total_pages === EXPECTED_BASELINE_PAGES,
    ocr_completed_46_chunks:
      run.metrics.ocr_completion?.chunks === EXPECTED_BASELINE_CHUNKS,
    first_chunk_under_gate: run.metrics.first_chunk_under_gate,
    first_usable_before_parse_complete: firstUsableBeforeParseComplete,
    all_jobs_terminal: completionState.all_terminal,
    all_jobs_succeeded: completionState.all_succeeded,
    generated_equals_usable:
      (latestJob?.generated_count ?? 0) > 0 &&
      latestJob?.generated_count === latestQuestion?.usable_question_count,
    no_streaming_blocker: !run.metrics.streaming_questions.blocker,
  };
  const status = Object.values(checks).every(Boolean) ? 'passed' : 'failed';
  const metricsPath = join(run.options.outDir, 'metrics.json');
  const baselineJsonPath = join(run.options.outDir, 'streaming-baseline.json');
  const baselineMarkdownPath = join(run.options.outDir, 'streaming-baseline.md');

  return {
    schema_version: 1,
    status,
    generated_at: new Date().toISOString(),
    git_commit: currentGitCommit(),
    artifacts: {
      out_dir: normalizePath(relative(run.options.workspaceRoot, run.options.outDir)),
      metrics_json: normalizePath(relative(run.options.workspaceRoot, metricsPath)),
      baseline_json: normalizePath(
        relative(run.options.workspaceRoot, baselineJsonPath),
      ),
      baseline_markdown: normalizePath(
        relative(run.options.workspaceRoot, baselineMarkdownPath),
      ),
      screenshots: run.metrics.screenshots,
      ...(run.metrics.gpu_sampling ? { gpu_sampling: run.metrics.gpu_sampling } : {}),
      ...(run.metrics.resource_sampling
        ? { resource_sampling: run.metrics.resource_sampling }
        : {}),
    },
    input: {
      pdf_path: normalizePath(relative(run.options.workspaceRoot, run.options.pdfPath)),
      pdf_bytes: statSync(run.options.pdfPath).size,
      pdf_sha256: sha256File(run.options.pdfPath),
      expected_pages: EXPECTED_BASELINE_PAGES,
      expected_chunks: EXPECTED_BASELINE_CHUNKS,
    },
    runtime: {
      exe_path: normalizePath(relative(run.options.workspaceRoot, run.options.exePath)),
      app_data_dir: run.options.appDataDir
        ? normalizePath(relative(run.options.workspaceRoot, run.options.appDataDir))
        : null,
      llm_model: run.options.ollamaModel,
      ocr_provider: run.options.ocrProvider,
      ocr_page_workers: run.options.ocrPageWorkers,
      streaming_draft_page_limit: run.options.streamingDraftPageLimit ?? null,
      streaming_draft_workers: run.options.streamingDraftWorkers ?? null,
      streaming_complete_timeout_ms: run.options.streamingCompleteTimeoutMs,
    },
    timings_ms: {
      upload_to_processing_visible: timings.upload_to_processing_visible ?? null,
      first_chunk_gate_ms: run.metrics.first_chunk_gate_ms,
      first_chunk_visible: timings.first_chunk_visible ?? null,
      streaming_question_status_visible:
        timings.streaming_question_status_visible ?? null,
      first_streamed_question_visible:
        run.metrics.streaming_questions.first_question_visible_ms ?? null,
      first_usable_question_visible: firstUsable ?? null,
      parse_complete_visible: parseComplete ?? null,
      streaming_all_jobs_terminal:
        run.metrics.streaming_questions.all_jobs_terminal_ms ?? null,
    },
    ocr_completion: {
      pages_processed: run.metrics.ocr_completion?.pages_processed ?? null,
      total_pages: run.metrics.ocr_completion?.total_pages ?? null,
      chunks: run.metrics.ocr_completion?.chunks ?? null,
    },
    streaming: {
      job_count: latestJob?.item_count ?? 0,
      final_status_counts: finalStatusCounts,
      completion_state: completionState,
      generated_count: latestJob?.generated_count ?? 0,
      question_count: latestQuestion?.item_count ?? 0,
      usable_question_count: latestQuestion?.usable_question_count ?? 0,
      first_usable_before_parse_complete: firstUsableBeforeParseComplete,
      job_snapshot_count: run.metrics.streaming_questions.job_snapshots.length,
      question_snapshot_count:
        run.metrics.streaming_questions.question_snapshots.length,
      blocker: run.metrics.streaming_questions.blocker ?? null,
    },
    cleanup: {
      gracefulExited: run.metrics.final_close?.gracefulExited ?? null,
      fallbackUsed: run.metrics.final_close?.fallbackUsed ?? null,
      exitCode: run.metrics.final_close?.exitCode ?? null,
      residualProcesses:
        run.metrics.final_close?.residualProcesses ??
        run.metrics.process_cleanup?.residue_after_close ??
        [],
      nodeClosedCount:
        run.metrics.process_cleanup?.node_cleanup_summary.closed_count ?? null,
    },
    checks,
    errors: run.metrics.errors,
  };
}

function renderStreamingBaselineMarkdown(report: StreamingBaselineReport): string {
  return `# Packaged Streaming Baseline

- Status: ${report.status}
- Generated: ${report.generated_at}
- Git commit: ${report.git_commit ?? 'unknown'}
- Model: ${report.runtime.llm_model}
- PDF: ${report.input.pdf_path} (${report.input.pdf_bytes} bytes)
- OCR: ${report.ocr_completion.pages_processed}/${report.ocr_completion.total_pages} pages, ${report.ocr_completion.chunks} chunks
- First chunk visible: ${formatMaybeMs(report.timings_ms.first_chunk_visible)} (gate: ${formatMaybeMs(report.timings_ms.first_chunk_gate_ms)}, under gate: ${String(report.checks.first_chunk_under_gate)})
- First usable qwen question: ${formatMaybeMs(report.timings_ms.first_usable_question_visible)}
- Parse complete: ${formatMaybeMs(report.timings_ms.parse_complete_visible)}
- All streaming jobs terminal: ${formatMaybeMs(report.timings_ms.streaming_all_jobs_terminal)}
- Jobs: ${report.streaming.job_count}, generated: ${report.streaming.generated_count}, usable questions: ${report.streaming.usable_question_count}
- Final job statuses: ${JSON.stringify(report.streaming.final_status_counts)}
- Graceful close: ${String(report.cleanup.gracefulExited)}, fallback used: ${String(report.cleanup.fallbackUsed)}, residual processes: ${report.cleanup.residualProcesses.length}

Artifacts:

- Metrics: ${report.artifacts.metrics_json}
- Baseline JSON: ${report.artifacts.baseline_json}
- Screenshots: ${report.artifacts.screenshots.length}
${renderResourceSamplingMarkdown(report.artifacts.resource_sampling)}
`;
}

function formatMaybeMs(value: number | null): string {
  return value === null ? 'n/a' : `${value} ms`;
}

function renderResourceSamplingMarkdown(
  artifacts: ResourceSamplingArtifacts | undefined,
): string {
  if (!artifacts) {
    return '';
  }
  const paths = [
    artifacts.nvidia_smi_csv,
    artifacts.windows_counters_csv,
    artifacts.windows_summary_json,
  ].filter((path): path is string => Boolean(path));
  if (paths.length === 0) {
    return '';
  }
  return `- Resource sampling: ${paths.join(', ')}`;
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function currentGitCommit(): string | null {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: run.options.workspaceRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function activePage(): Page {
  if (!run.page) {
    throw new Error('The packaged app page is not connected.');
  }
  return run.page;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function fetchJson(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForCdp(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const version = await fetchJson(`http://127.0.0.1:${run.port}/json/version`);
    if (version) {
      return;
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for WebView2 CDP on port ${run.port}`);
}

async function bodyText(): Promise<string> {
  if (!run.page) {
    return '';
  }
  try {
    return await run.page.evaluate(() => document.body?.innerText ?? '');
  } catch (error) {
    if (errorMessage(error).includes('Execution context was destroyed')) {
      await delay(500);
      return '';
    }
    throw error;
  }
}

async function waitText(
  pattern: RegExp,
  timeoutMs: number,
  label: string,
): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const text = await bodyText();
    if (pattern.test(text)) {
      const elapsed = Date.now() - start;
      log(`${label} after ${elapsed}ms`);
      return elapsed;
    }
    await delay(500);
  }
  const text = await bodyText();
  throw new Error(
    `Timed out waiting for ${label}. Pattern=${pattern}. Body=${text.slice(0, 1400)}`,
  );
}

function metricText(value: unknown): string {
  return Array.from(String(value ?? ''))
    .map((character) => {
      const code = character.charCodeAt(0);
      if (
        code <= 0x1f ||
        (code >= 0x7f && code <= 0x9f) ||
        (code >= 0xd800 && code <= 0xdfff)
      ) {
        return ' ';
      }
      return character;
    })
    .join('')
    .trim()
    .slice(0, 200);
}

async function screenshot(name: string): Promise<void> {
  const file = join(
    run.options.outDir,
    `${String(run.metrics.screenshots.length + 1).padStart(2, '0')}-${name}.png`,
  );
  await activePage().screenshot({ path: file, fullPage: true });
  run.metrics.screenshots.push(normalizePath(relative(run.options.workspaceRoot, file)));
  log(`screenshot ${file.split(/[\\/]/).pop() ?? name}`);
}

async function clickButtonText(
  text: string,
  buttonOptions: { timeout?: number; exact?: boolean; force?: boolean } = {},
): Promise<void> {
  const timeout = buttonOptions.timeout ?? 20_000;
  const pattern = buttonOptions.exact
    ? new RegExp(`^\\s*${escapeRegExp(text)}\\s*$`)
    : text;
  const locator = activePage()
    .locator('button')
    .filter({ hasText: pattern })
    .first();
  await locator.waitFor({ state: 'visible', timeout });
  await locator.click({ timeout, force: buttonOptions.force ?? false });
}

async function clickButtonPattern(
  pattern: RegExp,
  buttonOptions: { timeout?: number; force?: boolean } = {},
): Promise<void> {
  const timeout = buttonOptions.timeout ?? 20_000;
  const locator = activePage()
    .locator('button')
    .filter({ hasText: pattern })
    .first();
  await locator.waitFor({ state: 'visible', timeout });
  await locator.click({ timeout, force: buttonOptions.force ?? false });
}

async function clickConsentInstall(): Promise<void> {
  const buttons = activePage()
    .locator('button')
    .filter({ hasText: /^\s*Install\s*$/ });
  const count = await buttons.count();
  if (count === 0) {
    throw new Error('No Install consent button found');
  }
  await buttons.nth(count - 1).evaluate((button) => {
    if (button instanceof HTMLElement) {
      button.click();
      return;
    }
    button.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  });
}

async function openRuntimeDrawer(): Promise<void> {
  if (/Runtime details/.test(await bodyText())) {
    return;
  }
  await clickButtonText('Manage runtime');
  await waitText(/Runtime details/, 10_000, 'runtime drawer visible');
}

function runtimeDrawerLocator() {
  return activePage()
    .locator('.p-dialog, [role="dialog"]')
    .filter({ hasText: /Runtime details/ })
    .last();
}

async function runtimeDrawerText(): Promise<string> {
  await openRuntimeDrawer();
  const drawer = runtimeDrawerLocator();
  await drawer.waitFor({ state: 'visible', timeout: 10_000 });
  return drawer.innerText({ timeout: 10_000 });
}

async function waitRuntimeDrawerText(
  pattern: RegExp,
  timeoutMs: number,
  label: string,
): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const text = await runtimeDrawerText();
    if (pattern.test(text)) {
      const elapsed = Date.now() - start;
      log(`${label} after ${elapsed}ms`);
      return elapsed;
    }
    await delay(500);
  }
  const text = await runtimeDrawerText();
  throw new Error(
    `Timed out waiting for ${label}. Pattern=${pattern}. Drawer=${text.slice(0, 1400)}`,
  );
}

async function closeRuntimeDrawer(): Promise<void> {
  if (!/Runtime details/.test(await bodyText())) {
    return;
  }
  const closeButtons = activePage().locator(
    'button[aria-label="Close"], button.p-dialog-header-close',
  );
  const count = await closeButtons.count();
  if (count > 0) {
    await closeButtons.nth(count - 1).click({ force: true });
  } else {
    await activePage().keyboard.press('Escape');
  }
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    if (!/Runtime details/.test(await bodyText())) {
      return;
    }
    await delay(250);
  }
  throw new Error('Runtime drawer did not close');
}

async function refreshRuntimeDrawer(): Promise<void> {
  await openRuntimeDrawer();
  const refresh = activePage()
    .locator('button')
    .filter({ hasText: /^\s*Refresh\s*$/ })
    .first();
  try {
    await refresh.waitFor({ state: 'visible', timeout: 10_000 });
    await refresh.click({ timeout: 10_000 });
  } catch (error) {
    run.metrics.observations.push(
      `Runtime refresh skipped or disabled: ${errorMessage(error)}`,
    );
  }
  await delay(2_500);
}

async function installPythonRuntimeIfNeeded(): Promise<void> {
  if (!/Install the Python backend runtime|Install runtime/.test(await bodyText())) {
    run.metrics.observations.push(
      'Python backend runtime was already available at QA start.',
    );
    return;
  }

  await screenshot('runtime-python-missing');
  await openRuntimeDrawer();
  await screenshot('runtime-drawer-python-missing');
  const start = Date.now();
  await clickButtonPattern(/^\s*Install runtime\s*$/);
  await waitText(/Install Python backend runtime/, 10_000, 'python install consent');
  await screenshot('python-install-consent');
  await clickConsentInstall();
  await waitText(
    /Projects|Select or create a project|Workspace ready|Python 3/,
    90_000,
    'python runtime ready',
  );
  run.metrics.ui_timings_ms.python_runtime_install = Date.now() - start;
  await screenshot('python-runtime-ready');
}

async function installOcrRuntimeIfNeeded(): Promise<void> {
  await openRuntimeDrawer();
  await refreshRuntimeDrawer();

  let text = await runtimeDrawerText();
  if (
    /Unknown|status unavailable|OCR unknown|PaddleOCR status unavailable|AMD DirectML OCR status unavailable/i.test(
      text,
    )
  ) {
    run.metrics.observations.push(
      'Runtime drawer showed OCR unknown after Python install; manual refresh was required.',
    );
    await refreshRuntimeDrawer();
    text = await runtimeDrawerText();
  }

  if (ocrReadyPattern().test(text)) {
    run.metrics.observations.push(
      'OCR runtime was already ready after runtime refresh.',
    );
    await screenshot('runtime-ocr-ready-after-refresh');
    return;
  }

  if (!ocrInstallablePattern().test(text)) {
    run.metrics.observations.push(
      'Waiting longer for OCR health to settle before treating the drawer as failed.',
    );
    await waitRuntimeDrawerText(
      ocrSettledPattern(),
      180_000,
      'ocr health settled',
    );
    text = await runtimeDrawerText();
  }

  if (ocrReadyPattern().test(text)) {
    run.metrics.observations.push(
      'OCR runtime became ready after delayed health settling.',
    );
    await screenshot('runtime-ocr-ready-after-delayed-health');
    return;
  }

  if (!ocrInstallablePattern().test(text)) {
    throw new Error(
      `OCR install action did not appear. Runtime drawer text: ${text.slice(0, 1400)}`,
    );
  }

  const start = Date.now();
  await clickButtonPattern(/^\s*Install OCR\s*$/);
  await waitText(
    /Install the (PaddleOCR|AMD DirectML OCR) runtime/,
    10_000,
    'ocr install consent',
  );
  await screenshot('ocr-install-consent');
  await clickConsentInstall();
  await waitText(ocrReadyPattern(), 240_000, 'ocr runtime ready');
  run.metrics.ui_timings_ms.paddleocr_runtime_install = Date.now() - start;
  await screenshot('runtime-checklist-ready');
}

function ocrInstallablePattern(): RegExp {
  return /Install OCR|PaddleOCR runtime is not installed|paddle_runtime_missing|AMD DirectML OCR runtime is not installed|directml_runtime_missing/i;
}

function ocrReadyPattern(): RegExp {
  return /PaddleOCR imports available|gpu:0|PaddleOCR runtime is ready|paddle\s*\/\s*(gpu|cpu)|AMD DirectML OCR runtime is ready|directml\s*\/\s*amd_directml|OCR ready/i;
}

function ocrSettledPattern(): RegExp {
  return new RegExp(
    `${ocrReadyPattern().source}|${ocrInstallablePattern().source}`,
    'i',
  );
}

async function createProject(): Promise<void> {
  await closeRuntimeDrawer();
  const projectName = `Parallel Parsing QA ${new Date()
    .toISOString()
    .slice(11, 19)}`;
  await activePage().locator('#projectName').fill(projectName);
  await activePage()
    .locator('#projectDescription')
    .fill(
      'Packaged QA flow for parallel parsing, reasoning model UX, and wrong-answer review.',
    );
  await clickButtonText('Create project');
  await waitText(
    new RegExp(escapeRegExp(projectName)),
    30_000,
    'project created and selected',
  );
  await screenshot('project-created');
  run.metrics.project_name = projectName;
}

async function uploadAndParsePdf(): Promise<void> {
  await activePage()
    .locator('label')
    .filter({ hasText: 'Language' })
    .locator('select')
    .selectOption('ja');
  await activePage().locator('input[type="file"]').setInputFiles(run.options.pdfPath);
  await screenshot('pdf-selected-language-ja');

  const uploadDocumentResponse = waitForUploadDocumentResponse();
  const uploadStart = Date.now();
  await clickButtonText('Upload PDF', { timeout: 120_000 });
  await waitText(
    /Parsing started|Parsing continues|0\/\d+ pages|processing/i,
    30_000,
    'upload response / parsing visible',
  );
  run.metrics.ui_timings_ms.upload_to_processing_visible = Date.now() - uploadStart;
  const parseStart = Date.now();
  run.streamingDraftParseStartedAt = parseStart;
  run.streamingDraftCaptureOpen = true;
  const firstChunkObservation = observeFirstChunkVisibleFromParseStart(parseStart);

  try {
    const uploadedDocument = await uploadDocumentResponse;
    run.uploadedDocument = uploadedDocument;
    if (uploadedDocument) {
      run.metrics.observations.push(
        `Captured upload document reference for streaming API polling: ${uploadedDocument.documentId}.`,
      );
    } else {
      run.metrics.observations.push(
        'Upload document response was not captured; streaming evidence is limited to UI/API responses.',
      );
    }
    await screenshot('parsing-started');

    await delay(FIRST_CHUNK_GATE_MS);
    const midText = await bodyText();
    if (FIRST_CHUNK_TEXT_PATTERN.test(midText)) {
      recordFirstChunkVisible(parseStart);
    } else {
      run.metrics.observations.push(
        'No extracted chunk was visible 15s after parsing started.',
      );
      refreshFirstChunkGateMetrics();
    }
    await screenshot('mid-parse-ui-still-usable');

    await firstChunkObservation.done;

    const parseCompletePromise = waitText(
      /Parsing complete\.|46\/46 pages|ready\s*Page/i,
      300_000,
      'parsing complete',
    ).then(() => {
      run.metrics.ui_timings_ms.parse_complete_visible = Date.now() - parseStart;
    });
    await observeStreamingDraftUiUntil(
      parseStart,
      parseCompletePromise,
      uploadedDocument,
    );
    await parseCompletePromise;
    recordOcrCompletionFromText(await bodyText());
    if (run.options.waitForStreamingComplete) {
      if (!uploadedDocument) {
        throw new Error('Cannot wait for streaming completion without upload API reference.');
      }
      await waitForStreamingJobsComplete(uploadedDocument, parseStart);
    }
  } finally {
    firstChunkObservation.stop();
    await firstChunkObservation.done;
    run.streamingDraftCaptureOpen = false;
  }
  await screenshot('parsing-complete-with-metrics');
}

function recordOcrCompletionFromText(text: string): void {
  const pagesMatch = text.match(/(\d+)\s*\/\s*(\d+)\s*pages/i);
  const chunksMatch = text.match(/\b(\d+)\s+chunks\b/i);
  run.metrics.ocr_completion = {
    pages_processed: pagesMatch ? Number(pagesMatch[1]) : null,
    total_pages: pagesMatch ? Number(pagesMatch[2]) : null,
    chunks: chunksMatch ? Number(chunksMatch[1]) : null,
    expected_pages: EXPECTED_BASELINE_PAGES,
    expected_chunks: EXPECTED_BASELINE_CHUNKS,
  };
}

async function createAndEditQuestion(): Promise<void> {
  if (!run.uploadedDocument) {
    throw new Error('Cannot create QA question without uploaded document reference.');
  }

  const correctAnswer = 'Packaged smoke correct answer';
  const wrongAnswer = 'Packaged smoke wrong answer';
  const chunk = await firstSourceChunk(run.uploadedDocument);
  const createStart = Date.now();
  await createPackagedSmokeQuestion(run.uploadedDocument, {
    document_id: run.uploadedDocument.documentId,
    chunk_id: chunk.id,
    question: 'Packaged smoke editable question?',
    choices: [correctAnswer, wrongAnswer],
    answer: correctAnswer,
    answer_key_source: 'manual',
    rationale:
      'Packaged smoke rationale validates direct editable questions and practice.',
    citation_page: chunk.pageNumber,
    source_excerpt: chunk.sourceExcerpt,
    source_order: 1,
    item_kind: 'vocabulary_single',
  });
  run.metrics.ui_timings_ms.question_creation = Date.now() - createStart;
  run.metrics.selected_answer = metricText(correctAnswer);
  run.metrics.wrong_answer = metricText(wrongAnswer);

  await activePage().reload({ waitUntil: 'domcontentloaded' });
  await waitText(/Packaged smoke editable question\?/, 60_000, 'created question visible');
  await screenshot('editable-question-created');

  const questionArticle = activePage()
    .locator('app-draft-review-panel article')
    .filter({ hasText: 'Packaged smoke editable question?' })
    .first();
  const editButton = questionArticle
    .locator('button')
    .filter({ hasText: /^\s*Edit\s*$/ })
    .first();
  await editButton.waitFor({ state: 'visible', timeout: 30_000 });
  await editButton.click({ timeout: 30_000 });
  await waitText(/Select answer|Rationale/, 10_000, 'question edit mode');

  const editingArticle = activePage()
    .locator('app-draft-review-panel article')
    .first();
  const questionInput = editingArticle.locator('input').first();
  await questionInput.waitFor({ state: 'visible', timeout: 30_000 });
  await questionInput.fill('Packaged smoke edited question?');
  await editingArticle.locator('textarea').fill(
    'Edited packaged smoke rationale validates save, practice, and wrong-answer clearing in the packaged app.',
  );
  await screenshot('editable-question-editing');

  const saveStart = Date.now();
  const saveButton = editingArticle
    .locator('button')
    .filter({ hasText: /^\s*Save\s*$/ })
    .first();
  await saveButton.waitFor({ state: 'visible', timeout: 30_000 });
  await saveButton.click({ timeout: 30_000 });
  await waitText(
    /Question saved|Packaged smoke edited question\?/,
    60_000,
    'question saved',
  );
  run.metrics.ui_timings_ms.question_save = Date.now() - saveStart;
  await screenshot('editable-question-saved');
}

async function runFullExamWrongAnswer(): Promise<void> {
  await clickButtonPattern(/^\s*Full Exam\s*$/);
  await waitText(/Start full exam|Full Exam/i, 10_000, 'full exam mode');
  await screenshot('full-exam-ready');
  await clickButtonText('Start full exam');
  await waitText(/Submit answer|Choices/, 30_000, 'full exam question visible');
  await activePage().locator('label[for="practice-choice-1"]').click();
  await clickButtonText('Submit answer');
  await waitText(
    /Last answer: Needs review|Practice set complete/i,
    30_000,
    'wrong answer recorded',
  );
  await screenshot('practice-wrong-answer');

  await clickButtonPattern(/^\s*Review\s*$/);
  await waitText(
    /Wrong Answers|1 recorded|Selected:/i,
    30_000,
    'wrong-answer review populated',
  );
  await screenshot('wrong-answer-panel-populated');
}

async function runRandomQuizCorrectClear(): Promise<void> {
  await clickButtonPattern(/^\s*Random Quiz\s*$/);
  await waitText(/Start random quiz|Random Quiz/i, 10_000, 'random quiz mode');
  await activePage().locator('input[name="sessionQuestionCount"]').fill('100');
  await screenshot('random-quiz-ready');
  await clickButtonText('Start random quiz');
  await waitText(/Submit answer|Choices/, 30_000, 'random quiz question visible');

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const article = activePage().locator('app-practice-panel article').first();
    if ((await article.count()) === 0) {
      break;
    }
    const questionText = await article.locator('h3').first().innerText();
    const answer = await answerForVisiblePracticeQuestion(questionText);
    await article
      .locator('label')
      .filter({ hasText: new RegExp(`^\\s*${escapeRegExp(answer)}\\s*$`) })
      .first()
      .click({ timeout: 30_000 });
    await clickButtonText('Submit answer');
    await waitText(
      /Last answer: Correct|Practice set complete/i,
      30_000,
      'correct answer recorded',
    );
    if (/Practice set complete/i.test(await bodyText())) {
      break;
    }
  }

  await screenshot('random-quiz-correct-answer');

  await clickButtonPattern(/^\s*Review\s*$/);
  await waitText(
    /0 recorded|Wrong answers will appear here/i,
    30_000,
    'wrong-answer review cleared',
  );
  await screenshot('wrong-answer-panel-cleared');
}

async function restartAndVerifyPersistence(): Promise<void> {
  run.metrics.restart = { attempted: true };
  run.metrics.restart.close = await closeAppAndCheckResidue('restart');
  await delay(3_000);

  run.port += 1;
  await launchAppAndConnect();
  await waitText(
    /Projects|Select or create a project|Parallel Parsing QA/i,
    90_000,
    'restart workspace loaded',
  );
  if (!/Source PDF|Mock Exam Items|Parallel Parsing QA/.test(await bodyText())) {
    const projectButton = activePage().locator('button.project-select-button').first();
    if (await projectButton.count()) {
      run.metrics.observations.push(
        'Project was not auto-selected after restart; selected it manually for persistence verification.',
      );
      await projectButton.click();
      await waitText(
        /Source PDF|Mock Exam Items|Parsing complete/i,
        30_000,
        'project selected after restart',
      );
    }
  }
  await screenshot('restart-persistence-build-state');
  run.metrics.restart.verified =
    /Parsing complete|Playable|Mock Exam Items|Source PDF/i.test(await bodyText());
}

async function launchAppAndConnect(): Promise<void> {
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${run.port}`,
    EXAM_PREP_DESKTOP_DATA_DIR: packagedAppDataDir(run.options.appDataDir),
    EXAM_PREP_OCR_PROVIDER: run.options.ocrProvider,
    EXAM_PREP_OCR_PAGE_WORKERS: String(run.options.ocrPageWorkers),
    EXAM_PREP_OLLAMA_MODEL: run.options.ollamaModel,
    ...(run.options.streamingDraftPageLimit
      ? {
          EXAM_PREP_STREAMING_DRAFT_GENERATION_PAGE_LIMIT: String(
            run.options.streamingDraftPageLimit,
          ),
        }
      : {}),
    ...(run.options.streamingDraftWorkers
      ? {
          EXAM_PREP_STREAMING_DRAFT_WORKERS: String(
            run.options.streamingDraftWorkers,
          ),
        }
      : {}),
  };
  const child = spawn(run.options.exePath, [], {
    cwd: run.options.workspaceRoot,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  run.app = child;
  run.appExit = { exited: false, code: null, signal: null };
  child.stdout?.on('data', (chunk) =>
    appendFileSync(join(run.options.outDir, 'app.stdout.log'), chunk),
  );
  child.stderr?.on('data', (chunk) =>
    appendFileSync(join(run.options.outDir, 'app.stderr.log'), chunk),
  );
  child.on('exit', (code, signal) => {
    if (run.appExit) {
      run.appExit.exited = true;
      run.appExit.code = code;
      run.appExit.signal = signal;
    }
    log(`app exited code=${code} signal=${signal}`);
  });
  await waitForCdp(90_000);
  run.browser = await chromium.connectOverCDP(`http://127.0.0.1:${run.port}`);
  const context = run.browser.contexts()[0] ?? (await run.browser.newContext());
  run.page =
    context.pages()[0] ??
    (await context.waitForEvent('page', { timeout: 30_000 }));
  observeStreamingApiResponses(run.page);
  await run.page.setViewportSize({ width: 1440, height: 1000 });
  await run.page
    .waitForLoadState('domcontentloaded', { timeout: 30_000 })
    .catch((error) => {
      run.metrics.observations.push(
        `domcontentloaded wait skipped: ${errorMessage(error)}`,
      );
    });
  await waitText(
    /Exam Prep|Local workspace|Install the Python backend runtime|Projects/,
    60_000,
    'app shell loaded',
  );
}

async function runFlow(): Promise<void> {
  if (!existsSync(run.options.exePath)) {
    throw new Error(`Missing packaged exe: ${run.options.exePath}`);
  }
  if (!existsSync(run.options.pdfPath)) {
    throw new Error(`Missing QA PDF: ${run.options.pdfPath}`);
  }

  log(`artifact dir ${run.options.outDir}`);
  run.processBaseline = processSnapshot();
  run.resourceSampling = startResourceSampling({
    skipGpuSampling: run.options.skipGpuSampling,
    outDir: run.options.outDir,
    workspaceRoot: run.options.workspaceRoot,
    observe: (message) => run.metrics.observations.push(message),
  });
  if (Object.keys(run.resourceSampling.artifacts).length > 0) {
    run.metrics.resource_sampling = run.resourceSampling.artifacts;
    run.metrics.gpu_sampling = run.resourceSampling.artifacts.nvidia_smi_csv;
  }
  preparePackagedBackendRuntimeForSmoke({
    workspaceRoot: run.options.workspaceRoot,
    outDir: run.options.outDir,
    appDataDir: run.options.appDataDir,
    metrics: run.metrics,
  });
  await launchAppAndConnect();
  await installPythonRuntimeIfNeeded();
  await installOcrRuntimeIfNeeded();
  await createProject();
  await uploadAndParsePdf();
  if (run.options.waitForStreamingComplete) {
    run.metrics.status = 'completed';
    log('streaming baseline completed');
    return;
  }
  await createAndEditQuestion();
  await runFullExamWrongAnswer();
  await runRandomQuizCorrectClear();
  await restartAndVerifyPersistence();
  run.metrics.status = 'completed';
  log('flow completed');
}

async function cleanupAfterRun(): Promise<void> {
  const cleanupResidue: PublicProcessRecord[] = [];
  if (run.app) {
    const close = await closeAppAndCheckResidue('final cleanup').catch((error) => {
      run.metrics.errors.push(`final close failed: ${errorMessage(error)}`);
      return null;
    });
    if (close) {
      run.metrics.final_close = close;
      cleanupResidue.push(...close.residue);
    }
  }

  if (run.resourceSampling) {
    await run.resourceSampling.stop().catch((error) => {
      run.metrics.errors.push(
        `resource sampler cleanup failed: ${errorMessage(error)}`,
      );
    });
  }
  run.resourceSampling = null;
  run.nvidia = null;

  const nodeHelpers = await closeNewNodeHelpers().catch((error) => {
    run.metrics.errors.push(`node helper cleanup failed: ${errorMessage(error)}`);
    return [];
  });
  run.metrics.process_cleanup = {
    node_cleanup_summary: {
      baseline_node_count: run.processBaseline.nodePids.size,
      closed_count: nodeHelpers.length,
      closed: nodeHelpers,
    },
    new_node_helpers_closed: nodeHelpers,
    residue_after_close: cleanupResidue,
  };
}

async function cleanupAfterRunWithTimeout(): Promise<void> {
  const timeoutMs = 90_000;
  await Promise.race([
    cleanupAfterRun(),
    delay(timeoutMs).then(() => {
      throw new Error(`closeout cleanup timed out after ${timeoutMs}ms`);
    }),
  ]);
}

function writeCloseoutArtifacts(
  label: string,
  { recordBaselineFailure }: { readonly recordBaselineFailure: boolean },
): void {
  try {
    run.metrics.observations.push(`closeout checkpoint: ${label}`);
    writeStreamingBaselineArtifacts({ recordFailure: recordBaselineFailure });
    saveMetrics();
  } catch (error) {
    run.metrics.errors.push(
      `${label} artifact write failed: ${errorMessage(error)}`,
    );
  }
}

function logFinalMetricsSummary(): void {
  console.log(
    JSON.stringify(
      {
        status: run.metrics.status,
        error_count: run.metrics.errors.length,
        out_dir: normalizePath(relative(run.options.workspaceRoot, run.options.outDir)),
        metrics_json: normalizePath(
          relative(run.options.workspaceRoot, join(run.options.outDir, 'metrics.json')),
        ),
        streaming_baseline: run.metrics.streaming_baseline ?? null,
      },
      null,
      2,
    ),
  );
}

async function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.killed) {
    return true;
  }
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function ignoreCleanupError(error: unknown): void {
  void error;
}

export async function runPackagedFlowSmokeCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const parsedOptions = parsePackagedFlowSmokeArgs(argv);
  const initialMetrics: SmokeMetrics = {
    status: 'running',
    started_at: new Date().toISOString(),
    out_dir: parsedOptions.outDir,
    screenshots: [],
    ui_timings_ms: {},
    observations: [],
    errors: [],
    llm_model: parsedOptions.ollamaModel,
    ocr_provider: parsedOptions.ocrProvider,
    first_chunk_gate_ms: FIRST_CHUNK_GATE_MS,
    first_chunk_under_gate: false,
    streaming_draft_page_limit: parsedOptions.streamingDraftPageLimit,
    streaming_draft_workers: parsedOptions.streamingDraftWorkers,
    wait_for_streaming_complete: parsedOptions.waitForStreamingComplete,
    app_data_dir: parsedOptions.appDataDir
      ? normalizePath(relative(parsedOptions.workspaceRoot, parsedOptions.appDataDir))
      : undefined,
    streaming_questions: {
      job_snapshots: [],
      question_snapshots: [],
      status_counts: {},
    },
  };
  run = {
    options: parsedOptions,
    metrics: initialMetrics,
    app: null,
    appExit: null,
    nvidia: null,
    resourceSampling: null,
    browser: null,
    page: null,
    port: parsedOptions.cdpPort,
    processBaseline: { all: [], nodePids: new Set() },
    uploadedDocument: null,
    streamingDraftParseStartedAt: null,
    streamingDraftCaptureOpen: false,
    streamingApiPollErrorCaptured: false,
  };
  mkdirSync(run.options.outDir, { recursive: true });

  try {
    await runFlow();
  } catch (error) {
    run.metrics.status = 'failed';
    run.metrics.errors.push(error instanceof Error && error.stack ? error.stack : errorMessage(error));
    log(`FAILED ${error instanceof Error && error.stack ? error.stack : errorMessage(error)}`);
    if (run.page) {
      await screenshot('failure-state').catch((screenshotError) => {
        run.metrics.observations.push(
          `failure screenshot skipped: ${errorMessage(screenshotError)}`,
        );
      });
    }
  } finally {
    writeCloseoutArtifacts('pre-cleanup', { recordBaselineFailure: false });
    await cleanupAfterRunWithTimeout().catch((error) => {
      run.metrics.errors.push(`cleanup failed: ${errorMessage(error)}`);
    });
    writeCloseoutArtifacts('final', { recordBaselineFailure: true });
    logFinalMetricsSummary();
  }

  process.exitCode = run.metrics.status === 'completed' && run.metrics.errors.length === 0 ? 0 : 1;
}
