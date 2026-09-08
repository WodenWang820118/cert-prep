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
import type {
  AcceptanceRuntimeIdentityExpectation,
  InstalledRuntimeTupleAttestation,
  OcrPreflightMetrics,
  SmokeRunState,
} from './types.mts';
import { isRecord } from './text-utils.mts';

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

  // A fresh runtime has no OCR worker installed yet, so its authenticated
  // readiness response is intentionally `ocrCompute: null`. Install the
  // explicitly consented worker before waiting for the custom element: the
  // element is gated on the same preflight and otherwise the cold-start flow
  // would wait forever without ever reaching the requirement consent step.
  const projectIdBeforeRequirement = run.projectApi?.projectId;
  if (!projectIdBeforeRequirement) {
    throw new Error(
      'Capture Runtime requirement installation requires a captured project API.',
    );
  }
  run.projectApi = await captureProjectApiAfterRestart(
    page,
    projectIdBeforeRequirement,
    120_000,
  );
  await ensureCaptureRuntimeRequirement(run, 'windowsml-ocr');

  // Requirement installation changes sidecar state but does not reload the
  // Angular preflight store. Reconnect through a fresh page so the visible UI
  // gate is observed after, rather than before, the worker installation.
  const projectIdAfterRequirement = run.projectApi.projectId;
  run.projectApi = await captureProjectApiAfterRestart(
    page,
    projectIdAfterRequirement,
    120_000,
  );
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
  await assertAcceptanceOcrPreflight(run);
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

/**
 * Capture the authenticated runtime decision and the visible UI gate before
 * a source input can be imported. The backend endpoint is the authority for
 * contract/worker identity; the DOM check proves the host surfaced the same
 * GPU decision before the picker/upload boundary.
 */
export async function assertAcceptanceOcrPreflight(
  run: SmokeRunState,
): Promise<OcrPreflightMetrics | undefined> {
  const expected = run.options.acceptanceRuntimeIdentity;
  if (!expected) return undefined;
  const projectApi = run.projectApi;
  if (!projectApi) {
    throw new Error('Acceptance OCR preflight requires a captured project API.');
  }
  const response = await activePage(run).request.get(
    `${projectApi.apiBaseUrl}/capture-runtime/ready`,
    {
      headers: { Authorization: projectApi.authorization },
      timeout: 30_000,
    },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok()) {
    throw new Error(
      `Authenticated Capture Runtime preflight returned HTTP ${response.status()}.`,
    );
  }
  const metrics = parseAcceptanceOcrPreflight(payload, expected);
  const attestationResponse = await activePage(run).request.get(
    `${projectApi.apiBaseUrl}/capture-runtime/provenance`,
    {
      headers: { Authorization: projectApi.authorization },
      timeout: 30_000,
    },
  );
  const attestationPayload = await attestationResponse.json().catch(() => null);
  if (!attestationResponse.ok()) {
    throw new Error(
      `Authenticated installed-app runtime attestation returned HTTP ${attestationResponse.status()}.`,
    );
  }
  const runtimeAttestation = parseInstalledRuntimeTupleAttestation(
    attestationPayload,
    expected,
  );
  const page = activePage(run);
  const status = page.getByTestId('ocr-compute-status');
  const uiGpuBeforeImport =
    expected.preflightMode === 'gpu-dml' &&
    (await status.isVisible().catch(() => false)) &&
    /directml/i.test((await status.textContent().catch(() => '')) ?? '');
  const sourceInput = page.locator('capture-workbench input[type="file"]').first();
  const sourceImportEnabled = await sourceInput.isEnabled().catch(() => false);
  if (!uiGpuBeforeImport || !sourceImportEnabled) {
    throw new Error(
      'Cert Prep UI did not expose authenticated GPU OCR readiness before source import.',
    );
  }
  const observed: OcrPreflightMetrics = {
    ...metrics,
    ui_gpu_before_import: uiGpuBeforeImport,
    source_import_enabled: sourceImportEnabled,
  };
  run.metrics.ocr_preflight = observed;
  run.metrics.runtime_attestation = runtimeAttestation;
  run.metrics.observations.push(
    `Authenticated OCR preflight=${observed.mode}; UI GPU before import=${String(observed.ui_gpu_before_import)}.`,
  );
  return observed;
}

/**
 * Validate the hash-only tuple emitted by the running packaged backend. The
 * expected installed fields are supplied by the acceptance harness after it
 * re-hashed the executable and adjacent resources from the exact app under
 * test; build directories and old manifests cannot satisfy this comparison.
 */
export function parseInstalledRuntimeTupleAttestation(
  payload: unknown,
  expected: AcceptanceRuntimeIdentityExpectation,
): InstalledRuntimeTupleAttestation {
  if (!isRecord(payload) || payload.schema_version !== 1) {
    throw new Error('Installed-app runtime attestation schema was invalid.');
  }
  const candidate = payload.candidate;
  const observed = payload.observed;
  if (!isRecord(candidate) || !isRecord(observed)) {
    throw new Error('Installed-app runtime attestation omitted candidate or observed fields.');
  }
  const candidateFields = {
    runtime_version: requiredString(candidate.runtime_version, 'candidate.runtime_version'),
    runtime_core_sha256: requiredSha256(
      candidate.runtime_core_sha256,
      'candidate.runtime_core_sha256',
    ),
    runtime_core_bytes: requiredPositiveInteger(
      candidate.runtime_core_bytes,
      'candidate.runtime_core_bytes',
    ),
    runtime_manifest_identity_sha256: requiredSha256(
      candidate.runtime_manifest_identity_sha256,
      'candidate.runtime_manifest_identity_sha256',
    ),
    worker_archive_sha256: requiredSha256(
      candidate.worker_archive_sha256,
      'candidate.worker_archive_sha256',
    ),
    worker_archive_bytes: requiredPositiveInteger(
      candidate.worker_archive_bytes,
      'candidate.worker_archive_bytes',
    ),
    worker_executable_sha256: requiredSha256(
      candidate.worker_executable_sha256,
      'candidate.worker_executable_sha256',
    ),
    contract_set_sha256: requiredSha256(
      candidate.contract_set_sha256,
      'candidate.contract_set_sha256',
    ),
  };
  if (
    candidateFields.runtime_core_sha256 !== expected.runtimeArtifactSha256 ||
    candidateFields.worker_archive_sha256 !== expected.workerArchiveSha256 ||
    candidateFields.worker_executable_sha256 !== expected.workerExecutableSha256 ||
    candidateFields.contract_set_sha256 !== expected.contractSetSha256 ||
    (expected.installedRuntimeCoreSha256 !== undefined &&
      candidateFields.runtime_core_sha256 !== expected.installedRuntimeCoreSha256) ||
    (expected.installedRuntimeCoreBytes !== undefined &&
      candidateFields.runtime_core_bytes !== expected.installedRuntimeCoreBytes) ||
    (expected.installedRuntimeManifestIdentitySha256 !== undefined &&
      candidateFields.runtime_manifest_identity_sha256 !==
        expected.installedRuntimeManifestIdentitySha256)
  ) {
    throw new Error(
      'Installed-app runtime attestation candidate tuple did not match the exact Phase 1 and installed identities.',
    );
  }

  const wheel = candidate.python_wheel;
  if (!isRecord(wheel)) {
    throw new Error('Installed-app runtime attestation omitted Python wheel provenance.');
  }
  const generatedModels = wheel.generated_models;
  if (
    typeof wheel.file_name !== 'string' ||
    !/^capture[_-]runtime[_-]client-0\.4\.2-[A-Za-z0-9._-]+\.whl$/u.test(
      wheel.file_name,
    ) ||
    !isRecord(generatedModels) ||
    generatedModels.worker_sha256 !== true ||
    generatedModels.pdf_page_numbers !== true ||
    wheel.package_name !== 'capture-runtime-client' ||
    wheel.package_version !== '0.4.2' ||
    requiredSha256(wheel.sha256, 'candidate.python_wheel.sha256') === '' ||
    requiredPositiveInteger(wheel.bytes, 'candidate.python_wheel.bytes') !== wheel.bytes ||
    requiredSha256(wheel.contract_set_sha256, 'candidate.python_wheel.contract_set_sha256') !==
      expected.contractSetSha256
  ) {
    throw new Error('Installed-app runtime attestation Python wheel identity was invalid.');
  }

  if (
    observed.ready !== true ||
    observed.runtime_version !== candidateFields.runtime_version ||
    observed.api_version !== '2.0' ||
    observed.capture_document_schema_version !== '2' ||
    observed.mode !== expected.preflightMode ||
    observed.contract_set_sha256 !== candidateFields.contract_set_sha256 ||
    observed.worker_executable_sha256 !== candidateFields.worker_executable_sha256
  ) {
    throw new Error('Installed-app runtime attestation live handshake did not match its candidate tuple.');
  }

  return {
    schema_version: 1,
    candidate: {
      ...candidateFields,
      python_wheel: {
        file_name: wheel.file_name,
        sha256: requiredSha256(wheel.sha256, 'candidate.python_wheel.sha256'),
        bytes: requiredPositiveInteger(wheel.bytes, 'candidate.python_wheel.bytes'),
        package_name: 'capture-runtime-client',
        package_version: '0.4.2',
        contract_set_sha256: requiredSha256(
          wheel.contract_set_sha256,
          'candidate.python_wheel.contract_set_sha256',
        ),
        generated_models: { worker_sha256: true, pdf_page_numbers: true },
      },
    },
    observed: {
      ready: true,
      runtime_version: observed.runtime_version,
      api_version: '2.0',
      capture_document_schema_version: '2',
      contract_set_sha256: candidateFields.contract_set_sha256,
      worker_executable_sha256: candidateFields.worker_executable_sha256,
      mode: expected.preflightMode,
    },
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Installed-app runtime attestation ${label} was invalid.`);
  }
  return value.trim();
}

function requiredSha256(value: unknown, label: string): string {
  const digest = requiredString(value, label).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error(`Installed-app runtime attestation ${label} was invalid.`);
  }
  return digest;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new Error(`Installed-app runtime attestation ${label} was invalid.`);
  }
  return value;
}

export function parseAcceptanceOcrPreflight(
  payload: unknown,
  expected: AcceptanceRuntimeIdentityExpectation,
): OcrPreflightMetrics {
  if (!isRecord(payload) || payload.ready !== true) {
    throw new Error('Authenticated Capture Runtime readiness payload was invalid.');
  }
  const compute = payload.ocrCompute ?? payload.ocr_compute;
  if (!isRecord(compute)) {
    throw new Error('Authenticated Capture Runtime readiness omitted OCR compute preflight.');
  }
  const mode = compute.mode;
  if (mode !== 'gpu-dml' && mode !== 'cpu-fallback') {
    throw new Error('Authenticated Capture Runtime OCR preflight mode was invalid.');
  }
  const contractSha256 =
    typeof compute.contractSha256 === 'string'
      ? compute.contractSha256
      : typeof compute.contract_sha256 === 'string'
        ? compute.contract_sha256
        : '';
  const workerSha256 =
    typeof compute.workerSha256 === 'string'
      ? compute.workerSha256
      : typeof compute.worker_sha256 === 'string'
        ? compute.worker_sha256
        : null;
  if (!/^[a-f0-9]{64}$/u.test(contractSha256)) {
    throw new Error('Authenticated Capture Runtime OCR contract SHA was invalid.');
  }
  if (workerSha256 !== null && !/^[a-f0-9]{64}$/u.test(workerSha256)) {
    throw new Error('Authenticated Capture Runtime OCR worker SHA was invalid.');
  }
  if (mode !== expected.preflightMode) {
    if (mode === 'cpu-fallback') {
      throw new Error(
        'Authenticated Capture Runtime selected CPU fallback; GPU/DML acceptance is unavailable.',
      );
    }
    throw new Error(
      `Authenticated Capture Runtime OCR preflight expected ${expected.preflightMode} but received ${mode}.`,
    );
  }
  if (contractSha256 !== expected.contractSetSha256) {
    throw new Error(
      'Authenticated Capture Runtime OCR contract SHA does not match the Phase 1 candidate.',
    );
  }
  if (workerSha256 !== expected.workerExecutableSha256) {
    throw new Error(
      'Authenticated Capture Runtime OCR worker SHA does not match the Phase 1 candidate.',
    );
  }
  return {
    mode,
    contract_sha256: contractSha256,
    worker_sha256: workerSha256,
    ui_gpu_before_import: false,
    source_import_enabled: false,
  };
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
