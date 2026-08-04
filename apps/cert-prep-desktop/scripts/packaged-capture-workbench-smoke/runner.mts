import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { Page, Request } from 'playwright';

import { DEFAULT_LLM_MODEL } from '../package-qa/constants.mts';
import {
  cleanupAfterRunWithTimeout,
  closeAppAndCheckResidue,
  launchAppAndConnect,
  prepareRunDirectories,
} from '../packaged-flow-smoke/app-lifecycle.mts';
import { createProject } from '../packaged-flow-smoke/flow-steps.mts';
import {
  captureProjectApiAfterRestart,
  unavailableGenerationReadinessSnapshot,
} from '../packaged-flow-smoke/generation-readiness.mts';
import { installPythonRuntimeIfNeeded } from '../packaged-flow-smoke/runtime-install-flow.mts';
import {
  activePage,
  log,
  screenshot,
  waitText,
} from '../packaged-flow-smoke/runner-context.mts';
import { errorMessage, isRecord } from '../packaged-flow-smoke/text-utils.mts';
import type {
  CloseSummary,
  ProjectApiRef,
  SmokeMetrics,
  SmokeOptions,
  SmokeRunState,
} from '../packaged-flow-smoke/types.mts';
import {
  processSnapshot,
  snapshotWindowsProcesses,
} from '../process-lifecycle/processes.mts';
import type { PackagedCaptureWorkbenchSmokeOptions } from './args.mts';
import { redactCaptureEvidence } from './evidence.mts';
import {
  assertLazyCaptureRuntimeJourney,
  type LazyCaptureRuntimeJourney,
  type LazyRuntimePhaseSnapshot,
  type NormalizedCaptureRuntimeStatus,
} from './journey-contract.mts';
import {
  assertSafePackagedCaptureEnvironment,
  browserRequestViolations,
  type BrowserRequestSnapshot,
  type BrowserRequestViolation,
} from './request-security.mts';
import {
  assertCapturedRuntimeCleared,
  isOwnedBackendAndCaptureRunning,
  isOwnedBackendOnly,
  snapshotOwnedRuntimePhase,
  snapshotWindowsListeningPorts,
  type OwnedRuntimePhaseEvidence,
} from './runtime-process-evidence.mts';
import {
  assertPublishedCaptureSurface,
  runPublishedRuntimeNegativeDataCases,
  type PublishedRuntimeNegativeCaseEvidence,
} from './negative-data-contract.mts';

const FIXTURE = 'packaged-capture-embedded-text.pdf';
const REVIEW_MARKER = '[packaged review]';
export const CAPTURE_WORKBENCH_READY_STATUS_PATTERN = /Capture Workbench is ready\./;

interface CaptureResult {
  readonly captureId: string;
  readonly documentId: string;
  readonly safeMetadata: Record<string, unknown>;
}

interface BackendRotation {
  readonly api: ProjectApiRef;
  readonly owned: OwnedRuntimePhaseEvidence;
}

export async function runPackagedCaptureWorkbenchSmoke(
  options: PackagedCaptureWorkbenchSmokeOptions,
): Promise<void> {
  if (!existsSync(options.exePath)) {
    throw new Error(`Missing supplied installed exe: ${options.exePath}`);
  }
  assertSafePackagedCaptureEnvironment(process.env);
  const run = createRun(options);
  prepareRunDirectories(run);
  const fixturePath = join(options.outDir, FIXTURE);
  writeFileSync(
    fixturePath,
    embeddedTextPdf('Packaged Capture Workbench embedded-text fixture.'),
  );
  run.processBaseline = processSnapshot();
  let failure: unknown;
  try {
    const { journey, capture, negativeCases } = await runLazyCaptureJourney(
      run,
      fixturePath,
    );
    assertLazyCaptureRuntimeJourney(journey);
    writeFileSync(
      join(options.outDir, 'capture-workbench-metadata.json'),
      `${JSON.stringify(
        redactCaptureEvidence({
          journey,
          capture: capture.safeMetadata,
          negativeCases,
        }),
        null,
        2,
      )}\n`,
    );
    run.metrics.observations.push(
      'Fresh lazy Capture Runtime journey passed both explicit Start generations.',
    );
    run.metrics.status = 'completed';
  } catch (error) {
    failure = error;
    run.metrics.status = 'failed';
    run.metrics.errors.push(errorMessage(error));
    await screenshot(run, 'capture-workbench-failure').catch(() => undefined);
  } finally {
    await cleanupAfterRunWithTimeout(run).catch((error) => {
      run.metrics.status = 'failed';
      run.metrics.errors.push(errorMessage(error));
    });
    sanitizeLifecycleLogs(options.outDir);
    writeFileSync(
      join(options.outDir, 'capture-workbench-evidence.json'),
      `${JSON.stringify(
        redactCaptureEvidence({
          status: run.metrics.status,
          screenshots: run.metrics.screenshots,
          errors: run.metrics.errors,
          observations: run.metrics.observations,
        }),
        null,
        2,
      )}\n`,
    );
  }
  if (failure) {
    throw new Error(String(redactCaptureEvidence(errorMessage(failure))));
  }
  if (run.metrics.errors.length > 0) {
    throw new Error(
      String(redactCaptureEvidence(run.metrics.errors.join(' | '))),
    );
  }
}

async function runLazyCaptureJourney(
  run: SmokeRunState,
  fixturePath: string,
): Promise<{
  readonly journey: LazyCaptureRuntimeJourney;
  readonly capture: CaptureResult;
  readonly negativeCases: PublishedRuntimeNegativeCaseEvidence[];
}> {
  await launchAppAndConnect(run);
  const firstPage = activePage(run);
  await firstPage.waitForURL(
    (url) =>
      url.pathname === '/' ||
      url.pathname === '/runtime' ||
      url.pathname === '/build',
    { timeout: 60_000 },
  );
  await waitText(
    run,
    /Install the Python backend runtime|Install runtime/,
    60_000,
    'fresh runtime route',
  );
  const firstOwned = await waitForOwnedRuntimePhase(
    run,
    isFullyStopped,
    'fresh shell without owned backend or Capture Runtime',
  );
  const firstShell = phase('missing', false, firstOwned, {
    runtimeRouteVisible: true,
  });
  await screenshot(run, 'fresh-shell-runtime-route');

  await installPythonRuntimeIfNeeded(run);
  await createProject(run);
  const initialApi = requiredProjectApi(run);
  const firstSecurity = createBrowserSecurityTracker(firstPage, initialApi);
  await openCaptureWorkbench(run);
  await waitText(
    run,
    /Capture Runtime is not installed\./,
    60_000,
    'Capture Runtime missing',
  );
  if ((await firstPage.locator('capture-workbench').count()) !== 0) {
    throw new Error('Capture client was constructed before Capture Runtime Start.');
  }
  const backendReadyOwned = await waitForOwnedRuntimePhase(
    run,
    isOwnedBackendOnly,
    'backend ready while Capture Runtime is missing',
  );
  const backendReadyCaptureMissing = phase(
    'missing',
    true,
    backendReadyOwned,
    { pythonBackendConsentCompleted: true },
  );
  await screenshot(run, 'capture-runtime-missing');

  await firstPage
    .getByRole('button', { name: 'Install Capture Runtime', exact: true })
    .click();
  await waitText(
    run,
    /Capture Runtime is installed but stopped\./,
    120_000,
    'Capture Runtime installed-stopped',
  );
  await firstPage
    .getByRole('button', { name: 'Start Capture Runtime', exact: true })
    .waitFor({ timeout: 30_000 });
  const installedOwned = await waitForOwnedRuntimePhase(
    run,
    isOwnedBackendOnly,
    'Capture Runtime installed without auto-start',
  );
  const captureInstalledStopped = phase(
    'installed-stopped',
    true,
    installedOwned,
  );
  await screenshot(run, 'capture-runtime-installed-stopped');

  const firstRotation = await startCaptureRuntimeAndRotateBackend(
    run,
    firstSecurity,
    initialApi,
  );
  const captureRunning = phase('running', true, firstRotation.owned, {
    backendConfigurationChanged: true,
    priorBackendAccessRejected: true,
  });
  const capture = await runCaptureDocumentFlow(run, fixturePath);
  const negativeCases = await runPublishedRuntimeNegativeDataCases(
    firstPage,
    firstRotation.api,
  );
  log(run, 'Published 0.3.9 negative data contract passed');
  firstSecurity.assertClean();
  await screenshot(run, 'capture-workbench-completed');

  const firstCloseCaptured = firstRotation.owned;
  firstSecurity.dispose();
  const firstCloseSummary = await closeAppAndCheckResidue(
    run,
    'capture-persistence-restart',
  );
  await waitForCapturedRuntimeClear(firstCloseCaptured);
  const firstClose = closedPhase(firstCloseSummary);

  run.port += 1;
  await launchAppAndConnect(run);
  const relaunchedPage = activePage(run);
  const relaunchedApi = await captureProjectApiAfterRestart(
    relaunchedPage,
    firstRotation.api.projectId,
    60_000,
  );
  run.projectApi = relaunchedApi;
  const relaunchSecurity = createBrowserSecurityTracker(
    relaunchedPage,
    relaunchedApi,
  );
  await openCaptureWorkbench(run);
  await waitText(
    run,
    /Capture Runtime is installed but stopped\./,
    60_000,
    'relaunch installed-stopped',
  );
  if ((await relaunchedPage.locator('capture-workbench').count()) !== 0) {
    throw new Error('Relaunch auto-constructed Capture Workbench before Start.');
  }
  const relaunchedStoppedOwned = await waitForOwnedRuntimePhase(
    run,
    isOwnedBackendOnly,
    'relaunch without Capture Runtime auto-start',
  );
  const relaunchedInstalledStopped = phase(
    'installed-stopped',
    true,
    relaunchedStoppedOwned,
  );
  await screenshot(run, 'relaunch-capture-runtime-installed-stopped');

  const secondRotation = await startCaptureRuntimeAndRotateBackend(
    run,
    relaunchSecurity,
    relaunchedApi,
  );
  await verifyPersistedDocument(
    run,
    capture.documentId,
    secondRotation.api,
  );
  await relaunchedPage.getByRole('link', { name: 'Build', exact: true }).click();
  await waitText(run, /Step 01: Source files/, 60_000, 'Build source files');
  await waitText(
    run,
    new RegExp(FIXTURE.replace('.', '\\.')),
    60_000,
    'persisted Capture document visible',
  );
  const relaunchedRunningPersisted = phase(
    'running',
    true,
    secondRotation.owned,
    { persistedDocumentVisible: true },
  );
  relaunchSecurity.assertClean();
  await screenshot(run, 'capture-workbench-persisted');

  const finalCloseCaptured = secondRotation.owned;
  relaunchSecurity.dispose();
  const finalCloseSummary = await closeAppAndCheckResidue(
    run,
    'capture-final-close',
  );
  await waitForCapturedRuntimeClear(finalCloseCaptured);
  const finalClose = closedPhase(finalCloseSummary);

  return {
    journey: {
      firstShell,
      backendReadyCaptureMissing,
      captureInstalledStopped,
      captureRunning,
      firstClose,
      relaunchedInstalledStopped,
      relaunchedRunningPersisted,
      finalClose,
    },
    capture,
    negativeCases,
  };
}

async function startCaptureRuntimeAndRotateBackend(
  run: SmokeRunState,
  security: BrowserSecurityTracker,
  priorApi: ProjectApiRef,
): Promise<BackendRotation> {
  const page = activePage(run);
  security.beginTransition();
  await page
    .getByRole('button', { name: 'Start Capture Runtime', exact: true })
    .click();
  await waitForCaptureWorkbenchReady(run);
  const nextApi = await captureProjectApiAfterRestart(
    page,
    priorApi.projectId,
    120_000,
  );
  const configurationChanged =
    nextApi.apiBaseUrl !== priorApi.apiBaseUrl &&
    nextApi.authorization !== priorApi.authorization;
  if (!configurationChanged) {
    throw new Error('Capture Runtime Start did not rotate backend connection data.');
  }
  if (!(await priorBackendAccessRejected(page, priorApi))) {
    throw new Error('Prior backend access remained valid after Capture Runtime Start.');
  }
  run.projectApi = nextApi;
  security.completeTransition(nextApi);
  await waitForCaptureWorkbenchReady(run);
  const owned = await waitForOwnedRuntimePhase(
    run,
    isOwnedBackendAndCaptureRunning,
    'Capture Runtime and restarted backend listeners',
    120_000,
  );
  return { api: nextApi, owned };
}

async function runCaptureDocumentFlow(
  run: SmokeRunState,
  fixturePath: string,
): Promise<CaptureResult> {
  const page = activePage(run);
  const projectApi = requiredProjectApi(run);
  await waitText(
    run,
    CAPTURE_WORKBENCH_READY_STATUS_PATTERN,
    30_000,
    'Capture Workbench host ready',
  );
  await assertPublishedCaptureSurface(page);
  const input = page.locator('capture-workbench input[type="file"]');
  await input.waitFor({ state: 'attached', timeout: 30_000 });
  if (!(await input.isEnabled())) {
    throw new Error('Embedded-text picker was disabled.');
  }
  const captureResponse = page.waitForResponse(
    (response) => {
      if (response.request().method().toUpperCase() !== 'POST') {
        return false;
      }
      try {
        const url = new URL(response.url());
        return (
          url.origin === new URL(projectApi.apiBaseUrl).origin &&
          url.pathname.endsWith('/capture-workbench/captures')
        );
      } catch {
        return false;
      }
    },
    { timeout: 120_000 },
  );
  await input.setInputFiles(fixturePath);
  const response = await captureResponse;
  const capturePayload: unknown = await response.json();
  if (!response.ok() || !isRecord(capturePayload)) {
    throw new Error('Capture upload did not return a valid response.');
  }
  const captureId = stringValue(capturePayload.captureId);
  const documentId = stringValue(capturePayload.documentId);
  if (!captureId || !documentId) {
    throw new Error('Capture upload response lacked exact IDs.');
  }

  await page
    .getByRole('heading', { name: 'Review capture text', exact: true })
    .waitFor({ timeout: 120_000 });
  log(run, 'Capture review visible');
  const rawResponse = await page.request.get(
    `${projectApi.apiBaseUrl}/projects/${encodeURIComponent(
      projectApi.projectId,
    )}/capture-workbench/captures/${encodeURIComponent(captureId)}/raw`,
    { headers: { Authorization: projectApi.authorization } },
  );
  const rawPayload: unknown = await rawResponse.json();
  if (!rawResponse.ok() || !isRecord(rawPayload)) {
    throw new Error('Capture raw result was unavailable.');
  }
  const extraction = requiredRecord(rawPayload.extractionEngine, 'extraction engine');
  if (extraction.engine !== 'pdf-embedded-text' || extraction.device !== 'cpu') {
    throw new Error('Raw Capture provenance was not embedded-text CPU extraction.');
  }

  const field = page.locator('capture-workbench .ocr-review textarea').first();
  const original = await field.inputValue();
  await field.fill(`${original}\n${REVIEW_MARKER}`);
  await page
    .getByRole('button', { name: 'Confirm capture', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'Capture document saved' })
    .waitFor({ timeout: 120_000 });
  const documentResponse = await page.request.get(
    `${projectApi.apiBaseUrl}/projects/${encodeURIComponent(
      projectApi.projectId,
    )}/documents/${encodeURIComponent(documentId)}`,
    { headers: { Authorization: projectApi.authorization } },
  );
  const documentPayload: unknown = await documentResponse.json();
  if (
    !documentResponse.ok() ||
    !isRecord(documentPayload) ||
    documentPayload.status !== 'ready' ||
    documentPayload.extraction_method !== 'embedded' ||
    typeof documentPayload.chunks_count !== 'number' ||
    documentPayload.chunks_count < 1
  ) {
    throw new Error('Capture document was not durably ready with embedded extraction.');
  }

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download Markdown' }).click(),
  ]);
  const markdownPath = join(run.options.outDir, 'capture.md');
  await download.saveAs(markdownPath);
  if (!(await readFile(markdownPath, 'utf8')).includes(REVIEW_MARKER)) {
    throw new Error('Downloaded Markdown omitted the review edit.');
  }

  const source = requiredRecord(rawPayload.source, 'source identity');
  const sourceSha256 = stringValue(source.sha256);
  const sourceFileName = stringValue(source.fileName);
  if (!/^[0-9a-f]{64}$/i.test(sourceSha256) || sourceFileName !== FIXTURE) {
    throw new Error('Capture raw source identity did not match the uploaded fixture.');
  }
  return {
    captureId,
    documentId,
    safeMetadata: {
      source: {
        fileName: sourceFileName,
        sha256: sourceSha256,
      },
      extractionEngine: {
        engine: extraction.engine,
        device: extraction.device,
      },
      document: {
        id: documentId,
        status: documentPayload.status,
        extractionMethod: documentPayload.extraction_method,
        chunksCount: documentPayload.chunks_count,
      },
      markdownReviewPresent: true,
    },
  };
}

async function verifyPersistedDocument(
  run: SmokeRunState,
  documentId: string,
  projectApi: ProjectApiRef,
): Promise<void> {
  const response = await activePage(run).request.get(
    `${projectApi.apiBaseUrl}/projects/${encodeURIComponent(
      projectApi.projectId,
    )}/documents/${encodeURIComponent(documentId)}`,
    { headers: { Authorization: projectApi.authorization } },
  );
  const payload: unknown = await response.json();
  if (
    !response.ok() ||
    !isRecord(payload) ||
    payload.status !== 'ready' ||
    payload.extraction_method !== 'embedded'
  ) {
    throw new Error('Persisted Capture document was not ready after relaunch.');
  }
}

async function openCaptureWorkbench(run: SmokeRunState): Promise<void> {
  const page = activePage(run);
  await page
    .getByRole('link', { name: 'Capture Workbench', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'Capture Workbench trial' })
    .waitFor({ timeout: 60_000 });
}

async function waitForCaptureWorkbenchReady(run: SmokeRunState): Promise<void> {
  await waitText(run, /Element registered/i, 120_000, 'Capture Workbench registered');
  await activePage(run)
    .locator('capture-workbench input[type="file"]')
    .waitFor({ state: 'attached', timeout: 30_000 });
}

async function priorBackendAccessRejected(
  page: Page,
  priorApi: ProjectApiRef,
): Promise<boolean> {
  try {
    const response = await page.request.get(`${priorApi.apiBaseUrl}/projects`, {
      headers: { Authorization: priorApi.authorization },
      failOnStatusCode: false,
      timeout: 5_000,
    });
    return !response.ok();
  } catch {
    return true;
  }
}

interface BrowserSecurityTracker {
  beginTransition(): void;
  completeTransition(nextApi: ProjectApiRef): void;
  assertClean(): void;
  dispose(): void;
}

function createBrowserSecurityTracker(
  page: Page,
  initialApi: ProjectApiRef,
): BrowserSecurityTracker {
  const appOrigin = new URL(page.url()).origin;
  let currentApi = initialApi;
  let transition:
    | { readonly priorApi: ProjectApiRef; requests: BrowserRequestSnapshot[] }
    | null = null;
  const violations: BrowserRequestViolation[] = [];
  const listener = (request: Request): void => {
    const headers = request.headers();
    const authorization = Object.entries(headers).find(
      ([name]) => name.toLowerCase() === 'authorization',
    )?.[1];
    const snapshot: BrowserRequestSnapshot = {
      url: request.url(),
      headers: authorization ? { authorization } : {},
    };
    if (transition) {
      transition.requests.push(snapshot);
      return;
    }
    violations.push(...evaluateRequest(snapshot, appOrigin, currentApi));
  };
  page.on('request', listener);

  return {
    beginTransition(): void {
      if (transition !== null) {
        throw new Error('Browser security generation transition is already active.');
      }
      transition = { priorApi: currentApi, requests: [] };
    },
    completeTransition(nextApi: ProjectApiRef): void {
      if (transition === null) {
        throw new Error('Browser security generation transition was not active.');
      }
      const captured = transition;
      transition = null;
      for (const request of captured.requests) {
        let targetOrigin = '';
        try {
          targetOrigin = new URL(request.url).origin;
        } catch {
          violations.push('invalid_request_url');
          continue;
        }
        const generation =
          targetOrigin === new URL(captured.priorApi.apiBaseUrl).origin
            ? captured.priorApi
            : nextApi;
        violations.push(...evaluateRequest(request, appOrigin, generation));
      }
      captured.requests.length = 0;
      currentApi = nextApi;
    },
    assertClean(): void {
      if (transition !== null) {
        throw new Error('Browser security generation transition did not complete.');
      }
      if (violations.length > 0) {
        throw new Error(
          `Browser request boundary failed: ${[...new Set(violations)].join(', ')}.`,
        );
      }
    },
    dispose(): void {
      page.off('request', listener);
      if (transition) {
        transition.requests.length = 0;
      }
      transition = null;
    },
  };
}

function evaluateRequest(
  request: BrowserRequestSnapshot,
  appOrigin: string,
  api: ProjectApiRef,
): BrowserRequestViolation[] {
  return browserRequestViolations(
    {
      appOrigin,
      backendOrigin: api.apiBaseUrl,
      expectedBackendAuthorization: api.authorization,
    },
    request,
  );
}

async function waitForOwnedRuntimePhase(
  run: SmokeRunState,
  predicate: (evidence: OwnedRuntimePhaseEvidence) => boolean,
  label: string,
  timeoutMs = 30_000,
): Promise<OwnedRuntimePhaseEvidence> {
  const appPid = run.app?.pid;
  if (!appPid) {
    throw new Error(`${label} requires a live app PID.`);
  }
  const deadline = Date.now() + timeoutMs;
  do {
    const evidence = snapshotOwnedRuntimePhase(appPid);
    if (predicate(evidence)) {
      return evidence;
    }
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error(`${label} did not reach the required owned process state.`);
}

async function waitForCapturedRuntimeClear(
  captured: OwnedRuntimePhaseEvidence,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  do {
    try {
      assertCapturedRuntimeCleared(
        captured,
        snapshotWindowsProcesses(),
        snapshotWindowsListeningPorts(),
      );
      return;
    } catch {
      await delay(250);
    }
  } while (Date.now() < deadline);
  assertCapturedRuntimeCleared(
    captured,
    snapshotWindowsProcesses(),
    snapshotWindowsListeningPorts(),
  );
}

function isFullyStopped(evidence: OwnedRuntimePhaseEvidence): boolean {
  return (
    evidence.backendProcesses.length === 0 &&
    evidence.backendListenerPorts.length === 0 &&
    evidence.captureProcesses.length === 0 &&
    evidence.captureListenerPorts.length === 0
  );
}

function phase(
  captureStatus: NormalizedCaptureRuntimeStatus,
  backendReady: boolean,
  owned: OwnedRuntimePhaseEvidence,
  extras: Partial<LazyRuntimePhaseSnapshot> = {},
): LazyRuntimePhaseSnapshot {
  return {
    captureStatus,
    backendReady,
    backendProcesses: owned.backendProcesses,
    backendListenerPorts: owned.backendListenerPorts,
    captureProcesses: owned.captureProcesses,
    captureListenerPorts: owned.captureListenerPorts,
    ...extras,
  };
}

function closedPhase(summary: CloseSummary): LazyRuntimePhaseSnapshot {
  assertGracefulCloseSummary(summary);
  return {
    captureStatus: 'closed',
    backendReady: false,
    backendProcesses: [],
    backendListenerPorts: [],
    captureProcesses: [],
    captureListenerPorts: [],
  };
}

export function assertGracefulCloseSummary(summary: CloseSummary): void {
  if (
    !summary.normal_close_requested ||
    !summary.exited_after_normal_close ||
    !summary.gracefulExited ||
    summary.forced ||
    summary.fallbackUsed
  ) {
    throw new Error(
      `${summary.label} did not complete through the normal graceful-close path.`,
    );
  }
}

function requiredProjectApi(run: SmokeRunState): ProjectApiRef {
  if (!run.projectApi) {
    throw new Error('Project API context was unavailable.');
  }
  return run.projectApi;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Capture ${label} was malformed.`);
  }
  return value;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function sanitizeLifecycleLogs(outDir: string): void {
  for (const name of ['app.stdout.log', 'app.stderr.log', 'run.log']) {
    const path = join(outDir, name);
    if (!existsSync(path)) {
      continue;
    }
    const redacted = redactCaptureEvidence(readFileSync(path, 'utf8'));
    writeFileSync(path, String(redacted));
  }
}

function createRun(
  options: PackagedCaptureWorkbenchSmokeOptions,
): SmokeRunState {
  const smoke: SmokeOptions = {
    workspaceRoot: options.workspaceRoot,
    exePath: options.exePath,
    pdfPath: join(options.outDir, FIXTURE),
    outDir: options.outDir,
    appDataDir: options.appDataDir,
    cdpPort: options.cdpPort,
    llmProvider: 'fake',
    acceptanceIsolation: true,
    candidateDistributionProfile: 'local_nonpublishable',
    waitForStreamingComplete: false,
    streamingCompleteTimeoutMs: 120_000,
    skipGpuSampling: true,
    productionSummary: false,
    allowCaptureChunkVariance: true,
    verifyStreamingPracticeReady: false,
  };
  const metrics: SmokeMetrics = {
    status: 'running',
    started_at: new Date().toISOString(),
    out_dir: options.outDir,
    screenshots: [],
    ui_timings_ms: {},
    observations: [],
    errors: [],
    llm_provider: 'fake',
    llm_model: DEFAULT_LLM_MODEL,
    llm_configured_model: DEFAULT_LLM_MODEL,
    generation_readiness_at_start: unavailableGenerationReadinessSnapshot(
      'capture_not_reached',
    ),
    first_chunk_gate_ms: 15_000,
    first_chunk_under_gate: false,
    streaming_questions: {
      job_snapshots: [],
      question_snapshots: [],
      status_counts: {},
    },
  };
  return {
    options: smoke,
    metrics,
    app: null,
    appExit: null,
    resourceSampling: null,
    browser: null,
    page: null,
    port: options.cdpPort,
    processBaseline: { all: [], nodePids: new Set() },
    projectApi: null,
    uploadedDocument: null,
    streamingDraftParseStartedAt: null,
    streamingDraftCaptureOpen: false,
    streamingApiPollErrorCaptured: false,
  };
}

function embeddedTextPdf(text: string): Buffer {
  const escaped = text
    .replaceAll('\\', '\\\\')
    .replaceAll('(', '\\(')
    .replaceAll(')', '\\)');
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer << /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}
