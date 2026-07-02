import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { chromium } from 'playwright';

import {
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
import type { PublicProcessRecord } from '../process-lifecycle/processes.mts';
import type { CloseSummary, SmokeRunState } from './types.mts';

interface CleanupWithTimeoutController<T extends object> {
  cleanupWithTimeout(target: T): Promise<void>;
  isFinished(target: T): boolean;
}

interface CleanupWithTimeoutOptions<T extends object> {
  cleanup: (target: T) => Promise<void>;
  timeoutMs: number;
  delayForTimeout?: (timeoutMs: number) => Promise<void>;
}

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

async function closeNewNodeHelpers(run: SmokeRunState): Promise<PublicProcessRecord[]> {
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

export async function restartAndVerifyPersistence(run: SmokeRunState): Promise<void> {
  run.metrics.restart = { attempted: true };
  run.metrics.restart.close = await closeAppAndCheckResidue(run, 'restart');
  await delay(3_000);

  run.port += 1;
  await launchAppAndConnect(run);
  await waitText(run,
    /Projects|Select or create a project|Parallel Parsing QA/i,
    90_000,
    'restart workspace loaded',
  );
  if (!/Source PDF|Mock Exam Items|Parallel Parsing QA/.test(await bodyText(run))) {
    const projectButton = activePage(run).locator('button.project-select-button').first();
    if (await projectButton.count()) {
      run.metrics.observations.push(
        'Project was not auto-selected after restart; selected it manually for persistence verification.',
      );
      await projectButton.click();
      await waitText(run,
        /Source PDF|Mock Exam Items|Parsing complete/i,
        30_000,
        'project selected after restart',
      );
    }
  }
  await screenshot(run, 'restart-persistence-build-state');
  run.metrics.restart.verified =
    /Parsing complete|Playable|Mock Exam Items|Source PDF/i.test(await bodyText(run));
}

export async function launchAppAndConnect(run: SmokeRunState): Promise<void> {
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${run.port}`,
    CERT_PREP_DESKTOP_DATA_DIR: packagedAppDataDir(run.options.appDataDir),
    CERT_PREP_BACKEND_LOG_DIR: run.options.outDir,
    CERT_PREP_BACKEND_READY_TIMEOUT_SECS: '90',
    CERT_PREP_LLM_PROVIDER: run.options.llmProvider,
    CERT_PREP_OCR_PROVIDER: run.options.ocrProvider,
    CERT_PREP_OCR_PAGE_WORKERS: String(run.options.ocrPageWorkers),
    CERT_PREP_OLLAMA_MODEL: run.options.ollamaModel,
    CERT_PREP_OLLAMA_FALLBACK_MODELS:
      run.options.ollamaFallbackModels.join(','),
    CERT_PREP_FASTFLOWLM_MODEL: run.options.ollamaModel,
    CERT_PREP_FASTFLOWLM_FALLBACK_MODELS:
      run.options.ollamaFallbackModels.join(','),
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
  await waitText(run,
    /Cert Prep|Local workspace|Install the Python backend runtime|Projects/,
    60_000,
    'app shell loaded',
  );
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
    const close = await closeAppAndCheckResidue(run, 'final cleanup').catch((error) => {
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

  const nodeHelpers = await closeNewNodeHelpers(run).catch((error) => {
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

export async function cleanupAfterRunWithTimeout(run: SmokeRunState): Promise<void> {
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
