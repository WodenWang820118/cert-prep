import { spawn, type ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
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
import {
  classifyStreamingDraftStatus,
  mergeStatusCounts,
  sanitizeDraftJobSnapshot,
  sanitizeQuestionDraftSnapshot,
} from './streaming-evidence.mts';
import { errorMessage, normalizePath } from './text-utils.mts';
import type {
  CloseSummary,
  PublicProcessRecord,
  SmokeMetrics,
  SmokeRunState,
  UploadedDocumentRef,
} from './types.mts';

const STREAMING_DRAFT_STATUS_PATTERN =
  /Drafting \d+\/\d+|[1-9]\d* drafts ready|Model missing|Reasoning unavailable|Drafting needs attention/i;

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
    recordStreamingQuestionDraftSnapshot(payload, elapsedMs);
  }
}

function recordStreamingDraftJobSnapshot(payload: unknown, elapsedMs: number): void {
  const snapshot = sanitizeDraftJobSnapshot(payload, elapsedMs);
  run.metrics.streaming_drafts.job_snapshots.push(snapshot);
  mergeStatusCounts(run.metrics.streaming_drafts.status_counts, snapshot.status_counts);
  if (
    run.metrics.streaming_drafts.first_job_visible_ms === undefined &&
    snapshot.item_count > 0
  ) {
    run.metrics.streaming_drafts.first_job_visible_ms = snapshot.elapsed_ms;
  }
  if (
    run.metrics.streaming_drafts.first_status_visible_ms === undefined &&
    Object.keys(snapshot.status_counts).length > 0
  ) {
    run.metrics.streaming_drafts.first_status_visible_ms = snapshot.elapsed_ms;
  }
  if (snapshot.blocker && !run.metrics.streaming_drafts.blocker) {
    run.metrics.streaming_drafts.blocker = snapshot.blocker;
  }
}

function recordStreamingQuestionDraftSnapshot(payload: unknown, elapsedMs: number): void {
  const snapshot = sanitizeQuestionDraftSnapshot(payload, elapsedMs);
  run.metrics.streaming_drafts.draft_snapshots.push(snapshot);
  if (
    run.metrics.streaming_drafts.first_draft_visible_ms === undefined &&
    snapshot.item_count > 0
  ) {
    run.metrics.streaming_drafts.first_draft_visible_ms = snapshot.elapsed_ms;
  }
  if (
    run.metrics.streaming_drafts.first_usable_question_visible_ms === undefined &&
    snapshot.usable_count > 0
  ) {
    run.metrics.streaming_drafts.first_usable_question_visible_ms =
      snapshot.elapsed_ms;
  }
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
    recordStreamingQuestionDraftSnapshot(drafts, elapsedMs);
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
    run.metrics.ui_timings_ms.streaming_draft_status_visible !== undefined;
  let usableCaptured =
    run.metrics.ui_timings_ms.streaming_first_usable_question_visible !== undefined;

  while (!completed && (!statusCaptured || !usableCaptured)) {
    if (uploadedDocument) {
      await pollStreamingDraftApis(uploadedDocument, Date.now() - parseStart);
    }
    const text = await bodyText();
    if (!statusCaptured && STREAMING_DRAFT_STATUS_PATTERN.test(text)) {
      const elapsedMs = Date.now() - parseStart;
      const streamingStatus = classifyStreamingDraftStatus(text);
      run.metrics.ui_timings_ms.streaming_draft_status_visible = elapsedMs;
      run.metrics.observations.push(`Streaming draft status: ${streamingStatus}.`);
      if (streamingStatus === 'ready') {
        run.metrics.ui_timings_ms.streaming_first_draft_ready_visible = elapsedMs;
      } else if (streamingStatus === 'blocked') {
        run.metrics.ui_timings_ms.streaming_draft_blocker_visible = elapsedMs;
      }
      await screenshot('streaming-draft-status-visible');
      statusCaptured = true;
    }

    if (!usableCaptured && (await firstUsableDraftArticleVisible())) {
      const elapsedMs = Date.now() - parseStart;
      run.metrics.ui_timings_ms.streaming_first_usable_question_visible = elapsedMs;
      run.metrics.streaming_drafts.first_usable_question_visible_ms ??= elapsedMs;
      await screenshot('streaming-first-usable-draft-visible');
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

  if (run.metrics.ui_timings_ms.streaming_draft_status_visible === undefined) {
    run.metrics.observations.push(
      'Streaming draft status was not visible before parse completion.',
    );
  }
}

async function firstUsableDraftArticleVisible(): Promise<boolean> {
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
  run.metrics.finished_at = new Date().toISOString();
  writeFileSync(
    join(run.options.outDir, 'metrics.json'),
    `${JSON.stringify(run.metrics, null, 2)}\n`,
  );
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

async function domClickButtonPattern(
  pattern: RegExp,
  buttonOptions: { timeout?: number } = {},
): Promise<void> {
  const timeout = buttonOptions.timeout ?? 20_000;
  const locator = activePage()
    .locator('button')
    .filter({ hasText: pattern })
    .first();
  await locator.waitFor({ state: 'visible', timeout });
  await locator.evaluate((button) => {
    if (button instanceof HTMLElement) {
      button.click();
      return;
    }
    button.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  });
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

  let text = await bodyText();
  if (/Unknown|status unavailable|OCR unknown|PaddleOCR status unavailable/i.test(text)) {
    run.metrics.observations.push(
      'Runtime drawer showed OCR unknown after Python install; manual refresh was required.',
    );
    await refreshRuntimeDrawer();
    text = await bodyText();
  }

  if (/PaddleOCR imports available|gpu:0|PaddleOCR runtime is ready/i.test(text)) {
    run.metrics.observations.push(
      'PaddleOCR runtime was already ready after runtime refresh.',
    );
    await screenshot('runtime-ocr-ready-after-refresh');
    return;
  }

  if (!/Install OCR|PaddleOCR runtime is not installed|paddle_runtime_missing/i.test(text)) {
    run.metrics.observations.push(
      'Waiting longer for OCR health to settle before treating the drawer as failed.',
    );
    await waitText(
      /PaddleOCR imports available|gpu:0|paddle\s*\/\s*(gpu|cpu)|OCR ready|Install OCR|PaddleOCR runtime is not installed|paddle_runtime_missing/i,
      180_000,
      'ocr health settled',
    );
    text = await bodyText();
  }

  if (/PaddleOCR imports available|gpu:0|paddle\s*\/\s*(gpu|cpu)|OCR ready/i.test(text)) {
    run.metrics.observations.push(
      'PaddleOCR runtime became ready after delayed health settling.',
    );
    await screenshot('runtime-ocr-ready-after-delayed-health');
    return;
  }

  if (!/Install OCR|PaddleOCR runtime is not installed|paddle_runtime_missing/i.test(text)) {
    throw new Error(
      `OCR install action did not appear. Runtime drawer text: ${text.slice(0, 1400)}`,
    );
  }

  const start = Date.now();
  await clickButtonPattern(/^\s*Install OCR\s*$/);
  await waitText(/Install the PaddleOCR runtime/, 10_000, 'ocr install consent');
  await screenshot('ocr-install-consent');
  await clickConsentInstall();
  await waitText(
    /PaddleOCR imports available|gpu:0|paddle\s*\/\s*gpu|OCR ready/i,
    240_000,
    'ocr runtime ready',
  );
  run.metrics.ui_timings_ms.paddleocr_runtime_install = Date.now() - start;
  await screenshot('runtime-checklist-ready');
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
  const uploadedDocument = await uploadDocumentResponse;
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

  const parseStart = Date.now();
  run.streamingDraftParseStartedAt = parseStart;
  run.streamingDraftCaptureOpen = true;
  try {
    await delay(15_000);
    const midText = await bodyText();
    if (/Extracted text|Page \d+|\b[1-9]\d* chunks\b/.test(midText)) {
      run.metrics.ui_timings_ms.first_chunk_visible = Date.now() - parseStart;
    } else {
      run.metrics.observations.push(
        'No extracted chunk was visible 15s after parsing started.',
      );
    }
    await screenshot('mid-parse-ui-still-usable');

    const firstChunkStart = Date.now();
    try {
      await waitText(
        /Extracted text|Page \d+|\b[1-9]\d* chunks\b/,
        260_000,
        'first extracted chunk visible',
      );
      if (run.metrics.ui_timings_ms.first_chunk_visible === undefined) {
        run.metrics.ui_timings_ms.first_chunk_visible = Date.now() - parseStart;
      }
    } catch (error) {
      run.metrics.errors.push(`first chunk wait failed: ${errorMessage(error)}`);
    }
    run.metrics.ui_timings_ms.first_chunk_wait_window =
      Date.now() - firstChunkStart;

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
  } finally {
    run.streamingDraftCaptureOpen = false;
  }
  await screenshot('parsing-complete-with-metrics');
}

async function generateAndApproveDraft(): Promise<void> {
  await activePage().locator('input[name="draftLimit"]').fill('1');
  const start = Date.now();
  await clickButtonText('Generate deterministic drafts');
  await waitText(
    /Ready to approve|missing answer|missing rationale|\b1 items\b/i,
    60_000,
    'deterministic draft generated',
  );
  run.metrics.ui_timings_ms.deterministic_draft_generation = Date.now() - start;
  await screenshot('deterministic-draft-generated');

  await domClickButtonPattern(/^\s*Edit\s*$/);
  await waitText(/Select answer|Rationale/, 10_000, 'draft edit mode');
  const firstArticle = activePage()
    .locator('app-draft-review-panel article')
    .first();
  const answerSelect = firstArticle.locator('select').first();
  const choiceValues = await answerSelect
    .locator('option')
    .evaluateAll((choices) =>
      choices
        .map((choice) =>
          choice instanceof HTMLOptionElement ? choice.value : '',
        )
        .filter((value) => value && value.trim().length > 0),
    );
  if (choiceValues.length < 2) {
    throw new Error(
      `Expected at least two choices in generated draft, got ${choiceValues.length}`,
    );
  }
  run.metrics.approved_answer = metricText(choiceValues[0]);
  run.metrics.wrong_answer = metricText(choiceValues[1]);
  await answerSelect.selectOption(choiceValues[0]);
  await firstArticle
    .locator('textarea')
    .fill(
      'Manual QA rationale: this controlled answer validates approval, practice, and wrong-answer clearing in the packaged app.',
    );
  await waitText(/Ready to approve/, 10_000, 'draft ready to approve after manual edit');
  await screenshot('draft-edit-ready-to-approve');

  const approveStart = Date.now();
  await domClickButtonPattern(/^\s*Save & approve\s*$/);
  await waitText(/Draft approved|Approved|1 approved/i, 60_000, 'draft approved');
  run.metrics.ui_timings_ms.save_and_approve = Date.now() - approveStart;
  await screenshot('approved-draft');
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
  await activePage().locator('input[name="sessionQuestionCount"]').fill('1');
  await screenshot('random-quiz-ready');
  await clickButtonText('Start random quiz');
  await waitText(/Submit answer|Choices/, 30_000, 'random quiz question visible');
  await activePage().locator('label[for="practice-choice-0"]').click();
  await clickButtonText('Submit answer');
  await waitText(
    /Last answer: Correct|Practice set complete/i,
    30_000,
    'correct answer recorded',
  );
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
    /Parsing complete|approved|Mock Exam Items|Source PDF/i.test(await bodyText());
}

function startNvidiaSampling(): void {
  if (run.options.skipGpuSampling) {
    return;
  }
  const csvPath = join(run.options.outDir, 'nvidia-smi.csv');
  try {
    run.nvidia = spawn(
      'nvidia-smi',
      [
        '--query-gpu=timestamp,utilization.gpu,memory.used,memory.total,power.draw',
        '--format=csv',
        '-l',
        '1',
      ],
      { cwd: run.options.workspaceRoot, windowsHide: true },
    );
    run.nvidia.stdout?.pipe(createWriteStream(csvPath));
    run.nvidia.stderr?.on('data', (chunk) =>
      appendFileSync(join(run.options.outDir, 'nvidia-smi.stderr.log'), chunk),
    );
    run.nvidia.on('error', (error) => {
      run.metrics.observations.push(`nvidia-smi unavailable: ${error.message}`);
    });
    run.metrics.gpu_sampling = normalizePath(relative(run.options.workspaceRoot, csvPath));
  } catch (error) {
    run.metrics.observations.push(`nvidia-smi unavailable: ${errorMessage(error)}`);
  }
}

async function launchAppAndConnect(): Promise<void> {
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${run.port}`,
    EXAM_PREP_DESKTOP_DATA_DIR: packagedAppDataDir(),
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
  startNvidiaSampling();
  preparePackagedBackendRuntimeForSmoke({
    workspaceRoot: run.options.workspaceRoot,
    outDir: run.options.outDir,
    metrics: run.metrics,
  });
  await launchAppAndConnect();
  await installPythonRuntimeIfNeeded();
  await installOcrRuntimeIfNeeded();
  await createProject();
  await uploadAndParsePdf();
  await generateAndApproveDraft();
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

  if (run.nvidia && !run.nvidia.killed) {
    run.nvidia.kill();
  }
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
    streaming_draft_page_limit: parsedOptions.streamingDraftPageLimit,
    streaming_draft_workers: parsedOptions.streamingDraftWorkers,
    streaming_drafts: {
      job_snapshots: [],
      draft_snapshots: [],
      status_counts: {},
    },
  };
  run = {
    options: parsedOptions,
    metrics: initialMetrics,
    app: null,
    appExit: null,
    nvidia: null,
    browser: null,
    page: null,
    port: parsedOptions.cdpPort,
    processBaseline: { all: [], nodePids: new Set() },
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
    await cleanupAfterRun();
    saveMetrics();
    console.log(JSON.stringify(run.metrics, null, 2));
  }

  process.exitCode = run.metrics.status === 'completed' && run.metrics.errors.length === 0 ? 0 : 1;
}
