import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CAPTURE_RUNTIME_RELEASE_BASE_URL_ENV,
  CAPTURE_RUNTIME_RELEASE_DIRECTORY_ENV,
  CAPTURE_RUNTIME_ROOT_ENV,
  CAPTURE_RUNTIME_FILE,
  CAPTURE_RUNTIME_VERSION,
  DEFAULT_CAPTURE_RUNTIME_RELEASE_BASE_URL,
  installCaptureRuntime,
  verifyCaptureRuntimeReleaseDirectory,
} from './install-capture-runtime.mts';
import { CAPTURE_RUNTIME_RELEASE_BASE_URL } from './capture-runtime-version.mts';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLISHED_RELEASE_BASE_URL = CAPTURE_RUNTIME_RELEASE_BASE_URL;
const EXPECTED_REQUIREMENT_IDS = Object.freeze([
  'windowsml-ocr',
  'whisper-primary',
]);
const FORBIDDEN_RELEASE_OVERRIDES = Object.freeze([
  'CAPTURE_WORKBENCH_ROOT',
  CAPTURE_RUNTIME_RELEASE_BASE_URL_ENV,
  CAPTURE_RUNTIME_ROOT_ENV,
]);

function localReleaseDirectory(): string | undefined {
  const value = process.env[CAPTURE_RUNTIME_RELEASE_DIRECTORY_ENV]?.trim();
  return value || undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  const port =
    typeof address === 'object' && address !== null ? address.port : undefined;
  await new Promise<void>((resolvePromise) =>
    server.close(() => resolvePromise()),
  );
  if (!port) throw new Error('Could not reserve a loopback port.');
  return port;
}

function assertPublishedReleaseInputs(): void {
  const present = FORBIDDEN_RELEASE_OVERRIDES.filter((name) =>
    Object.hasOwn(process.env, name),
  );
  if (present.length > 0) {
    throw new Error(
      `Published-byte smoke refuses release overrides: ${present.join(', ')}.`,
    );
  }
  if (DEFAULT_CAPTURE_RUNTIME_RELEASE_BASE_URL !== PUBLISHED_RELEASE_BASE_URL) {
    throw new Error(
      `Capture Runtime default URL drifted from ${PUBLISHED_RELEASE_BASE_URL}.`,
    );
  }
}

function listeningProcessIds(port: number): number[] {
  if (process.platform !== 'win32') return [];
  const result = spawnSync('netstat', ['-ano', '-p', 'tcp'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) return [];
  const ids = new Set<number>();
  for (const line of result.stdout.split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u);
    if (fields[0] !== 'TCP' || fields[3] !== 'LISTENING') continue;
    if (!fields[1]?.endsWith(`:${port}`)) continue;
    const pid = Number(fields[4]);
    if (Number.isInteger(pid) && pid > 0) ids.add(pid);
  }
  return [...ids];
}

function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 10_000,
    });
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // The process already exited.
    }
  }
}

async function stopRuntime(child: ChildProcess, port: number): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await delay(250);
  const pids = new Set(listeningProcessIds(port));
  if (child.pid) pids.add(child.pid);
  for (const pid of pids) killProcessTree(pid);
  await delay(500);
  if (listeningProcessIds(port).length > 0) {
    throw new Error(
      `Downloaded capture-runtime listener remained on port ${port}.`,
    );
  }
}

function startRuntime(
  runtimeRoot: string,
  port: number,
  token: string,
  dataRoot: string,
  options: { readonly fakeExtraction: boolean },
): ChildProcess {
  const environment = {
    ...process.env,
    CAPTURE_HOST: '127.0.0.1',
    CAPTURE_PORT: String(port),
    CAPTURE_API_TOKEN: token,
    CAPTURE_ALLOWED_HOSTS: `127.0.0.1:${port}`,
    CAPTURE_ALLOWED_ORIGINS: '',
    CAPTURE_ENABLE_API_DOCS: 'false',
    CAPTURE_APP_DATA_DIR: dataRoot,
    CAPTURE_STRUCTURING_PROVIDER: 'host',
  } as NodeJS.ProcessEnv;
  delete environment.CAPTURE_EXTRACTION_PROVIDER;
  if (options.fakeExtraction) environment.CAPTURE_EXTRACTION_PROVIDER = 'fake';
  return spawn(
    join(runtimeRoot, CAPTURE_RUNTIME_FILE),
    ['serve', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: runtimeRoot,
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
}

async function waitForPublishedRuntimeContract(
  runtime: ChildProcess,
  port: number,
  token: string,
): Promise<void> {
  let runtimeError = '';
  runtime.stderr?.on('data', (chunk) => {
    runtimeError += String(chunk);
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (runtime.exitCode !== null || runtime.signalCode !== null) {
      throw new Error(
        `Downloaded capture-runtime exited before readiness: ${runtimeError}`,
      );
    }
    try {
      const baseUrl = `http://127.0.0.1:${port}`;
      const [unauthenticatedReady, unauthenticatedRequirements] =
        await Promise.all([
          fetch(`${baseUrl}/v1/health/ready`, {
            headers: { Connection: 'close' },
          }),
          fetch(`${baseUrl}/v1/runtime/requirements`, {
            headers: { Connection: 'close' },
          }),
        ]);
      if (unauthenticatedReady.status !== 401) {
        throw new Error(
          `Readiness endpoint accepted an unauthenticated request: ${unauthenticatedReady.status}`,
        );
      }
      if (unauthenticatedRequirements.status !== 401) {
        throw new Error(
          `Requirements endpoint accepted an unauthenticated request: ${unauthenticatedRequirements.status}`,
        );
      }
      const headers = {
        Authorization: `Bearer ${token}`,
        Connection: 'close',
      };
      const [readyResponse, requirementsResponse] = await Promise.all([
        fetch(`${baseUrl}/v1/health/ready`, {
          headers,
          signal: AbortSignal.timeout(1_000),
        }),
        fetch(`${baseUrl}/v1/runtime/requirements`, {
          headers,
          signal: AbortSignal.timeout(1_000),
        }),
      ]);
      if (!readyResponse.ok || !requirementsResponse.ok) {
        await delay(250);
        continue;
      }
      const health = (await readyResponse.json()) as {
        service?: unknown;
        runtimeVersion?: unknown;
        apiVersion?: unknown;
        captureDocumentSchemaVersion?: unknown;
        capabilities?: { structuringModes?: unknown };
      };
      if (
        health.service !== 'capture-runtime' ||
        health.runtimeVersion !== CAPTURE_RUNTIME_VERSION ||
        health.apiVersion !== '1.0' ||
        health.captureDocumentSchemaVersion !== '1' ||
        JSON.stringify(health.capabilities?.structuringModes) !== '["host"]'
      ) {
        throw new Error(
          'Downloaded capture-runtime readiness contract mismatch.',
        );
      }
      const requirements = (await requirementsResponse.json()) as {
        items?: unknown;
      };
      if (!Array.isArray(requirements.items)) {
        throw new Error(
          'Downloaded capture-runtime requirements response is invalid.',
        );
      }
      const compactRequirements = requirements.items.map((item) => {
        if (typeof item !== 'object' || item === null) return item;
        const record = item as Record<string, unknown>;
        return {
          requirementId: record.requirementId,
          status: record.status,
          detail: record.detail,
        };
      });
      const requirementIds = compactRequirements.map((item) =>
        typeof item === 'object' && item !== null
          ? (item as { requirementId?: unknown }).requirementId
          : undefined,
      );
      if (
        JSON.stringify(requirementIds) !==
          JSON.stringify(EXPECTED_REQUIREMENT_IDS) ||
        compactRequirements.some(
          (item) =>
            typeof item !== 'object' ||
            item === null ||
            ![
              'ready',
              'missing',
              'installable',
              'manual_action_required',
              'unavailable',
            ].includes(String((item as { status?: unknown }).status)),
        )
      ) {
        throw new Error(
          `Downloaded capture-runtime requirements contract mismatch: ${JSON.stringify(compactRequirements)}.`,
        );
      }
      return;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes('accepted an unauthenticated') ||
          error.message.includes('contract mismatch') ||
          error.message.includes('response is invalid'))
      ) {
        throw error;
      }
    }
    await delay(250);
  }
  throw new Error(`capture-runtime did not become ready: ${runtimeError}`);
}

async function runBackendConsumer(port: number, token: string): Promise<void> {
  const child = spawn(
    'uv',
    [
      'run',
      '--project',
      'apps/cert-prep-backend',
      'python',
      'tools/capture-runtime-host-flow-smoke.py',
    ],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        PYTHONPATH: join(workspaceRoot, 'apps/cert-prep-backend/src'),
        CERT_PREP_CAPTURE_RUNTIME_URL: `http://127.0.0.1:${port}`,
        CERT_PREP_CAPTURE_RUNTIME_TOKEN: token,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  try {
    const exitCode = await new Promise<number>((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        if (child.pid) killProcessTree(child.pid);
        reject(new Error('cert-prep host flow timed out after 60 seconds.'));
      }, 60_000);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        resolvePromise(code ?? 1);
      });
    });
    if (exitCode !== 0) {
      throw new Error(
        `cert-prep host flow failed with exit code ${exitCode}: ${stderr}`,
      );
    }
  } catch (error) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      killProcessTree(child.pid);
    }
    throw error;
  }
}

async function runSmoke(): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('capture-runtime consumer smoke requires Windows x64.');
  }
  const releaseDirectory = localReleaseDirectory();
  if (!releaseDirectory) assertPublishedReleaseInputs();
  else if (Object.hasOwn(process.env, CAPTURE_RUNTIME_RELEASE_BASE_URL_ENV)) {
    throw new Error(
      `Local release smoke refuses ${CAPTURE_RUNTIME_RELEASE_BASE_URL_ENV}; use only ${CAPTURE_RUNTIME_RELEASE_DIRECTORY_ENV}.`,
    );
  }
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), 'cert-prep-capture-runtime-consumer-'),
  );
  let runtime: ChildProcess | undefined;
  let runtimePort: number | undefined;
  try {
    const consumerWorkspace = join(temporaryRoot, 'consumer');
    await mkdir(consumerWorkspace, { recursive: true });

    const installed = await installCaptureRuntime({
      workspaceRoot: consumerWorkspace,
      releaseDirectory,
    });
    const manifest = await verifyCaptureRuntimeReleaseDirectory(
      installed.outputRoot,
    );
    if (manifest.runtimeVersion !== CAPTURE_RUNTIME_VERSION) {
      throw new Error('Downloaded capture-runtime manifest version mismatch.');
    }
    const token = `cert-prep-capture-runtime-smoke-${randomUUID()}`;
    runtimePort = await findFreePort();
    const runtimeData = join(temporaryRoot, 'runtime-data-published-release');
    await mkdir(runtimeData, { recursive: true });
    runtime = startRuntime(
      installed.outputRoot,
      runtimePort,
      token,
      runtimeData,
      { fakeExtraction: false },
    );
    await waitForPublishedRuntimeContract(runtime, runtimePort, token);
    await stopRuntime(runtime, runtimePort);
    runtime = undefined;
    runtimePort = await findFreePort();
    const fakeRuntimeData = join(temporaryRoot, 'runtime-data-fake-protocol');
    await mkdir(fakeRuntimeData, { recursive: true });
    runtime = startRuntime(
      installed.outputRoot,
      runtimePort,
      token,
      fakeRuntimeData,
      { fakeExtraction: true },
    );
    await waitForPublishedRuntimeContract(runtime, runtimePort, token);
    await runBackendConsumer(runtimePort, token);
    console.log(
      `cert-prep ${releaseDirectory ? 'local' : 'published'} capture-runtime@${CAPTURE_RUNTIME_VERSION} handshake passed; fake extraction host protocol passed (not OCR/STT evidence).`,
    );
  } finally {
    if (runtime && runtimePort) await stopRuntime(runtime, runtimePort);
    const relativeRoot = relative(resolve(tmpdir()), resolve(temporaryRoot));
    if (
      !relativeRoot ||
      relativeRoot === '..' ||
      relativeRoot.startsWith(`..${sep}`)
    ) {
      throw new Error(
        `Refusing to remove unexpected smoke path: ${temporaryRoot}`,
      );
    }
    await rm(temporaryRoot, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runSmoke().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
