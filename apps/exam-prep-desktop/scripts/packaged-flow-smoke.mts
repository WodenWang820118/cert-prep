import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium, type Browser, type Page, type Response } from 'playwright';

const DEFAULT_TARGET_TRIPLE = 'x86_64-pc-windows-msvc';
const DEFAULT_OUT_ROOT = 'tmp/exam-prep-desktop/packaged-flow-smoke';
const DEFAULT_PDF_PATH = 'pdfs/\u30101\u30112025\u5e7407\u6708N1 \u771f\u9898.pdf';
const DEFAULT_CDP_PORT = 9491;
const DEFAULT_OCR_PAGE_WORKERS = 1;
const CAPTURE_LIMIT = 12_000;
const PROCESS_SNAPSHOT_MAX_BUFFER = 64 * 1024 * 1024;
const EXAM_PREP_PROCESS_NAMES = new Set([
  'exam-prep-desktop.exe',
  'exam-prep-backend.exe',
  'exam-prep-ocr-runtime.exe',
]);
const PROTECTED_NODE_COMMAND_FRAGMENTS = [
  'nx-mcp',
  'vscode',
  'visual studio code',
  'extensionhost',
  'code.exe',
  'servicehub',
];
const STREAMING_DRAFT_STATUS_PATTERN =
  /Drafting \d+\/\d+|\d+ drafts ready|Model missing|Reasoning unavailable|Drafting needs attention/i;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = resolve(scriptDir, '../../..');

interface SmokeOptions {
  workspaceRoot: string;
  exePath: string;
  pdfPath: string;
  outDir: string;
  cdpPort: number;
  ocrPageWorkers: number;
  skipGpuSampling: boolean;
}

interface SmokeMetrics {
  status: 'running' | 'completed' | 'failed';
  started_at: string;
  finished_at?: string;
  out_dir: string;
  screenshots: string[];
  ui_timings_ms: Record<string, number>;
  observations: string[];
  errors: string[];
  project_name?: string;
  approved_answer?: string;
  wrong_answer?: string;
  restart?: {
    attempted: boolean;
    verified?: boolean;
    close?: CloseSummary;
  };
  final_close?: CloseSummary;
  process_cleanup?: {
    node_cleanup_summary: {
      baseline_node_count: number;
      closed_count: number;
      closed: PublicProcessRecord[];
    };
    new_node_helpers_closed: PublicProcessRecord[];
    residue_after_close: PublicProcessRecord[];
  };
  streaming_drafts: StreamingDraftsMetrics;
  gpu_sampling?: string;
}

interface StreamingDraftsMetrics {
  job_snapshots: StreamingDraftJobSnapshot[];
  draft_snapshots: StreamingQuestionDraftSnapshot[];
  status_counts: Record<string, number>;
  first_job_visible_ms?: number;
  first_status_visible_ms?: number;
  first_draft_visible_ms?: number;
  first_usable_question_visible_ms?: number;
  blocker?: string;
}

interface StreamingDraftJobSnapshot {
  elapsed_ms: number;
  source: 'draft-jobs';
  item_count: number;
  status_counts: Record<string, number>;
  generated_count: number;
  blocker?: string;
}

interface StreamingQuestionDraftSnapshot {
  elapsed_ms: number;
  source: 'question-drafts';
  item_count: number;
  usable_count: number;
}

interface ProcessRecord {
  pid: number;
  parentPid: number;
  name: string;
  executablePath: string;
  commandLine: string;
}

interface PublicProcessRecord {
  pid: number;
  parentPid: number;
  name: string;
  commandLine: string;
}

interface ProcessSnapshot {
  all: ProcessRecord[];
  nodePids: Set<number>;
}

interface CloseSummary {
  label: string;
  app_pid: number | null;
  normal_close_requested: boolean;
  exited_after_normal_close: boolean;
  forced: boolean;
  residue: PublicProcessRecord[];
  gracefulExited: boolean;
  fallbackUsed: boolean;
  exitCode: number | null;
  residualProcesses: PublicProcessRecord[];
}

interface ChildExitState {
  exited: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface SelectNodeHelpersOptions {
  beforeNodePids: ReadonlySet<number>;
  after: readonly ProcessRecord[];
  ownerPid: number;
  workspaceRoot: string;
  runMarker: string;
}

type JsonProcessRow = {
  ProcessId?: unknown;
  ParentProcessId?: unknown;
  Name?: unknown;
  ExecutablePath?: unknown;
  CommandLine?: unknown;
};

let options: SmokeOptions;
let metrics: SmokeMetrics;
let app: ChildProcess | null = null;
let appExit: ChildExitState | null = null;
let nvidia: ChildProcess | null = null;
let browser: Browser | null = null;
let page: Page | null = null;
let port = DEFAULT_CDP_PORT;
let processBaseline: ProcessSnapshot = { all: [], nodePids: new Set() };
let streamingDraftParseStartedAt: number | null = null;
let streamingDraftCaptureOpen = false;

export function parsePackagedFlowSmokeArgs(
  args: readonly string[],
  workspaceRoot = defaultWorkspaceRoot,
): SmokeOptions {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const parsed: SmokeOptions = {
    workspaceRoot,
    exePath: resolve(
      workspaceRoot,
      'apps/exam-prep-desktop/src-tauri/target',
      DEFAULT_TARGET_TRIPLE,
      'release/exam-prep-desktop.exe',
    ),
    pdfPath: resolve(workspaceRoot, DEFAULT_PDF_PATH),
    outDir: resolve(workspaceRoot, DEFAULT_OUT_ROOT, timestamp),
    cdpPort: DEFAULT_CDP_PORT,
    ocrPageWorkers: Number(
      process.env.EXAM_PREP_PACKAGE_SMOKE_OCR_PAGE_WORKERS ??
        DEFAULT_OCR_PAGE_WORKERS,
    ),
    skipGpuSampling: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const readValue = (name: string): string => {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`${name} requires a value.`);
      }
      index += 1;
      return value;
    };

    if (arg === '--exe') {
      parsed.exePath = resolve(workspaceRoot, readValue(arg));
    } else if (arg === '--pdf') {
      parsed.pdfPath = resolve(workspaceRoot, readValue(arg));
    } else if (arg === '--out-dir') {
      parsed.outDir = resolve(workspaceRoot, readValue(arg));
    } else if (arg === '--cdp-port') {
      parsed.cdpPort = positiveInteger(Number(readValue(arg)), arg);
    } else if (arg === '--ocr-page-workers') {
      parsed.ocrPageWorkers = positiveInteger(Number(readValue(arg)), arg);
    } else if (arg === '--skip-gpu-sampling') {
      parsed.skipGpuSampling = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  parsed.ocrPageWorkers = positiveInteger(
    parsed.ocrPageWorkers,
    'ocrPageWorkers',
  );
  return parsed;
}

export function parseProcessSnapshotJson(stdout: string): ProcessRecord[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }
  const payload = JSON.parse(trimmed) as JsonProcessRow | JsonProcessRow[];
  const rows = Array.isArray(payload) ? payload : [payload];
  return rows
    .map((row) => ({
      pid: numberField(row.ProcessId),
      parentPid: numberField(row.ParentProcessId),
      name: stringField(row.Name),
      executablePath: stringField(row.ExecutablePath),
      commandLine: stringField(row.CommandLine),
    }))
    .filter((record) => record.pid > 0);
}

export function snapshotWindowsProcesses(): ProcessRecord[] {
  if (process.platform !== 'win32') {
    return [];
  }

  const result = spawnSync(
    resolveWindowsPowerShellExecutable(),
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: PROCESS_SNAPSHOT_MAX_BUFFER,
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Process snapshot failed: ${trimCapture(result.stderr || result.stdout)}`,
    );
  }
  return parseProcessSnapshotJson(result.stdout);
}

export function processSnapshot(): ProcessSnapshot {
  const all = snapshotWindowsProcesses();
  return {
    all,
    nodePids: new Set(
      all
        .filter((record) => record.name.toLowerCase() === 'node.exe')
        .map((record) => record.pid),
    ),
  };
}

export function resolveWindowsPowerShellExecutable(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
): string {
  const configured = env.EXAM_PREP_POWERSHELL_EXE?.trim();
  if (configured) {
    return configured;
  }

  const windowsRoot = env.SystemRoot?.trim() || env.WINDIR?.trim();
  if (windowsRoot) {
    const candidate = join(
      windowsRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    if (fileExists(candidate)) {
      return candidate;
    }
  }

  return 'powershell.exe';
}

export function collectProcessTree(
  processes: readonly ProcessRecord[],
  rootPid: number,
): ProcessRecord[] {
  const byParent = new Map<number, ProcessRecord[]>();
  for (const record of processes) {
    const children = byParent.get(record.parentPid) ?? [];
    children.push(record);
    byParent.set(record.parentPid, children);
  }

  const byPid = new Map(processes.map((record) => [record.pid, record]));
  const tree: ProcessRecord[] = [];
  const seen = new Set<number>();
  const queue = [rootPid];

  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined || seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    const record = byPid.get(pid);
    if (record) {
      tree.push(record);
    }
    for (const child of byParent.get(pid) ?? []) {
      queue.push(child.pid);
    }
  }

  return tree;
}

export function isExamPrepResidue(record: ProcessRecord): boolean {
  const name = record.name.toLowerCase();
  const commandLine = record.commandLine.toLowerCase();
  return (
    EXAM_PREP_PROCESS_NAMES.has(name) ||
    commandLine.includes('--ocr-worker') ||
    commandLine.includes('exam-prep-ocr-runtime')
  );
}

export function selectExamPrepResidue(
  processes: readonly ProcessRecord[],
  appPid: number,
): ProcessRecord[] {
  return collectProcessTree(processes, appPid).filter(isExamPrepResidue);
}

export function selectNewWorkspaceNodeHelpers({
  beforeNodePids,
  after,
  ownerPid,
  workspaceRoot,
  runMarker,
}: SelectNodeHelpersOptions): ProcessRecord[] {
  const ownerTreePids = new Set(
    collectProcessTree(after, ownerPid).map((record) => record.pid),
  );
  const workspaceNeedle = normalizeForCommandLine(workspaceRoot);
  const markerNeedle = normalizeForCommandLine(runMarker);

  return after.filter((record) => {
    if (record.name.toLowerCase() !== 'node.exe') {
      return false;
    }
    if (record.pid === ownerPid || beforeNodePids.has(record.pid)) {
      return false;
    }
    if (isProtectedNodeProcess(record)) {
      return false;
    }
    const commandLine = normalizeForCommandLine(record.commandLine);
    const isOwnedDescendant = ownerTreePids.has(record.pid);
    const isWorkspaceCommand = commandLine.includes(workspaceNeedle);
    const isRunMarked =
      commandLine.includes(markerNeedle) ||
      commandLine.includes('packaged-flow-smoke.mts');
    return isRunMarked || (isOwnedDescendant && isWorkspaceCommand);
  });
}

export function classifyStreamingDraftStatus(
  text: string,
): 'active' | 'ready' | 'blocked' | 'none' {
  if (/\d+ drafts ready/i.test(text)) {
    return 'ready';
  }
  if (/Model missing|Reasoning unavailable|Drafting needs attention/i.test(text)) {
    return 'blocked';
  }
  if (/Drafting \d+\/\d+/i.test(text)) {
    return 'active';
  }
  return 'none';
}

export function draftJobStatusCounts(payload: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of responseItems(payload)) {
    const status = isRecord(item) ? stringField(item.status).trim() : '';
    if (status) {
      counts[status] = (counts[status] ?? 0) + 1;
    }
  }
  return counts;
}

export function sanitizeDraftJobSnapshot(
  payload: unknown,
  elapsedMs: number,
): StreamingDraftJobSnapshot {
  const items = responseItems(payload);
  const statusCounts = draftJobStatusCounts(payload);
  const generatedCount = items.reduce<number>((total, item) => {
    if (!isRecord(item)) {
      return total;
    }
    return total + numberField(item.generated_count);
  }, 0);
  const blocker = streamingDraftBlockerFromStatusCounts(statusCounts);
  return {
    elapsed_ms: normalizedElapsedMs(elapsedMs),
    source: 'draft-jobs',
    item_count: items.length,
    status_counts: statusCounts,
    generated_count: generatedCount,
    ...(blocker ? { blocker } : {}),
  };
}

export function sanitizeQuestionDraftSnapshot(
  payload: unknown,
  elapsedMs: number,
): StreamingQuestionDraftSnapshot {
  const items = responseItems(payload);
  return {
    elapsed_ms: normalizedElapsedMs(elapsedMs),
    source: 'question-drafts',
    item_count: items.length,
    usable_count: items.filter(isUsableQuestionDraftPayload).length,
  };
}

export function closeMainWindowPowerShellCommand(pid: number): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    'if ($null -eq $process) { exit 0 }',
    'if ($process.CloseMainWindow()) { exit 0 }',
    'exit 2',
  ].join('; ');
}

function requestWindowsCloseByPid(pid: number): boolean {
  if (process.platform !== 'win32') {
    return false;
  }

  const result = spawnSync(
    resolveWindowsPowerShellExecutable(),
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      closeMainWindowPowerShellCommand(pid),
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  return !result.error && result.status === 0;
}

function terminateProcessTreeByPid(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process already exited.
    }
  }
}

async function closeAppAndCheckResidue(label: string): Promise<CloseSummary> {
  const currentApp = app;
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
  const exitCode = appExit?.code ?? currentApp.exitCode ?? null;
  let forced = false;

  if (!exitedAfterNormalClose) {
    forced = true;
    metrics.observations.push(
      `${label} app process ${pid} did not exit after normal close; terminating its process tree.`,
    );
    terminateProcessTreeByPid(pid);
    await waitForChildExit(currentApp, 8_000);
  }

  await browser?.close().catch(ignoreCleanupError);
  browser = null;
  page = null;
  app = null;
  appExit = null;

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
    beforeNodePids: processBaseline.nodePids,
    after: snapshotWindowsProcesses(),
    ownerPid: process.pid,
    workspaceRoot: options.workspaceRoot,
    runMarker: options.outDir,
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
  if (!streamingDraftCaptureOpen || streamingDraftParseStartedAt === null) {
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
  const elapsedMs = Date.now() - streamingDraftParseStartedAt;
  if (capturesDraftJobs) {
    recordStreamingDraftJobSnapshot(payload, elapsedMs);
  } else {
    recordStreamingQuestionDraftSnapshot(payload, elapsedMs);
  }
}

function recordStreamingDraftJobSnapshot(payload: unknown, elapsedMs: number): void {
  const snapshot = sanitizeDraftJobSnapshot(payload, elapsedMs);
  metrics.streaming_drafts.job_snapshots.push(snapshot);
  mergeStatusCounts(metrics.streaming_drafts.status_counts, snapshot.status_counts);
  if (
    metrics.streaming_drafts.first_job_visible_ms === undefined &&
    snapshot.item_count > 0
  ) {
    metrics.streaming_drafts.first_job_visible_ms = snapshot.elapsed_ms;
  }
  if (
    metrics.streaming_drafts.first_status_visible_ms === undefined &&
    Object.keys(snapshot.status_counts).length > 0
  ) {
    metrics.streaming_drafts.first_status_visible_ms = snapshot.elapsed_ms;
  }
  if (snapshot.blocker && !metrics.streaming_drafts.blocker) {
    metrics.streaming_drafts.blocker = snapshot.blocker;
  }
}

function recordStreamingQuestionDraftSnapshot(payload: unknown, elapsedMs: number): void {
  const snapshot = sanitizeQuestionDraftSnapshot(payload, elapsedMs);
  metrics.streaming_drafts.draft_snapshots.push(snapshot);
  if (
    metrics.streaming_drafts.first_draft_visible_ms === undefined &&
    snapshot.item_count > 0
  ) {
    metrics.streaming_drafts.first_draft_visible_ms = snapshot.elapsed_ms;
  }
  if (
    metrics.streaming_drafts.first_usable_question_visible_ms === undefined &&
    snapshot.usable_count > 0
  ) {
    metrics.streaming_drafts.first_usable_question_visible_ms =
      snapshot.elapsed_ms;
  }
}

async function observeStreamingDraftUiUntil(
  parseStart: number,
  completion: Promise<void>,
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
    metrics.ui_timings_ms.streaming_draft_status_visible !== undefined;
  let usableCaptured =
    metrics.ui_timings_ms.streaming_first_usable_question_visible !== undefined;

  while (!completed && (!statusCaptured || !usableCaptured)) {
    const text = await bodyText();
    if (!statusCaptured && STREAMING_DRAFT_STATUS_PATTERN.test(text)) {
      const elapsedMs = Date.now() - parseStart;
      const streamingStatus = classifyStreamingDraftStatus(text);
      metrics.ui_timings_ms.streaming_draft_status_visible = elapsedMs;
      metrics.observations.push(`Streaming draft status: ${streamingStatus}.`);
      if (streamingStatus === 'ready') {
        metrics.ui_timings_ms.streaming_first_draft_ready_visible = elapsedMs;
      } else if (streamingStatus === 'blocked') {
        metrics.ui_timings_ms.streaming_draft_blocker_visible = elapsedMs;
      }
      await screenshot('streaming-draft-status-visible');
      statusCaptured = true;
    }

    if (!usableCaptured && (await firstUsableDraftArticleVisible())) {
      const elapsedMs = Date.now() - parseStart;
      metrics.ui_timings_ms.streaming_first_usable_question_visible = elapsedMs;
      metrics.streaming_drafts.first_usable_question_visible_ms ??= elapsedMs;
      await screenshot('streaming-first-usable-draft-visible');
      usableCaptured = true;
    }

    await Promise.race([
      delay(1_000),
      completion.catch(() => undefined),
    ]);
  }

  if (metrics.ui_timings_ms.streaming_draft_status_visible === undefined) {
    metrics.observations.push(
      'Streaming draft status was not visible before parse completion.',
    );
  }
}

async function firstUsableDraftArticleVisible(): Promise<boolean> {
  if (!page) {
    return false;
  }
  try {
    return await page.locator('app-draft-review-panel article').evaluateAll(
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
    join(options.outDir, 'run.log'),
    `${new Date().toISOString()} ${message}\n`,
  );
}

function saveMetrics(): void {
  metrics.finished_at = new Date().toISOString();
  writeFileSync(
    join(options.outDir, 'metrics.json'),
    `${JSON.stringify(metrics, null, 2)}\n`,
  );
}

function activePage(): Page {
  if (!page) {
    throw new Error('The packaged app page is not connected.');
  }
  return page;
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
    const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
    if (version) {
      return;
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for WebView2 CDP on port ${port}`);
}

async function bodyText(): Promise<string> {
  if (!page) {
    return '';
  }
  try {
    return await page.evaluate(() => document.body?.innerText ?? '');
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
    options.outDir,
    `${String(metrics.screenshots.length + 1).padStart(2, '0')}-${name}.png`,
  );
  await activePage().screenshot({ path: file, fullPage: true });
  metrics.screenshots.push(normalizePath(relative(options.workspaceRoot, file)));
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
    metrics.observations.push(
      `Runtime refresh skipped or disabled: ${errorMessage(error)}`,
    );
  }
  await delay(2_500);
}

async function installPythonRuntimeIfNeeded(): Promise<void> {
  if (!/Install the Python backend runtime|Install runtime/.test(await bodyText())) {
    metrics.observations.push(
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
  metrics.ui_timings_ms.python_runtime_install = Date.now() - start;
  await screenshot('python-runtime-ready');
}

async function installOcrRuntimeIfNeeded(): Promise<void> {
  await openRuntimeDrawer();
  await refreshRuntimeDrawer();

  let text = await bodyText();
  if (/Unknown|status unavailable|OCR unknown|PaddleOCR status unavailable/i.test(text)) {
    metrics.observations.push(
      'Runtime drawer showed OCR unknown after Python install; manual refresh was required.',
    );
    await refreshRuntimeDrawer();
    text = await bodyText();
  }

  if (/PaddleOCR imports available|gpu:0|PaddleOCR runtime is ready/i.test(text)) {
    metrics.observations.push(
      'PaddleOCR runtime was already ready after runtime refresh.',
    );
    await screenshot('runtime-ocr-ready-after-refresh');
    return;
  }

  if (!/Install OCR|PaddleOCR runtime is not installed|paddle_runtime_missing/i.test(text)) {
    metrics.observations.push(
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
    metrics.observations.push(
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
  metrics.ui_timings_ms.paddleocr_runtime_install = Date.now() - start;
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
  metrics.project_name = projectName;
}

async function uploadAndParsePdf(): Promise<void> {
  await activePage()
    .locator('label')
    .filter({ hasText: 'Language' })
    .locator('select')
    .selectOption('ja');
  await activePage().locator('input[type="file"]').setInputFiles(options.pdfPath);
  await screenshot('pdf-selected-language-ja');

  const uploadStart = Date.now();
  await clickButtonText('Upload PDF', { timeout: 120_000 });
  await waitText(
    /Parsing started|Parsing continues|0\/\d+ pages|processing/i,
    30_000,
    'upload response / parsing visible',
  );
  metrics.ui_timings_ms.upload_to_processing_visible = Date.now() - uploadStart;
  await screenshot('parsing-started');

  const parseStart = Date.now();
  streamingDraftParseStartedAt = parseStart;
  streamingDraftCaptureOpen = true;
  try {
    await delay(15_000);
    const midText = await bodyText();
    if (/Extracted text|Page \d+|\b[1-9]\d* chunks\b/.test(midText)) {
      metrics.ui_timings_ms.first_chunk_visible = Date.now() - parseStart;
    } else {
      metrics.observations.push(
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
      if (metrics.ui_timings_ms.first_chunk_visible === undefined) {
        metrics.ui_timings_ms.first_chunk_visible = Date.now() - parseStart;
      }
    } catch (error) {
      metrics.errors.push(`first chunk wait failed: ${errorMessage(error)}`);
    }
    metrics.ui_timings_ms.first_chunk_wait_window =
      Date.now() - firstChunkStart;

    const parseCompletePromise = waitText(
      /Parsing complete\.|46\/46 pages|ready\s*Page/i,
      300_000,
      'parsing complete',
    ).then(() => {
      metrics.ui_timings_ms.parse_complete_visible = Date.now() - parseStart;
    });
    await observeStreamingDraftUiUntil(parseStart, parseCompletePromise);
    await parseCompletePromise;
  } finally {
    streamingDraftCaptureOpen = false;
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
  metrics.ui_timings_ms.deterministic_draft_generation = Date.now() - start;
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
  metrics.approved_answer = metricText(choiceValues[0]);
  metrics.wrong_answer = metricText(choiceValues[1]);
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
  metrics.ui_timings_ms.save_and_approve = Date.now() - approveStart;
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
  metrics.restart = { attempted: true };
  metrics.restart.close = await closeAppAndCheckResidue('restart');
  await delay(3_000);

  port += 1;
  await launchAppAndConnect();
  await waitText(
    /Projects|Select or create a project|Parallel Parsing QA/i,
    90_000,
    'restart workspace loaded',
  );
  if (!/Source PDF|Mock Exam Items|Parallel Parsing QA/.test(await bodyText())) {
    const projectButton = activePage().locator('button.project-select-button').first();
    if (await projectButton.count()) {
      metrics.observations.push(
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
  metrics.restart.verified =
    /Parsing complete|approved|Mock Exam Items|Source PDF/i.test(await bodyText());
}

function startNvidiaSampling(): void {
  if (options.skipGpuSampling) {
    return;
  }
  const csvPath = join(options.outDir, 'nvidia-smi.csv');
  try {
    nvidia = spawn(
      'nvidia-smi',
      [
        '--query-gpu=timestamp,utilization.gpu,memory.used,memory.total,power.draw',
        '--format=csv',
        '-l',
        '1',
      ],
      { cwd: options.workspaceRoot, windowsHide: true },
    );
    nvidia.stdout?.pipe(createWriteStream(csvPath));
    nvidia.stderr?.on('data', (chunk) =>
      appendFileSync(join(options.outDir, 'nvidia-smi.stderr.log'), chunk),
    );
    nvidia.on('error', (error) => {
      metrics.observations.push(`nvidia-smi unavailable: ${error.message}`);
    });
    metrics.gpu_sampling = normalizePath(relative(options.workspaceRoot, csvPath));
  } catch (error) {
    metrics.observations.push(`nvidia-smi unavailable: ${errorMessage(error)}`);
  }
}

async function launchAppAndConnect(): Promise<void> {
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    EXAM_PREP_OCR_PAGE_WORKERS: String(options.ocrPageWorkers),
  };
  const child = spawn(options.exePath, [], {
    cwd: options.workspaceRoot,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app = child;
  appExit = { exited: false, code: null, signal: null };
  child.stdout?.on('data', (chunk) =>
    appendFileSync(join(options.outDir, 'app.stdout.log'), chunk),
  );
  child.stderr?.on('data', (chunk) =>
    appendFileSync(join(options.outDir, 'app.stderr.log'), chunk),
  );
  child.on('exit', (code, signal) => {
    if (appExit) {
      appExit.exited = true;
      appExit.code = code;
      appExit.signal = signal;
    }
    log(`app exited code=${code} signal=${signal}`);
  });
  await waitForCdp(90_000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  page =
    context.pages()[0] ??
    (await context.waitForEvent('page', { timeout: 30_000 }));
  observeStreamingApiResponses(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .waitForLoadState('domcontentloaded', { timeout: 30_000 })
    .catch((error) => {
      metrics.observations.push(
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
  if (!existsSync(options.exePath)) {
    throw new Error(`Missing packaged exe: ${options.exePath}`);
  }
  if (!existsSync(options.pdfPath)) {
    throw new Error(`Missing QA PDF: ${options.pdfPath}`);
  }

  log(`artifact dir ${options.outDir}`);
  processBaseline = processSnapshot();
  startNvidiaSampling();
  await launchAppAndConnect();
  await installPythonRuntimeIfNeeded();
  await installOcrRuntimeIfNeeded();
  await createProject();
  await uploadAndParsePdf();
  await generateAndApproveDraft();
  await runFullExamWrongAnswer();
  await runRandomQuizCorrectClear();
  await restartAndVerifyPersistence();
  metrics.status = 'completed';
  log('flow completed');
}

async function cleanupAfterRun(): Promise<void> {
  const cleanupResidue: PublicProcessRecord[] = [];
  if (app) {
    const close = await closeAppAndCheckResidue('final cleanup').catch((error) => {
      metrics.errors.push(`final close failed: ${errorMessage(error)}`);
      return null;
    });
    if (close) {
      metrics.final_close = close;
      cleanupResidue.push(...close.residue);
    }
  }

  if (nvidia && !nvidia.killed) {
    nvidia.kill();
  }
  nvidia = null;

  const nodeHelpers = await closeNewNodeHelpers().catch((error) => {
    metrics.errors.push(`node helper cleanup failed: ${errorMessage(error)}`);
    return [];
  });
  metrics.process_cleanup = {
    node_cleanup_summary: {
      baseline_node_count: processBaseline.nodePids.size,
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

function publicProcessRecord(record: ProcessRecord): PublicProcessRecord {
  return {
    pid: record.pid,
    parentPid: record.parentPid,
    name: record.name,
    commandLine: trimCapture(record.commandLine),
  };
}

function isProtectedNodeProcess(record: ProcessRecord): boolean {
  const commandLine = normalizeForCommandLine(record.commandLine);
  return PROTECTED_NODE_COMMAND_FRAGMENTS.some((fragment) =>
    commandLine.includes(fragment),
  );
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function responseItems(payload: unknown): unknown[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    return [];
  }
  return payload.items;
}

function isUsableQuestionDraftPayload(item: unknown): boolean {
  if (!isRecord(item)) {
    return false;
  }
  const question = stringField(item.question).trim();
  const choices = Array.isArray(item.choices)
    ? item.choices.filter(
        (choice) => typeof choice === 'string' && choice.trim().length > 0,
      )
    : [];
  return question.length > 0 && choices.length >= 2;
}

function streamingDraftBlockerFromStatusCounts(
  statusCounts: Record<string, number>,
): string | undefined {
  if (statusCounts.skipped_missing_model) {
    return 'skipped_missing_model';
  }
  if (statusCounts.skipped_provider_unavailable) {
    return 'skipped_provider_unavailable';
  }
  if (statusCounts.failed) {
    return 'failed';
  }
  return undefined;
}

function mergeStatusCounts(
  target: Record<string, number>,
  source: Record<string, number>,
): void {
  for (const [status, count] of Object.entries(source)) {
    target[status] = (target[status] ?? 0) + count;
  }
}

function normalizedElapsedMs(value: number): number {
  return Math.max(0, Math.round(value));
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : Number(value) || 0;
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizePath(path: string): string {
  return path.split(sep).join('/');
}

function normalizeForCommandLine(value: string): string {
  return normalizePath(value).toLowerCase();
}

function trimCapture(value: string): string {
  return value.trim().slice(-CAPTURE_LIMIT);
}

function ignoreCleanupError(error: unknown): void {
  void error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'none');
}

async function main(): Promise<void> {
  options = parsePackagedFlowSmokeArgs(process.argv.slice(2));
  port = options.cdpPort;
  mkdirSync(options.outDir, { recursive: true });
  metrics = {
    status: 'running',
    started_at: new Date().toISOString(),
    out_dir: options.outDir,
    screenshots: [],
    ui_timings_ms: {},
    observations: [],
    errors: [],
    streaming_drafts: {
      job_snapshots: [],
      draft_snapshots: [],
      status_counts: {},
    },
  };

  try {
    await runFlow();
  } catch (error) {
    metrics.status = 'failed';
    metrics.errors.push(error instanceof Error && error.stack ? error.stack : errorMessage(error));
    log(`FAILED ${error instanceof Error && error.stack ? error.stack : errorMessage(error)}`);
    if (page) {
      await screenshot('failure-state').catch((screenshotError) => {
        metrics.observations.push(
          `failure screenshot skipped: ${errorMessage(screenshotError)}`,
        );
      });
    }
  } finally {
    await cleanupAfterRun();
    saveMetrics();
    console.log(JSON.stringify(metrics, null, 2));
  }

  process.exitCode = metrics.status === 'completed' && metrics.errors.length === 0 ? 0 : 1;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
