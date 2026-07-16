import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { chromium } from 'playwright';

import {
  collectProcessTree,
  publicProcessRecord,
  requestWindowsCloseByPid,
  selectCertPrepResidue,
  selectNewWorkspaceNodeHelpers,
  snapshotWindowsProcesses,
  terminateProcessTreeByPid,
} from '../process-lifecycle/processes.mts';
import { packagedAppDataDir } from './runtime-sync.mts';
import {
  activePage,
  bodyText,
  log,
  screenshot,
  waitForCdp,
  waitText,
} from './runner-context.mts';
import { observeStreamingApiResponses } from './streaming-capture.mts';
import { errorMessage } from './text-utils.mts';
import {
  startAcceptanceVideo,
  stopAcceptanceVideo,
} from './video-evidence.mts';
import type {
  ProcessRecord,
  PublicProcessRecord,
} from '../process-lifecycle/processes.mts';
import type { CloseSummary, SmokeRunState } from './types.mts';

type ProcessTerminationResult = ReturnType<typeof terminateProcessTreeByPid>;

interface CleanupWithTimeoutController<T extends object> {
  cleanupWithTimeout(target: T): Promise<void>;
  isFinished(target: T): boolean;
}

interface CleanupWithTimeoutOptions<T extends object> {
  cleanup: (target: T) => Promise<void>;
  timeoutMs: number;
  delayForTimeout?: (timeoutMs: number) => Promise<void>;
}

export interface ForcedCrashReconnectHooks {
  readonly terminateProcessTree?: (pid: number) => ProcessTerminationResult;
  readonly waitForExit?: (
    child: ChildProcess,
    timeoutMs: number,
  ) => Promise<boolean>;
  readonly snapshotProcesses?: () => ProcessRecord[];
  readonly waitAfterTermination?: (milliseconds: number) => Promise<unknown>;
  readonly launch?: (run: SmokeRunState) => Promise<void>;
}

export interface ForcedCrashSummary {
  readonly appPid: number;
  readonly termination: ProcessTerminationResult;
}

const ACCEPTANCE_ENV_PREFIXES = ['cert_prep_', 'ollama_', 'webview2_'] as const;
const ACCEPTANCE_REMOVED_ENV_NAMES = new Set(['no_proxy']);
const LOCAL_OCR_RUNTIME_URL_ENV = 'cert_prep_allow_local_ocr_runtime_url';
const ACCEPTANCE_LOOPBACK_NO_PROXY = 'localhost,127.0.0.1,::1';

export function createCleanupWithTimeoutController<T extends object>({
  cleanup,
  timeoutMs,
  delayForTimeout = delay,
}: CleanupWithTimeoutOptions<T>): CleanupWithTimeoutController<T> {
  const actualCleanupPromises = new WeakMap<T, Promise<void>>();
  const timeoutViewPromises = new WeakMap<T, Promise<void>>();
  const cleanupFinished = new WeakSet<T>();

  return {
    cleanupWithTimeout(target) {
      if (cleanupFinished.has(target)) {
        return Promise.resolve();
      }

      let actualCleanup = actualCleanupPromises.get(target);
      if (!actualCleanup) {
        actualCleanup = cleanup(target)
          .then(() => {
            cleanupFinished.add(target);
          })
          .finally(() => {
            actualCleanupPromises.delete(target);
            timeoutViewPromises.delete(target);
          });
        actualCleanupPromises.set(target, actualCleanup);
      }

      const existingTimeoutView = timeoutViewPromises.get(target);
      if (existingTimeoutView) {
        return existingTimeoutView;
      }

      const timeoutView = Promise.race([
        actualCleanup,
        delayForTimeout(timeoutMs).then(() => {
          throw new Error(
            `closeout cleanup timed out after ${timeoutMs}ms; cleanup is still running`,
          );
        }),
      ]).finally(() => {
        timeoutViewPromises.delete(target);
      });
      timeoutViewPromises.set(target, timeoutView);
      return timeoutView;
    },
    isFinished(target) {
      return cleanupFinished.has(target);
    },
  };
}

const cleanupAfterRunController = createCleanupWithTimeoutController({
  cleanup: cleanupAfterRun,
  timeoutMs: 90_000,
});

export async function closeAppAndCheckResidue(
  run: SmokeRunState,
  label: string,
): Promise<CloseSummary> {
  await stopAcceptanceVideo(run);
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

  let residue = selectCertPrepResidue(snapshotWindowsProcesses(), pid);
  if (residue.length > 0) {
    forced = true;
    for (const record of residue) {
      terminateProcessTreeByPid(record.pid);
    }
    await delay(1_000);
    residue = selectCertPrepResidue(snapshotWindowsProcesses(), pid);
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
      normalCloseRequested &&
      exitedAfterNormalClose &&
      publicResidue.length === 0,
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

async function closeNewNodeHelpers(
  run: SmokeRunState,
): Promise<PublicProcessRecord[]> {
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

export async function restartAndVerifyPersistence(
  run: SmokeRunState,
): Promise<void> {
  run.metrics.restart = { attempted: true };
  run.metrics.restart.close = await closeAppAndCheckResidue(run, 'restart');
  await delay(3_000);

  run.port += 1;
  await launchAppAndConnect(run);
  await waitText(
    run,
    /Projects|Select or create a project|Parallel Parsing QA/i,
    90_000,
    'restart workspace loaded',
  );
  if (
    !/Source PDF|Mock Exam Items|Parallel Parsing QA/.test(await bodyText(run))
  ) {
    const projectButton = activePage(run)
      .locator('button.project-select-button')
      .first();
    if (await projectButton.count()) {
      run.metrics.observations.push(
        'Project was not auto-selected after restart; selected it manually for persistence verification.',
      );
      await projectButton.click();
      await waitText(
        run,
        /Source PDF|Mock Exam Items|Parsing complete/i,
        30_000,
        'project selected after restart',
      );
    }
  }
  await screenshot(run, 'restart-persistence-build-state');
  run.metrics.restart.verified =
    /Parsing complete|Playable|Mock Exam Items|Source PDF/i.test(
      await bodyText(run),
    );
}

export async function forceCrashAndReconnect(
  run: SmokeRunState,
  label: string,
  {
    terminateProcessTree = terminateProcessTreeByPid,
    waitForExit = waitForChildExit,
    snapshotProcesses = snapshotWindowsProcesses,
    waitAfterTermination = delay,
    launch = launchAppAndConnect,
  }: ForcedCrashReconnectHooks = {},
): Promise<ForcedCrashSummary> {
  const crashedApp = run.app;
  const appPid = crashedApp?.pid;
  if (
    !crashedApp ||
    !appPid ||
    crashedApp.exitCode !== null ||
    crashedApp.killed
  ) {
    throw new Error(`${label} requires a live packaged app process.`);
  }

  const ownedBeforeCrash = collectLiveProcessTree(snapshotProcesses(), appPid);
  if (
    !ownedBeforeCrash.some((record) => record.pid === appPid) ||
    ownedBeforeCrash.some((record) => record.name.trim().length === 0)
  ) {
    throw new Error(
      `${label} could not capture the live app process identity before forced termination.`,
    );
  }

  const termination = terminateProcessTree(appPid);
  if (!termination.attempted || termination.error !== null) {
    throw new Error(
      `${label} could not force-terminate app process ${appPid}: ${termination.error ?? termination.method}.`,
    );
  }
  if (!(await waitForExit(crashedApp, 15_000))) {
    throw new Error(
      `${label} app process ${appPid} did not exit after forced termination.`,
    );
  }

  await run.browser?.close().catch(ignoreCleanupError);
  run.browser = null;
  run.page = null;
  run.app = null;
  run.appExit = null;
  run.projectApi = null;
  run.uploadedDocument = null;

  let residue: ProcessRecord[] = [];
  let capturedOwnedResidue: ProcessRecord[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await waitAfterTermination(500);
    const afterTermination = snapshotProcesses();
    residue = selectCertPrepResidue(afterTermination, appPid);
    capturedOwnedResidue = selectCapturedProcessResidue(
      ownedBeforeCrash,
      afterTermination,
    );
    if (residue.length === 0 && capturedOwnedResidue.length === 0) {
      break;
    }
  }
  if (residue.length > 0 || capturedOwnedResidue.length > 0) {
    const remaining = uniqueProcessRecords([
      ...capturedOwnedResidue,
      ...residue,
    ]);
    throw new Error(
      `${label} forced crash left process residue: ${remaining
        .map((record) => `${record.name}#${record.pid}`)
        .join(', ')}.`,
    );
  }

  run.metrics.observations.push(
    `${label} force-terminated packaged app process ${appPid} without a graceful close request.`,
  );
  run.port += 1;
  await launch(run);
  return { appPid, termination };
}

function collectLiveProcessTree(
  processes: readonly ProcessRecord[],
  rootPid: number,
): ProcessRecord[] {
  const tree = collectProcessTree(processes, rootPid);
  const byPid = new Map(processes.map((record) => [record.pid, record]));
  if (!byPid.has(rootPid)) {
    return tree;
  }
  return tree.filter(
    (record) =>
      record.pid === rootPid || hasValidCreationChain(record, byPid, rootPid),
  );
}

function hasValidCreationChain(
  record: ProcessRecord,
  byPid: ReadonlyMap<number, ProcessRecord>,
  rootPid: number,
): boolean {
  let current = record;
  const seen = new Set<number>();
  while (current.pid !== rootPid) {
    if (seen.has(current.pid)) {
      return false;
    }
    seen.add(current.pid);
    const parent = byPid.get(current.parentPid);
    if (!parent) {
      return false;
    }
    const childCreatedAt = processCreationEpochMs(current.creationDate);
    const parentCreatedAt = processCreationEpochMs(parent.creationDate);
    if (
      childCreatedAt !== null &&
      parentCreatedAt !== null &&
      childCreatedAt < parentCreatedAt
    ) {
      return false;
    }
    current = parent;
  }
  return true;
}

function processCreationEpochMs(value: string): number | null {
  const trimmed = value.trim();
  const powershellDate = trimmed.match(/^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/);
  const strictIsoDate =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/;
  const epochMs = powershellDate
    ? Number(powershellDate[1])
    : strictIsoDate.test(trimmed)
      ? Date.parse(trimmed)
      : Number.NaN;
  return Number.isSafeInteger(epochMs) && epochMs >= 0 ? epochMs : null;
}

function selectCapturedProcessResidue(
  captured: readonly ProcessRecord[],
  current: readonly ProcessRecord[],
): ProcessRecord[] {
  const currentByPid = new Map(current.map((record) => [record.pid, record]));
  return captured.filter((record) => {
    const currentRecord = currentByPid.get(record.pid);
    return currentRecord ? sameProcessIdentity(record, currentRecord) : false;
  });
}

function sameProcessIdentity(
  captured: ProcessRecord,
  current: ProcessRecord,
): boolean {
  if (
    captured.pid !== current.pid ||
    captured.name.toLowerCase() !== current.name.toLowerCase()
  ) {
    return false;
  }
  const capturedCreationDate = captured.creationDate.trim();
  const currentCreationDate = current.creationDate.trim();
  return capturedCreationDate && currentCreationDate
    ? capturedCreationDate === currentCreationDate
    : true;
}

function uniqueProcessRecords(
  records: readonly ProcessRecord[],
): ProcessRecord[] {
  return records.filter(
    (record, index) =>
      records.findIndex((candidate) => candidate.pid === record.pid) === index,
  );
}

export async function launchAppAndConnect(run: SmokeRunState): Promise<void> {
  const env = buildAppLaunchEnvironment(run);
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
    log(run, `app exited code=${code} signal=${signal}`);
  });
  await waitForCdp(run, 90_000);
  run.browser = await chromium.connectOverCDP(`http://127.0.0.1:${run.port}`);
  const context = run.browser.contexts()[0] ?? (await run.browser.newContext());
  run.page =
    context.pages()[0] ??
    (await context.waitForEvent('page', { timeout: 30_000 }));
  observeStreamingApiResponses(run, run.page);
  await run.page.setViewportSize({ width: 1440, height: 1000 });
  await startAcceptanceVideoForSmoke(run);
  await run.page
    .waitForLoadState('domcontentloaded', { timeout: 30_000 })
    .catch((error) => {
      run.metrics.observations.push(
        `domcontentloaded wait skipped: ${errorMessage(error)}`,
      );
    });
  await waitText(
    run,
    /Cert Prep|Local workspace|Install the Python backend runtime|Projects/,
    60_000,
    'app shell loaded',
  );
}

export function buildAppLaunchEnvironment(
  run: SmokeRunState,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const acceptanceIsolation = acceptanceIsolationEnabled(run);
  const baseEnvironment = sanitizeInheritedLaunchEnvironment(
    inherited,
    acceptanceIsolation,
  );
  const candidateDistributionProfile = run.options.candidateDistributionProfile;
  const guardedBaseEnvironment =
    candidateDistributionProfile === undefined
      ? baseEnvironment
      : Object.fromEntries(
          Object.entries(baseEnvironment).filter(
            ([name]) => name.toLowerCase() !== LOCAL_OCR_RUNTIME_URL_ENV,
          ),
        );
  const appDataDir = launchAppDataDir(run);
  const isolatedOllamaEnvironment = buildIsolatedOllamaLaunchEnvironment(run);
  return {
    ...guardedBaseEnvironment,
    ...(acceptanceIsolation
      ? {
          NO_PROXY: ACCEPTANCE_LOOPBACK_NO_PROXY,
          WEBVIEW2_USER_DATA_FOLDER: join(appDataDir, 'webview2'),
        }
      : {}),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${run.port}`,
    CERT_PREP_DESKTOP_DATA_DIR: appDataDir,
    CERT_PREP_BACKEND_LOG_DIR: run.options.outDir,
    CERT_PREP_BACKEND_READY_TIMEOUT_SECS: '90',
    CERT_PREP_LLM_PROVIDER: run.options.llmProvider,
    CERT_PREP_OCR_PROVIDER: run.options.ocrProvider,
    CERT_PREP_OCR_PAGE_WORKERS: String(run.options.ocrPageWorkers),
    ...(candidateDistributionProfile === 'local_nonpublishable'
      ? { CERT_PREP_ALLOW_LOCAL_OCR_RUNTIME_URL: 'true' }
      : {}),
    CERT_PREP_OLLAMA_MODEL: run.options.ollamaModel,
    CERT_PREP_OLLAMA_FALLBACK_MODELS:
      run.options.ollamaFallbackModels.join(','),
    ...isolatedOllamaEnvironment,
    ...(run.options.streamingDraftPageLimit
      ? {
          CERT_PREP_STREAMING_DRAFT_GENERATION_PAGE_LIMIT: String(
            run.options.streamingDraftPageLimit,
          ),
        }
      : {}),
    ...(run.options.streamingDraftWorkers
      ? {
          CERT_PREP_STREAMING_DRAFT_WORKERS: String(
            run.options.streamingDraftWorkers,
          ),
        }
      : {}),
  };
}

function buildIsolatedOllamaLaunchEnvironment(
  run: SmokeRunState,
): NodeJS.ProcessEnv {
  const host = run.options.ollamaHost;
  const modelsDir = run.options.ollamaModelsDir;
  const profileEnabled = run.options.ollamaProfileEnabled;
  if (
    host === undefined &&
    modelsDir === undefined &&
    profileEnabled === undefined
  ) {
    return {};
  }
  if (
    typeof host !== 'string' ||
    !/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.test(host) ||
    Number(new URL(host).port) > 65_535
  ) {
    throw new Error(
      'Isolated Ollama host must be exact loopback HTTP with a valid port.',
    );
  }
  if (
    typeof modelsDir !== 'string' ||
    !isAbsolute(modelsDir) ||
    !existsSync(modelsDir) ||
    lstatSync(modelsDir).isSymbolicLink() ||
    !lstatSync(modelsDir).isDirectory()
  ) {
    throw new Error(
      'Isolated Ollama models directory must be canonical and local.',
    );
  }
  const canonicalOutDir = realpathSync(resolve(run.options.outDir));
  const canonicalModelsDir = realpathSync(resolve(modelsDir));
  const modelsRelative = relative(canonicalOutDir, canonicalModelsDir);
  if (
    !modelsRelative ||
    modelsRelative === '..' ||
    modelsRelative.startsWith(`..${sep}`) ||
    isAbsolute(modelsRelative)
  ) {
    throw new Error(
      'Isolated Ollama models directory must stay inside the acceptance output directory.',
    );
  }
  if (typeof profileEnabled !== 'boolean') {
    throw new Error('Isolated Ollama profile setting must be a boolean.');
  }
  return {
    CERT_PREP_OLLAMA_HOST: host,
    CERT_PREP_OLLAMA_PROFILE_ENABLED: String(profileEnabled).toLowerCase(),
    OLLAMA_MODELS: canonicalModelsDir,
  };
}

export function sanitizeInheritedLaunchEnvironment(
  inherited: Readonly<NodeJS.ProcessEnv>,
  acceptanceIsolation = false,
): NodeJS.ProcessEnv {
  const entries = Object.entries(inherited).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  if (!acceptanceIsolation) {
    return Object.fromEntries(entries);
  }
  return Object.fromEntries(
    entries.filter(([name]) => {
      const normalizedName = name.toLowerCase();
      return (
        !ACCEPTANCE_REMOVED_ENV_NAMES.has(normalizedName) &&
        !ACCEPTANCE_ENV_PREFIXES.some((prefix) =>
          normalizedName.startsWith(prefix),
        )
      );
    }),
  );
}

export function prepareRunDirectories(
  run: SmokeRunState,
  now: () => Date = () => new Date(),
  hooks: {
    readonly afterAppDataCreated?: (stagingAppDataDir: string) => void;
  } = {},
): void {
  if (!acceptanceIsolationEnabled(run)) {
    mkdirSync(run.options.outDir, { recursive: true });
    return;
  }

  const workspaceRoot = resolve(run.options.workspaceRoot);
  const runRoot = resolve(workspaceRoot, 'tmp', 'cert-prep-desktop');
  const outDir = resolve(run.options.outDir);
  const appDataDir = resolve(requiredAcceptanceAppDataDir(run));
  const capturedAt = now().toISOString();

  requireStrictDescendant(outDir, runRoot, 'Acceptance output directory');
  requireStrictDescendant(appDataDir, outDir, 'Acceptance app-data directory');
  if (!samePath(dirname(appDataDir), outDir)) {
    throw new Error(
      'Acceptance app-data directory must be a direct child of its fresh output directory.',
    );
  }

  assertExistingPathSegmentsAreCanonical(workspaceRoot, dirname(outDir));
  mkdirSync(dirname(outDir), { recursive: true });
  assertExistingPathSegmentsAreCanonical(workspaceRoot, dirname(outDir));
  if (existsSync(outDir)) {
    throw new Error(
      `Acceptance output directory must not exist before the run: ${outDir}`,
    );
  }

  const stagingOutDir = join(
    dirname(outDir),
    `.${basename(outDir)}.preparing-${randomUUID()}`,
  );
  const stagingAppDataDir = join(stagingOutDir, basename(appDataDir));
  let stagingCreated = false;
  let committed = false;
  try {
    createFreshDirectory(stagingOutDir, 'Acceptance staging directory');
    stagingCreated = true;
    assertExistingPathSegmentsAreCanonical(workspaceRoot, stagingOutDir);
    createFreshDirectory(
      stagingAppDataDir,
      'Acceptance staging app-data directory',
    );
    assertExistingPathSegmentsAreCanonical(workspaceRoot, stagingAppDataDir);
    hooks.afterAppDataCreated?.(stagingAppDataDir);
    if (readdirSync(stagingAppDataDir).length !== 0) {
      throw new Error(
        'Acceptance app-data directory was modified before atomic commit.',
      );
    }
    renameSync(stagingOutDir, outDir);
    committed = true;
  } catch (error) {
    if (stagingCreated && !committed) {
      rmSync(stagingOutDir, { recursive: true, force: true });
    }
    throw error;
  }

  run.metrics.acceptance_isolation_at_launch = {
    captured_at: capturedAt,
    out_dir_created_by_runner: true,
    app_data_dir_created_by_runner: true,
    app_data_dir_empty_at_launch: true,
    paths_within_workspace_run_root: true,
    reparse_points_absent: true,
  };
}

function launchAppDataDir(run: SmokeRunState): string {
  if (acceptanceIsolationEnabled(run)) {
    return packagedAppDataDir(requiredAcceptanceAppDataDir(run));
  }
  return packagedAppDataDir(run.options.appDataDir);
}

function requiredAcceptanceAppDataDir(run: SmokeRunState): string {
  const appDataDir = run.options.appDataDir?.trim();
  if (!appDataDir) {
    throw new Error(
      'Acceptance lane requires an explicit isolated app-data directory.',
    );
  }
  return appDataDir;
}

function acceptanceIsolationEnabled(run: SmokeRunState): boolean {
  return (
    run.options.acceptanceIsolation === true || run.options.productionSummary
  );
}

function requireStrictDescendant(
  child: string,
  parent: string,
  label: string,
): void {
  const childRelative = relative(parent, child);
  if (
    childRelative.length === 0 ||
    childRelative === '..' ||
    childRelative.startsWith(`..${sep}`) ||
    isAbsolute(childRelative)
  ) {
    throw new Error(`${label} must stay under ${parent}.`);
  }
}

function assertExistingPathSegmentsAreCanonical(
  root: string,
  target: string,
): void {
  requireStrictDescendant(target, dirname(root), 'Acceptance path');
  const targetRelative = relative(root, target);
  if (
    targetRelative === '..' ||
    targetRelative.startsWith(`..${sep}`) ||
    isAbsolute(targetRelative)
  ) {
    throw new Error(`Acceptance path must stay under workspace root ${root}.`);
  }

  let current = root;
  assertCanonicalDirectory(current);
  for (const segment of targetRelative.split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (existsSync(current)) {
      assertCanonicalDirectory(current);
    }
  }
}

function assertCanonicalDirectory(path: string): void {
  const stat = lstatSync(path);
  const realPath = realpathSync.native(path);
  if (stat.isSymbolicLink() || !samePath(realPath, resolve(path))) {
    throw new Error(
      `Acceptance path must not traverse a reparse point: ${path}`,
    );
  }
}

function createFreshDirectory(path: string, label: string): void {
  if (existsSync(path)) {
    throw new Error(`${label} must not exist before the run: ${path}`);
  }
  try {
    mkdirSync(path);
  } catch (error) {
    throw new Error(
      `${label} could not be created atomically at ${path}: ${errorMessage(error)}`,
    );
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const normalized = resolve(value).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

export async function startAcceptanceVideoForSmoke(
  run: SmokeRunState,
  startVideo: (run: SmokeRunState) => Promise<void> = startAcceptanceVideo,
): Promise<void> {
  await startVideo(run).catch((error) => {
    run.metrics.observations.push(
      `acceptance video start failed: ${errorMessage(error)}`,
    );
  });
}

async function cleanupAfterRun(run: SmokeRunState): Promise<void> {
  const cleanupResidue: PublicProcessRecord[] = [];
  if (run.app) {
    const close = await closeAppAndCheckResidue(run, 'final cleanup').catch(
      (error) => {
        run.metrics.errors.push(`final close failed: ${errorMessage(error)}`);
        return null;
      },
    );
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

  const nodeHelpers = await closeNewNodeHelpers(run).catch((error) => {
    run.metrics.errors.push(
      `node helper cleanup failed: ${errorMessage(error)}`,
    );
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

export async function cleanupAfterRunWithTimeout(
  run: SmokeRunState,
): Promise<void> {
  await cleanupAfterRunController.cleanupWithTimeout(run);
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
