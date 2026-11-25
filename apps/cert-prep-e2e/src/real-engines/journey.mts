/**
 * Browser and API journey for one dev-server run.
 *
 * Recognized text and the private anchors stay in memory only long enough to
 * count a match. The written report keeps counts, device verdicts and pass/fail.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type Page } from '@playwright/test';

import { countAnchors, normalizeRecognizedText } from './anchors.mts';
import {
  CAPTURE_DOCUMENT_SCHEMA_VERSION,
  CAPTURE_RUNTIME_API_VERSION,
  ENV_ADAPTERS,
  ENV_API_BASE_URL,
  ENV_API_TOKEN,
  ENV_DEVICES_CLI,
  ENV_ENGINE_ROOT,
  ENV_IMAGE,
  ENV_OLLAMA_PORT,
  ENV_PDF,
  ENV_RECORDING,
  ENV_RUN,
  ENV_RUNTIME_PID,
  ENV_RUNTIME_VERSION,
  ENV_SPEECH_MODEL,
  INSTALL_TIMEOUT_MS,
  NAVIGATION_TIMEOUT_MS,
  OCR_TIMEOUT_MS,
  QUESTION_TIMEOUT_MS,
  SHORT_COMMAND_TIMEOUT_MS,
  SPEECH_TIMEOUT_MS,
  WINDOWS_SCRIPT_TIMEOUT_MS,
} from './budgets.mts';
import { designedOcrAdapterClass, killIfRecordedProcess, readProcessCreationTicks, spawnTimedOut } from './devices.mts';

/** Same NVIDIA vendor id the sampler uses when it reads the DirectX registry. */
const NVIDIA_VENDOR_ID = 0x10de;
const WORKER_EXIT_MS = 60_000;
const TERMINAL_SOURCE_FAILURE = ['no_text_detected', 'extraction_failed', 'transcription_failed', 'canceled'];

class JourneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JourneyError';
  }
}

interface AnchorCount {
  readonly found: number;
  readonly expected: number;
}

interface DeviceReport {
  readonly designed: string;
  readonly reported: string;
  readonly observed: string;
  readonly verdict: string;
  readonly reasons: readonly string[];
  readonly sampleCount: number;
  readonly nvidiaSampleCount: number;
  readonly nvidiaMaxUtilization: number | null;
}

interface PhaseBody {
  readonly passed: boolean;
  readonly failure?: string;
  readonly anchors?: AnchorCount;
  readonly device?: DeviceReport;
}

interface JourneyPhase {
  readonly phase: string;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly anchors?: AnchorCount;
  readonly device?: DeviceReport;
}

export interface JourneyReport {
  readonly schemaVersion: 1;
  readonly passed: boolean;
  readonly phases: readonly JourneyPhase[];
}

interface JourneyContext {
  readonly runDir: string;
  readonly apiBase: string;
  readonly token: string;
  readonly pdfPath: string;
  readonly imagePath: string;
  readonly recordingPath: string;
  readonly speechModel: string;
  readonly runtimePid: string;
  readonly engineRoot: string;
  readonly ollamaPort: string;
  readonly adaptersPath: string;
  readonly devicesCli: string;
  readonly runtimeVersion: string;
}

interface OcrPlan {
  readonly designedAdapterClass: 'dedicated' | 'integrated';
  readonly reportedAdapterClass: 'dedicated' | 'integrated';
  readonly observed: 'dedicated-gpu' | 'integrated-gpu';
}

interface JourneyState {
  projectId: string;
  pdfSourceId: string;
  ocr: OcrPlan | null;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new JourneyError(`The real-engine journey is missing ${name}.`);
  return value;
}

function readContext(): JourneyContext {
  return {
    runDir: requiredEnv(ENV_RUN),
    apiBase: requiredEnv(ENV_API_BASE_URL).replace(/\/$/u, ''),
    token: requiredEnv(ENV_API_TOKEN),
    pdfPath: requiredEnv(ENV_PDF),
    imagePath: requiredEnv(ENV_IMAGE),
    recordingPath: requiredEnv(ENV_RECORDING),
    speechModel: requiredEnv(ENV_SPEECH_MODEL),
    runtimePid: requiredEnv(ENV_RUNTIME_PID),
    engineRoot: requiredEnv(ENV_ENGINE_ROOT),
    ollamaPort: requiredEnv(ENV_OLLAMA_PORT),
    adaptersPath: requiredEnv(ENV_ADAPTERS),
    devicesCli: requiredEnv(ENV_DEVICES_CLI),
    runtimeVersion: requiredEnv(ENV_RUNTIME_VERSION),
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function textOf(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' ? value : null;
}

function numberOf(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === 'number' ? value : null;
}

function timeLeft(deadline: number): number {
  const left = deadline - Date.now();
  if (left <= 0) throw new JourneyError('The phase timed out.');
  return left;
}

async function requestJson(
  context: JourneyContext,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${context.apiBase}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${context.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const payload = await response.text();
    if (payload.length === 0) return { status: response.status, body: null };
    try {
      return { status: response.status, body: JSON.parse(payload) as unknown };
    } catch {
      return { status: response.status, body: null };
    }
  } finally {
    clearTimeout(timer);
  }
}

function assertHttp(status: number, allowed: readonly number[]): void {
  if (!allowed.includes(status)) throw new JourneyError(`HTTP ${status}.`);
}

async function pollUntil(deadline: number, message: string, read: () => Promise<'done' | 'wait'>): Promise<void> {
  while (Date.now() < deadline) {
    if ((await read()) === 'done') return;
    await delay(Math.min(2_000, Math.max(0, deadline - Date.now())));
  }
  throw new JourneyError(message);
}

async function loadAnchors(mediaPath: string, label: string): Promise<readonly string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(`${mediaPath}.expected.json`, 'utf8')) as unknown;
  } catch {
    throw new JourneyError(`The ${label} anchor file is invalid.`);
  }
  const record = recordOf(parsed);
  const anchors = record?.['rawTextIncludes'];
  if (
    record?.['schemaVersion'] !== 1 ||
    !Array.isArray(anchors) ||
    anchors.length === 0 ||
    !anchors.every((anchor) => typeof anchor === 'string' && normalizeRecognizedText(anchor).length > 0)
  ) {
    throw new JourneyError(`The ${label} anchor file is invalid.`);
  }
  return anchors as readonly string[];
}

async function uiStep(message: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof JourneyError) throw error;
    throw new JourneyError(message);
  }
}

function readCreationTime(pid: number): string | null {
  try {
    return readProcessCreationTicks(pid);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Reading process creation time timed out.';
    throw new JourneyError(message);
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveExit(true);
    });
  });
}

async function withSamples(
  context: JourneyContext,
  phase: string,
  sampleArgs: readonly string[],
  work: () => Promise<void>,
): Promise<void> {
  const directory = join(context.runDir, 'samples', phase);
  await mkdir(directory, { recursive: true });
  const child = spawn(process.execPath, [context.devicesCli, 'sample', '--out', directory, ...sampleArgs], {
    windowsHide: true,
    stdio: 'ignore',
  });
  child.once('error', () => undefined);
  let recordedCreation: string | null = null;
  let workError: unknown;
  try {
    if (child.pid) recordedCreation = readCreationTime(child.pid);
    if (child.pid && recordedCreation === null && child.exitCode === null && child.signalCode === null) {
      throw new JourneyError('The process creation time was not readable.');
    }
    const readyDeadline = Date.now() + 25_000;
    let started = false;
    while (Date.now() < readyDeadline) {
      if (child.exitCode !== null) throw new JourneyError('Device sampling failed.');
      if (existsSync(join(directory, 'started'))) {
        started = true;
        break;
      }
      await delay(250);
    }
    if (!started) throw new JourneyError('Device sampling failed.');
    await work();
  } catch (error) {
    workError = error;
  }
  // Stop the sampler whatever happened; the phase's own error wins over a cleanup error.
  await writeFile(join(directory, 'stop'), 'stop\n').catch(() => undefined);
  let cleanupError: JourneyError | undefined;
  if (!(await waitForExit(child, 20_000))) {
    try {
      killIfRecordedProcess(child, recordedCreation);
    } catch (error) {
      cleanupError = new JourneyError(error instanceof Error ? error.message : 'taskkill timed out.');
    }
  }
  if (workError !== undefined) throw workError;
  if (cleanupError) throw cleanupError;
}

function readDecision(stdout: string): DeviceReport | null {
  const lines = stdout.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? '';
    if (!line.startsWith('{')) continue;
    try {
      const record = recordOf(JSON.parse(line) as unknown);
      const reasons = record?.['reasons'];
      const designed = textOf(record, 'designed');
      const reported = textOf(record, 'reported');
      const observed = textOf(record, 'observed');
      const verdict = textOf(record, 'verdict');
      const sampleCount = numberOf(record, 'sampleCount');
      const nvidiaSampleCount = numberOf(record, 'nvidiaSampleCount');
      const nvidiaMax = record?.['nvidiaMaxUtilization'];
      if (!designed || !reported || !observed || !verdict || sampleCount === null || nvidiaSampleCount === null) return null;
      if (!Array.isArray(reasons)) return null;
      const reasonLines: string[] = [];
      for (const reason of reasons) {
        if (typeof reason !== 'string') return null;
        reasonLines.push(reason);
      }
      let nvidiaMaxUtilization: number | null;
      if (nvidiaMax === null) nvidiaMaxUtilization = null;
      else if (typeof nvidiaMax === 'number') nvidiaMaxUtilization = nvidiaMax;
      else return null;
      return {
        designed,
        reported,
        observed,
        verdict,
        reasons: reasonLines,
        sampleCount,
        nvidiaSampleCount,
        nvidiaMaxUtilization,
      };
    } catch {
      return null;
    }
  }
  return null;
}

function deviceVerdict(context: JourneyContext, phase: string, args: readonly string[]): DeviceReport {
  const result = spawnSync(
    process.execPath,
    [
      context.devicesCli,
      'verdict',
      '--samples',
      join(context.runDir, 'samples', phase),
      '--adapters',
      context.adaptersPath,
      ...args,
    ],
    { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: SHORT_COMMAND_TIMEOUT_MS },
  );
  if (spawnTimedOut(result.error)) {
    throw new JourneyError(`devices verdict timed out after ${SHORT_COMMAND_TIMEOUT_MS} ms.`);
  }
  const decision = result.status === 0 ? readDecision(result.stdout ?? '') : null;
  if (!decision) throw new JourneyError('Device sampling failed.');
  return decision;
}

const workerExitScript = String.raw`
param([string]$EngineRoot, [string]$Requirement)
$ErrorActionPreference = 'SilentlyContinue'
$prefix = $EngineRoot.TrimEnd('\') + '\' + $Requirement + '\'
foreach ($process in @(Get-CimInstance Win32_Process -Property ExecutablePath)) {
  $executable = [string]$process.ExecutablePath
  if ($executable.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { exit 2 }
}
exit 0
`;

/** The 8 GB GPU runs one engine at a time. Wait until that requirement's worker is gone. */
async function waitForWorkerExit(context: JourneyContext, requirement: string): Promise<void> {
  const scriptPath = join(context.runDir, 'temp', 'worker-exit.ps1');
  await mkdir(join(context.runDir, 'temp'), { recursive: true });
  await writeFile(scriptPath, workerExitScript, 'utf8');
  const powershell = `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const deadline = Date.now() + WORKER_EXIT_MS;
  while (Date.now() < deadline) {
    const result = spawnSync(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-EngineRoot',
        context.engineRoot,
        '-Requirement',
        requirement,
      ],
      { windowsHide: true, stdio: 'ignore', timeout: WINDOWS_SCRIPT_TIMEOUT_MS },
    );
    if (spawnTimedOut(result.error)) {
      throw new JourneyError(`worker-exit.ps1 timed out after ${WINDOWS_SCRIPT_TIMEOUT_MS} ms.`);
    }
    if (result.status === 0) return;
    await delay(2_000);
  }
  throw new JourneyError(`The ${requirement} worker did not release the GPU.`);
}

async function installCaptureRequirement(context: JourneyContext, requirementId: string): Promise<void> {
  const listed = await requestJson(context, 'GET', '/capture-runtime/requirements');
  assertHttp(listed.status, [200]);
  const items = recordOf(listed.body)?.['items'];
  const requirement = Array.isArray(items)
    ? items.map(recordOf).find((item) => textOf(item, 'requirementId') === requirementId)
    : undefined;
  if (!requirement) throw new JourneyError(`${requirementId} was not offered.`);
  if (textOf(requirement, 'status') === 'ready') return;
  const started = await requestJson(
    context,
    'POST',
    '/capture-runtime/installations',
    { requirementId, consent: true },
    { 'X-Idempotency-Key': randomUUID() },
  );
  assertHttp(started.status, [200, 202]);
  const installationId = textOf(recordOf(started.body), 'installationId');
  if (!installationId) throw new JourneyError(`${requirementId} installation did not start.`);
  if (textOf(recordOf(started.body), 'status')?.toLowerCase() === 'completed') return;
  await pollUntil(Date.now() + INSTALL_TIMEOUT_MS, `${requirementId} installation timed out.`, async () => {
    const current = await requestJson(
      context,
      'GET',
      `/capture-runtime/installations/${encodeURIComponent(installationId)}`,
    );
    if (current.status === 404) return 'wait';
    assertHttp(current.status, [200]);
    const status = textOf(recordOf(current.body), 'status')?.toLowerCase() ?? '';
    if (status === 'completed') return 'done';
    if (['failed', 'cancelled', 'canceled', 'manual_action_required'].includes(status)) {
      throw new JourneyError(`${requirementId} installation ${status}.`);
    }
    return 'wait';
  });
}

async function installOllamaModel(context: JourneyContext): Promise<void> {
  const started = await requestJson(context, 'POST', '/llm/installations', { kind: 'ollama_model' });
  assertHttp(started.status, [200, 202]);
  const jobId = textOf(recordOf(started.body), 'id');
  if (!jobId) throw new JourneyError('Ollama model installation did not start.');
  if (textOf(recordOf(started.body), 'status') === 'succeeded') return;
  await pollUntil(Date.now() + INSTALL_TIMEOUT_MS, 'Ollama model installation timed out.', async () => {
    const current = await requestJson(context, 'GET', `/llm/installations/${encodeURIComponent(jobId)}`);
    assertHttp(current.status, [200]);
    const status = textOf(recordOf(current.body), 'status') ?? '';
    if (status === 'succeeded') return 'done';
    if (status === 'failed' || status === 'canceled') throw new JourneyError(`Ollama model installation ${status}.`);
    if (status === 'waiting_for_user') throw new JourneyError('Ollama model installation is waiting for a user.');
    return 'wait';
  });
}

function llmObserved(body: unknown): { readonly server: string | null; readonly verification: string | null; readonly backend: string | null } {
  const device = recordOf(recordOf(body)?.['device']);
  return {
    server: textOf(device, 'server'),
    verification: textOf(device, 'verification'),
    backend: textOf(recordOf(device?.['observed']), 'backend'),
  };
}

function questionVerdictArgs(
  reported: { readonly server: string | null; readonly verification: string | null; readonly backend: string | null },
  preferenceMode: string,
): readonly string[] {
  return [
    '--worker',
    'ollama-runner',
    '--device',
    'cuda',
    '--observed',
    'dedicated-gpu',
    '--vendor',
    'nvidia',
    '--server',
    'owned',
    '--verification',
    'verified',
    '--backend',
    'cuda',
    '--mode',
    'auto',
    '--reported-device',
    reported.backend ?? '',
    '--reported-server',
    reported.server ?? '',
    '--reported-verification',
    reported.verification ?? '',
    '--reported-backend',
    reported.backend ?? '',
    '--reported-mode',
    preferenceMode,
  ];
}

async function provision(context: JourneyContext, page: Page, state: JourneyState): Promise<PhaseBody> {
  const health = await requestJson(context, 'GET', '/health');
  assertHttp(health.status, [200]);
  if (textOf(recordOf(health.body), 'status') !== 'ok') throw new JourneyError('Cert Prep health did not respond.');

  const ready = await requestJson(context, 'GET', '/capture-runtime/ready');
  assertHttp(ready.status, [200]);
  const readyBody = recordOf(ready.body);
  const mismatched = [
    readyBody?.['ready'] === true ? null : 'ready',
    textOf(readyBody, 'runtimeVersion') === context.runtimeVersion ? null : 'runtimeVersion',
    textOf(readyBody, 'apiVersion') === CAPTURE_RUNTIME_API_VERSION ? null : 'apiVersion',
    textOf(readyBody, 'captureDocumentSchemaVersion') === CAPTURE_DOCUMENT_SCHEMA_VERSION
      ? null
      : 'captureDocumentSchemaVersion',
  ].filter((field): field is string => field !== null);
  if (mismatched.length > 0) {
    throw new JourneyError(`Capture Runtime readiness did not match the pinned contract: ${mismatched.join(', ')}.`);
  }

  const adapters = JSON.parse(await readFile(context.adaptersPath, 'utf8')) as unknown;
  const dedicatedNvidia =
    Array.isArray(adapters) &&
    adapters.some((item) => {
      const record = recordOf(item);
      return record?.['adapterClass'] === 'dedicated' && record['vendorId'] === NVIDIA_VENDOR_ID;
    });
  if (!dedicatedNvidia) throw new JourneyError('No dedicated NVIDIA adapter was listed.');

  const preference = await requestJson(context, 'GET', '/llm/device-preference');
  assertHttp(preference.status, [200]);
  if (textOf(recordOf(preference.body), 'mode') !== 'auto') throw new JourneyError('Ollama device preference is not auto.');

  await installCaptureRequirement(context, 'text-recognition');
  // The runtime reports its OCR compute preflight only once the OCR worker is installed.
  const ocrReady = await requestJson(context, 'GET', '/capture-runtime/ready');
  assertHttp(ocrReady.status, [200]);
  const ocr = recordOf(recordOf(ocrReady.body)?.['ocrCompute']);
  const reportedAdapterClass = textOf(ocr, 'adapterClass');
  if (textOf(ocr, 'mode') !== 'gpu' || (reportedAdapterClass !== 'dedicated' && reportedAdapterClass !== 'integrated')) {
    throw new JourneyError(
      `OCR compute preflight is not a GPU adapter: mode ${textOf(ocr, 'mode') ?? 'missing'}, adapter class ${reportedAdapterClass ?? 'missing'}.`,
    );
  }
  const designedAdapterClass = designedOcrAdapterClass(
    Array.isArray(adapters)
      ? adapters.flatMap((item) => {
          const adapterClass = textOf(recordOf(item), 'adapterClass');
          return adapterClass ? [adapterClass] : [];
        })
      : [],
  );
  // The preflight above already rejected any other reported class.
  const reportedClass: 'dedicated' | 'integrated' = reportedAdapterClass === 'integrated' ? 'integrated' : 'dedicated';
  state.ocr = {
    designedAdapterClass,
    reportedAdapterClass: reportedClass,
    observed: designedAdapterClass === 'dedicated' ? 'dedicated-gpu' : 'integrated-gpu',
  };
  await installCaptureRequirement(context, 'speech-recognition');
  await installOllamaModel(context);

  const project = await requestJson(context, 'POST', '/projects', { name: 'Real engines', description: '' });
  assertHttp(project.status, [201]);
  const projectId = textOf(recordOf(project.body), 'id');
  if (!projectId) throw new JourneyError('Project was not created.');
  state.projectId = projectId;
  await page.addInitScript(
    (config) => {
      localStorage.setItem('certPrepApiBaseUrl', config.baseUrl);
      localStorage.setItem('certPrepApiToken', config.token);
      localStorage.setItem('certPrepLastProjectId', config.projectId);
    },
    { baseUrl: context.apiBase, token: context.token, projectId },
  );
  return { passed: true };
}

async function openProjects(page: Page, path: string): Promise<void> {
  await uiStep('The application page did not open.', async () => {
    const projects = page.waitForResponse(
      (response) => {
        if (response.request().method() !== 'GET' || response.status() !== 200) return false;
        try {
          return new URL(response.url()).pathname === '/projects';
        } catch {
          return false;
        }
      },
      { timeout: NAVIGATION_TIMEOUT_MS },
    );
    await page.goto(path);
    await projects;
  });
}

async function storedSource(
  context: JourneyContext,
  projectId: string,
  sourceId: string,
  deadline: number,
  message: string,
): Promise<Record<string, unknown>> {
  let source: Record<string, unknown> | null = null;
  await pollUntil(deadline, message, async () => {
    const current = await requestJson(
      context,
      'GET',
      `/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(sourceId)}`,
    );
    assertHttp(current.status, [200]);
    source = recordOf(current.body);
    const status = textOf(source, 'status');
    if (status === 'ready') return 'done';
    if (status && TERMINAL_SOURCE_FAILURE.includes(status)) throw new JourneyError(message);
    return 'wait';
  });
  if (!source) throw new JourneyError(message);
  return source;
}

async function captureDocument(
  context: JourneyContext,
  page: Page,
  state: JourneyState,
  input: { readonly phase: 'pdf-ocr' | 'image-ocr'; readonly label: 'PDF' | 'Image'; readonly filePath: string },
): Promise<PhaseBody> {
  const plan = state.ocr;
  if (!plan || !state.projectId) throw new JourneyError(`${input.label} capture is incomplete.`);
  const expectedAnchors = await loadAnchors(input.filePath, input.label);
  const deadline = Date.now() + OCR_TIMEOUT_MS;
  let anchors: AnchorCount | undefined;
  let device: DeviceReport | undefined;
  let captureId = '';
  let sourceId = '';
  try {
    await openProjects(page, '/capture');
    await withSamples(
      context,
      input.phase,
      ['--root-pid', context.runtimePid, '--engine-root', context.engineRoot],
      async () => {
        await uiStep(`The capture file input rejected the ${input.label}.`, async () => {
          const file = page.locator('capture-workbench input[type="file"]');
          await file.waitFor({ state: 'attached', timeout: Math.min(60_000, timeLeft(deadline)) });
          const posted = page.waitForResponse(
            (response) => {
              if (response.request().method() !== 'POST') return false;
              try {
                return new URL(response.url()).pathname.endsWith('/capture-reviews');
              } catch {
                return false;
              }
            },
            { timeout: timeLeft(deadline) },
          );
          await file.setInputFiles(input.filePath);
          const response = await posted;
          if (response.status() !== 202 && response.status() !== 200) throw new JourneyError(`HTTP ${response.status()}.`);
          const body = recordOf((await response.json()) as unknown);
          captureId = textOf(body, 'captureId') ?? '';
          sourceId = textOf(body, 'sourceId') ?? '';
          if (!captureId || !sourceId) throw new JourneyError('Capture upload did not return ids.');
        });
        await uiStep(`${input.label} review did not appear.`, async () => {
          await page.getByRole('heading', { name: 'Review capture text', exact: true }).waitFor({ timeout: timeLeft(deadline) });
        });
      },
    );

    let rawText = '';
    await pollUntil(deadline, `${input.label} raw text was not ready.`, async () => {
      const raw = await requestJson(
        context,
        'GET',
        `/projects/${encodeURIComponent(state.projectId)}/capture-reviews/${encodeURIComponent(captureId)}/raw`,
      );
      if (raw.status === 409 || raw.status === 404) return 'wait';
      assertHttp(raw.status, [200]);
      rawText = textOf(recordOf(raw.body), 'sourceText') ?? '';
      return 'done';
    });
    anchors = countAnchors(rawText, expectedAnchors);
    if (anchors.found !== anchors.expected) {
      throw new JourneyError(`${input.label} anchors ${anchors.found}/${anchors.expected}`);
    }

    await waitForWorkerExit(context, 'text-recognition');
    await uiStep(`${input.label} confirm did not finish.`, async () => {
      await page.getByRole('button', { name: 'Confirm capture', exact: true }).click();
      await page.getByRole('heading', { name: 'Capture document saved' }).waitFor({ timeout: timeLeft(deadline) });
    });

    let engine = '';
    let reportedDevice = '';
    await pollUntil(deadline, `${input.label} result was not ready.`, async () => {
      const result = await requestJson(
        context,
        'GET',
        `/projects/${encodeURIComponent(state.projectId)}/capture-reviews/${encodeURIComponent(captureId)}/result`,
      );
      if (result.status === 409 || result.status === 404) return 'wait';
      assertHttp(result.status, [200]);
      const provenance = recordOf(recordOf(result.body)?.['extractionProvenance']);
      engine = textOf(provenance, 'engine') ?? '';
      reportedDevice = textOf(provenance, 'device') ?? '';
      return 'done';
    });

    const source = await storedSource(
      context,
      state.projectId,
      sourceId,
      deadline,
      `${input.label} source was not stored.`,
    );
    const chunks = await requestJson(
      context,
      'GET',
      `/projects/${encodeURIComponent(state.projectId)}/sources/${encodeURIComponent(sourceId)}/chunks`,
    );
    assertHttp(chunks.status, [200]);
    const chunkItems = recordOf(chunks.body)?.['items'];
    const stored =
      textOf(source, 'extraction_method') === 'text_recognition' &&
      (numberOf(source, 'chunks_count') ?? 0) >= 1 &&
      Array.isArray(chunkItems) &&
      chunkItems.length >= 1;
    if (!stored) throw new JourneyError(`${input.label} source was not stored.`);
    if (input.phase === 'pdf-ocr') state.pdfSourceId = sourceId;

    device = deviceVerdict(context, input.phase, [
      '--worker',
      'text-recognition',
      '--device',
      'directml',
      '--observed',
      plan.observed,
      '--adapter-class',
      plan.designedAdapterClass,
      '--reported-device',
      engine === 'text-recognition' ? reportedDevice : '',
      '--reported-adapter',
      plan.reportedAdapterClass,
    ]);
    const provenanceMatches = engine === 'text-recognition' && reportedDevice === 'directml';
    const passed = provenanceMatches && device.verdict === 'pass';
    return {
      passed,
      anchors,
      device,
      ...(passed ? {} : { failure: provenanceMatches ? `${input.label} device ${device.verdict}.` : `${input.label} extraction provenance did not match.` }),
    };
  } catch (error) {
    if (!device) {
      try {
        device = deviceVerdict(context, input.phase, [
          '--worker',
          'text-recognition',
          '--device',
          'directml',
          '--observed',
          plan.observed,
          '--adapter-class',
          plan.designedAdapterClass,
          '--reported-device',
          '',
          '--reported-adapter',
          plan.reportedAdapterClass,
        ]);
      } catch {
        device = undefined;
      }
    }
    const failure = error instanceof JourneyError ? error.message : 'The real-engine journey failed.';
    return { passed: false, failure, ...(anchors ? { anchors } : {}), ...(device ? { device } : {}) };
  }
}

async function transcribe(context: JourneyContext, page: Page, state: JourneyState): Promise<PhaseBody> {
  if (!state.projectId) throw new JourneyError('Recording upload is incomplete.');
  const expectedAnchors = await loadAnchors(context.recordingPath, 'recording');
  const deadline = Date.now() + SPEECH_TIMEOUT_MS;
  let anchors: AnchorCount | undefined;
  let device: DeviceReport | undefined;
  let reportedModel = '';
  let reportedDevice = '';
  try {
    await waitForWorkerExit(context, 'text-recognition');
    await openProjects(page, '/questions');
    let sourceId = '';
    await withSamples(
      context,
      'speech',
      ['--root-pid', context.runtimePid, '--engine-root', context.engineRoot],
      async () => {
        await uiStep('The recording file input rejected the recording.', async () => {
          await page.getByLabel('Source language').selectOption('auto');
          const file = page.locator('#sourceFiles');
          const posted = page.waitForResponse(
            (response) => {
              if (response.request().method() !== 'POST') return false;
              try {
                return /\/projects\/[^/]+\/sources$/u.test(new URL(response.url()).pathname);
              } catch {
                return false;
              }
            },
            { timeout: timeLeft(deadline) },
          );
          await file.setInputFiles(context.recordingPath);
          await page.getByRole('button', { name: 'Upload files', exact: true }).click();
          const response = await posted;
          if (response.status() !== 201 && response.status() !== 202) throw new JourneyError(`HTTP ${response.status()}.`);
          sourceId = textOf(recordOf((await response.json()) as unknown), 'id') ?? '';
          if (!sourceId) throw new JourneyError('Recording upload did not return an id.');
        });
        const source = await storedSource(context, state.projectId, sourceId, deadline, 'Recording did not become ready.');
        reportedModel = textOf(source, 'effective_transcription_model') ?? '';
        reportedDevice = textOf(source, 'transcription_device') ?? '';
        if (textOf(source, 'extraction_method') !== 'transcription') {
          throw new JourneyError('Recording did not become ready.');
        }
      },
    );
    const chunks = await requestJson(
      context,
      'GET',
      `/projects/${encodeURIComponent(state.projectId)}/sources/${encodeURIComponent(sourceId)}/chunks`,
    );
    assertHttp(chunks.status, [200]);
    const items = recordOf(chunks.body)?.['items'];
    const combined = Array.isArray(items)
      ? items
          .map((item) => {
            const record = recordOf(item);
            const raw = textOf(record, 'raw_text') ?? '';
            return normalizeRecognizedText(raw).length > 0 ? raw : (textOf(record, 'text') ?? '');
          })
          .join('\n')
      : '';
    anchors = countAnchors(combined, expectedAnchors);
    if (anchors.found !== anchors.expected) throw new JourneyError(`Recording anchors ${anchors.found}/${anchors.expected}`);
    device = deviceVerdict(context, 'speech', [
      '--worker',
      'speech-recognition',
      '--device',
      'cuda',
      '--observed',
      'dedicated-gpu',
      '--model',
      context.speechModel,
      '--vendor',
      'nvidia',
      '--reported-device',
      reportedDevice,
      '--reported-model',
      reportedModel,
    ]);
    const reportedMatches = reportedDevice === 'cuda' && reportedModel === context.speechModel;
    const passed = reportedMatches && device.verdict === 'pass';
    return {
      passed,
      anchors,
      device,
      ...(passed ? {} : { failure: reportedMatches ? `Speech device ${device.verdict}.` : 'Recording transcription did not match.' }),
    };
  } catch (error) {
    if (!device) {
      try {
        device = deviceVerdict(context, 'speech', [
          '--worker',
          'speech-recognition',
          '--device',
          'cuda',
          '--observed',
          'dedicated-gpu',
          '--model',
          context.speechModel,
          '--vendor',
          'nvidia',
          '--reported-device',
          reportedDevice,
          '--reported-model',
          reportedModel,
        ]);
      } catch {
        device = undefined;
      }
    }
    const failure = error instanceof JourneyError ? error.message : 'The real-engine journey failed.';
    return { passed: false, failure, ...(anchors ? { anchors } : {}), ...(device ? { device } : {}) };
  }
}

async function generateQuestions(context: JourneyContext, state: JourneyState): Promise<PhaseBody> {
  if (!state.projectId || !state.pdfSourceId) throw new JourneyError('Question generation has no PDF source.');
  await waitForWorkerExit(context, 'speech-recognition');
  const before = await requestJson(context, 'GET', '/llm/health');
  assertHttp(before.status, [200]);
  if (llmObserved(before.body).server !== 'owned') throw new JourneyError('Cert Prep does not own the Ollama server.');
  const preference = await requestJson(context, 'GET', '/llm/device-preference');
  assertHttp(preference.status, [200]);
  const mode = textOf(recordOf(preference.body), 'mode') ?? '';
  if (mode !== 'auto') throw new JourneyError('Ollama device preference is not auto.');

  const deadline = Date.now() + QUESTION_TIMEOUT_MS;
  let device: DeviceReport | undefined;
  try {
    await withSamples(context, 'question-generation', ['--ollama-port', context.ollamaPort], async () => {
      const started = await requestJson(
        context,
        'POST',
        `/projects/${encodeURIComponent(state.projectId)}/sources/${encodeURIComponent(state.pdfSourceId)}/question-generations`,
        { limit: 3, strategy: 'hybrid_reasoning' },
      );
      assertHttp(started.status, [202, 200]);
      const operationId = textOf(recordOf(started.body), 'id');
      if (!operationId) throw new JourneyError('Question generation did not start.');
      await pollUntil(deadline, 'Question generation timed out.', async () => {
        const current = await requestJson(
          context,
          'GET',
          `/projects/${encodeURIComponent(state.projectId)}/sources/${encodeURIComponent(state.pdfSourceId)}/question-generations/${encodeURIComponent(operationId)}`,
        );
        assertHttp(current.status, [200]);
        const record = recordOf(current.body);
        const status = textOf(record, 'status');
        if (status === 'succeeded') {
          if ((numberOf(record, 'generated_count') ?? 0) < 1) throw new JourneyError('Question generation produced nothing.');
          if (textOf(record, 'effective_provider') !== 'ollama') throw new JourneyError('Question generation did not use Ollama.');
          if (textOf(record, 'fallback_reason')) throw new JourneyError('Question generation used a fallback.');
          return 'done';
        }
        if (status === 'failed' || status === 'canceled') throw new JourneyError('Question generation did not succeed.');
        return 'wait';
      });
    });
    const after = await requestJson(context, 'GET', '/llm/health');
    assertHttp(after.status, [200]);
    const observed = llmObserved(after.body);
    device = deviceVerdict(context, 'question-generation', questionVerdictArgs(observed, mode));
    const passed = device.verdict === 'pass';
    return { passed, device, ...(passed ? {} : { failure: `Question generation device ${device.verdict}.` }) };
  } catch (error) {
    if (!device) {
      try {
        const after = await requestJson(context, 'GET', '/llm/health');
        const observed = after.status === 200 ? llmObserved(after.body) : { server: null, verification: null, backend: null };
        device = deviceVerdict(context, 'question-generation', questionVerdictArgs(observed, mode));
      } catch {
        device = undefined;
      }
    }
    const failure = error instanceof JourneyError ? error.message : 'The real-engine journey failed.';
    return { passed: false, failure, ...(device ? { device } : {}) };
  }
}

async function runPhase(phases: JourneyPhase[], name: string, body: () => Promise<PhaseBody>): Promise<void> {
  const started = Date.now();
  try {
    const result = await body();
    phases.push({
      phase: name,
      passed: result.passed,
      durationMs: Date.now() - started,
      ...(result.anchors ? { anchors: result.anchors } : {}),
      ...(result.device ? { device: result.device } : {}),
    });
    if (!result.passed) throw new JourneyError(result.failure ?? `${name} failed.`);
  } catch (error) {
    if (!phases.some((phase) => phase.phase === name)) {
      phases.push({ phase: name, passed: false, durationMs: Date.now() - started });
    }
    throw error instanceof JourneyError ? error : new JourneyError('The real-engine journey failed.');
  }
}

export async function runRealEnginesJourney(page: Page): Promise<JourneyReport> {
  const phases: JourneyPhase[] = [];
  let failure: string | undefined;
  try {
    const context = readContext();
    const state: JourneyState = { projectId: '', pdfSourceId: '', ocr: null };
    await runPhase(phases, 'provision', () => provision(context, page, state));
    await runPhase(phases, 'pdf-ocr', () =>
      captureDocument(context, page, state, { phase: 'pdf-ocr', label: 'PDF', filePath: context.pdfPath }),
    );
    await runPhase(phases, 'image-ocr', () =>
      captureDocument(context, page, state, { phase: 'image-ocr', label: 'Image', filePath: context.imagePath }),
    );
    await runPhase(phases, 'speech', () => transcribe(context, page, state));
    await runPhase(phases, 'question-generation', () => generateQuestions(context, state));
  } catch (error) {
    failure = error instanceof JourneyError ? error.message : 'The real-engine journey failed.';
  }
  const passed = failure === undefined && phases.length === 5 && phases.every((phase) => phase.passed);
  const report: JourneyReport = { schemaVersion: 1, passed, phases };
  const runDir = process.env[ENV_RUN];
  if (runDir) {
    await mkdir(runDir, { recursive: true }).catch(() => undefined);
    await writeFile(join(runDir, 'journey.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8').catch(() => undefined);
  }
  if (failure) throw new JourneyError(failure);
  return report;
}
