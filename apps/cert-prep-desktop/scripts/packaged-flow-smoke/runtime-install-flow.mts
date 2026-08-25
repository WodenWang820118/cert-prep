import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import type { Locator } from 'playwright';

import {
  activePage,
  bodyText,
  clickButtonPattern,
  clickConsentInstall,
  log,
  openRuntimeDrawer,
  screenshot,
  waitRuntimeDrawerText,
  waitText,
} from './runner-context.mts';
import { captureProjectApiAfterRestart } from './generation-readiness.mts';
import type { SmokeRunState } from './types.mts';

export async function installPythonRuntimeIfNeeded(
  run: SmokeRunState,
): Promise<void> {
  const startupState = await waitForPythonRuntimeStartupState(run);
  if (startupState === 'ready') {
    run.metrics.observations.push(
      'Python backend runtime was already available at QA start.',
    );
    return;
  }

  await screenshot(run, 'runtime-python-missing');
  await openRuntimeDrawer(run);
  await screenshot(run, 'runtime-drawer-python-missing');
  const start = Date.now();
  await clickButtonPattern(run, /^\s*Install runtime\s*$/);
  await waitText(
    run,
    /Install Python backend runtime/,
    10_000,
    'python install consent',
  );
  await screenshot(run, 'python-install-consent');
  await clickConsentInstall(run);
  await waitRuntimeDrawerText(
    run,
    pythonRuntimeReadyPattern(),
    90_000,
    'python runtime ready',
  );
  run.metrics.ui_timings_ms.python_runtime_install = Date.now() - start;
  await screenshot(run, 'python-runtime-ready');
}

export function pythonRuntimeStartupState(
  text: string,
): 'installable' | 'ready' | 'pending' {
  if (pythonRuntimeReadyPattern().test(text)) return 'ready';
  if (/Install the Python backend runtime|Install runtime/.test(text)) {
    return 'installable';
  }
  return 'pending';
}

async function waitForPythonRuntimeStartupState(
  run: SmokeRunState,
): Promise<'installable' | 'ready'> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = pythonRuntimeStartupState(await bodyText(run));
    if (state !== 'pending') return state;
    await delay(100);
  }
  throw new Error(
    'Timed out waiting for the packaged Python runtime to become installable or ready.',
  );
}

export function pythonRuntimeReadyPattern(): RegExp {
  return /(?:^|\r?\n)[^\S\r\n]*(?:Python backend runtime is (?:ready|running|already running)\.|Python \d+\.\d+(?:\.\d+)? \/ packaged)[^\S\r\n]*(?=\r?\n|$)/i;
}

export async function ensureCaptureRuntimeReady(
  run: SmokeRunState,
): Promise<void> {
  const page = activePage(run);
  await page
    .getByRole('link', { name: 'Capture Workbench', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'Capture Workbench trial' })
    .waitFor({ timeout: 60_000 });

  const installButton = page.getByRole('button', {
    name: 'Install Capture Runtime',
    exact: true,
  });
  if (await isVisible(installButton, 10_000)) {
    await runNativeCaptureRuntimeJob(run, 'install_capture_runtime');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page
      .getByRole('heading', { name: 'Capture Workbench trial' })
      .waitFor({ timeout: 60_000 });
  }

  const startButton = page.getByRole('button', {
    name: 'Start Capture Runtime',
    exact: true,
  });
  if (await isVisible(startButton, 10_000)) {
    await runNativeCaptureRuntimeJob(run, 'start_capture_runtime');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page
      .getByRole('heading', { name: 'Capture Workbench trial' })
      .waitFor({ timeout: 60_000 });
  }
  await waitText(
    run,
    /Element registered/i,
    120_000,
    'Capture Runtime registered',
  );
  const projectId = run.projectApi?.projectId;
  if (!projectId) {
    throw new Error(
      'Capture Runtime start changed the backend connection before the project API reference was captured.',
    );
  }
  run.projectApi = await captureProjectApiAfterRestart(
    page,
    projectId,
    120_000,
  );
  await ensureCaptureRuntimeRequirement(run, 'windowsml-ocr');
  await page
    .locator('capture-workbench input[type="file"]')
    .waitFor({ state: 'attached', timeout: 30_000 });

  await page.getByRole('link', { name: 'Build', exact: true }).click();
  await waitText(
    run,
    /Workspace ready|Select a source document/i,
    60_000,
    'Build workspace restored after Capture Runtime start',
  );
}

export async function ensureCaptureRuntimeRequirement(
  run: SmokeRunState,
  requirementId: 'windowsml-ocr',
): Promise<void> {
  const projectApi = run.projectApi;
  if (!projectApi) {
    throw new Error(
      `Cannot install Capture Runtime requirement ${requirementId} before project API capture.`,
    );
  }
  const page = activePage(run);
  const headers = { Authorization: projectApi.authorization };
  const requirementsResponse = await page.request.get(
    `${projectApi.apiBaseUrl}/capture-runtime/requirements`,
    { headers, timeout: 30_000 },
  );
  const requirementsPayload = await requirementsResponse.json().catch(() => null);
  if (!requirementsResponse.ok()) {
    throw new Error(
      `Capture Runtime requirement query returned HTTP ${requirementsResponse.status()}.`,
    );
  }
  const requirement = findRequirement(requirementsPayload, requirementId);
  if (requirement?.status === 'ready') {
    log(run, `${requirementId} requirement already ready`);
    return;
  }
  if (requirement?.status !== 'installable') {
    throw new Error(
      `Capture Runtime requirement ${requirementId} is not installable: ${requirement?.status ?? 'missing'}.`,
    );
  }

  const installationResponse = await page.request.post(
    `${projectApi.apiBaseUrl}/capture-runtime/installations`,
    {
      headers: {
        ...headers,
        'X-Idempotency-Key': randomUUID(),
      },
      data: { requirementId, consent: true },
      timeout: 30_000,
    },
  );
  const installationPayload = await installationResponse.json().catch(() => null);
  if (!installationResponse.ok()) {
    throw new Error(
      `Capture Runtime ${requirementId} installation start returned HTTP ${installationResponse.status()}.`,
    );
  }
  const installationId = stringField(installationPayload, 'installationId');
  if (!installationId) {
    throw new Error(
      `Capture Runtime ${requirementId} installation returned no installationId.`,
    );
  }

  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const statusResponse = await page.request.get(
      `${projectApi.apiBaseUrl}/capture-runtime/installations/${encodeURIComponent(installationId)}`,
      { headers, timeout: 30_000 },
    );
    const statusPayload = await statusResponse.json().catch(() => null);
    if (!statusResponse.ok()) {
      throw new Error(
        `Capture Runtime ${requirementId} installation poll returned HTTP ${statusResponse.status()}.`,
      );
    }
    const status = stringField(statusPayload, 'status');
    if (captureRuntimeInstallationCompleted(status)) {
      log(run, `${requirementId} requirement installation completed`);
      return;
    }
    if (status === 'failed' || status === 'cancelled') {
      const error = installationErrorMessage(statusPayload);
      throw new Error(
        `Capture Runtime ${requirementId} installation ended as ${status}${error ? `: ${error}` : '.'}`,
      );
    }
    await delay(1_000);
  }
  throw new Error(
    `Timed out waiting for Capture Runtime ${requirementId} installation.`,
  );
}

export function captureRuntimeInstallationCompleted(
  status: string | null,
): boolean {
  return status === 'succeeded' || status === 'completed';
}

function findRequirement(
  payload: unknown,
  requirementId: string,
): { status: string } | null {
  if (!isRecord(payload) || !Array.isArray(payload.items)) return null;
  const item = payload.items.find(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && candidate.requirementId === requirementId,
  );
  if (!item || typeof item.status !== 'string') return null;
  return { status: item.status };
}

function stringField(payload: unknown, field: string): string | null {
  if (!isRecord(payload)) return null;
  const value = payload[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function installationErrorMessage(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.error)) return null;
  return stringField(payload.error, 'message');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function isVisible(locator: Locator, timeout: number): Promise<boolean> {
  try {
    await locator.waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

async function runNativeCaptureRuntimeJob(
  run: SmokeRunState,
  command: 'install_capture_runtime' | 'start_capture_runtime',
): Promise<void> {
  const result = await invokeTauri(run, command);
  const jobId = readStringField(result, 'id');
  if (!jobId) throw new Error(`Capture Runtime ${command} returned no job id.`);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const current = await invokeTauri(run, 'get_capture_runtime_installation', {
      jobId,
    });
    const status = readStringField(current, 'status');
    if (status === 'succeeded') return;
    if (status === 'failed' || status === 'cancelled') {
      throw new Error(
        `Capture Runtime ${command} failed: ${readStringField(current, 'detail') ?? 'unknown error'}`,
      );
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for Capture Runtime ${command}.`);
}

async function invokeTauri(
  run: SmokeRunState,
  command: string,
  args?: Record<string, string>,
): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${run.port}/json/list`);
  if (!response.ok) throw new Error('WebView2 CDP endpoint is unavailable.');
  const targets = (await response.json()) as readonly {
    type?: string;
    webSocketDebuggerUrl?: string;
  }[];
  const webSocketUrl = targets.find(
    (target) => target.type === 'page' && target.webSocketDebuggerUrl,
  )?.webSocketDebuggerUrl;
  if (!webSocketUrl)
    throw new Error('WebView2 page CDP target is unavailable.');

  const payload = args === undefined ? 'undefined' : JSON.stringify(args);
  const expression = `(async () => {
    const bridge = globalThis.__TAURI_INTERNALS__;
    if (!bridge) throw new Error('Tauri bridge is unavailable.');
    return bridge.invoke(${JSON.stringify(command)}, ${payload});
  })()`;
  return new Promise<unknown>((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    let settled = false;
    const timer = setTimeout(
      () => finishError('Tauri command timed out.'),
      30_000,
    );
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
      socket.close();
    };
    const finishError = (message: string): void =>
      finish(() => reject(new Error(message)));

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { awaitPromise: true, returnByValue: true, expression },
        }),
      );
    };
    socket.onmessage = (event) => {
      let message: {
        id?: number;
        error?: unknown;
        result?: {
          result?: { value?: unknown; exceptionDetails?: unknown };
        };
      };
      try {
        message = JSON.parse(String(event.data)) as typeof message;
      } catch {
        finishError('Tauri command returned invalid CDP data.');
        return;
      }
      if (message.id !== 1) return;
      if (message.error || message.result?.result?.exceptionDetails) {
        finishError('Tauri command failed in the packaged app.');
        return;
      }
      finish(() => resolve(message.result?.result?.value));
    };
    socket.onerror = () => finishError('WebView2 CDP command failed.');
    socket.onclose = () => {
      if (!settled) finishError('WebView2 CDP command closed unexpectedly.');
    };
  });
}

function readStringField(value: unknown, field: string): string | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : null;
}
