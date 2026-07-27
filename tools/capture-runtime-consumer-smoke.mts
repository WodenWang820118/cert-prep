import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Server } from 'node:http';

import {
  CAPTURE_RUNTIME_FILE,
  CAPTURE_RUNTIME_RELEASE_ASSETS,
  CAPTURE_RUNTIME_VERSION,
  defaultCaptureRuntimeRoot,
  installCaptureRuntime,
  verifyCaptureRuntimeReleaseDirectory,
} from './install-capture-runtime.mts';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const captureWorkbenchRoot = resolve(
  process.env.CAPTURE_WORKBENCH_ROOT ?? join(workspaceRoot, '..', 'capture-workbench'),
);
const releaseRoot = join(captureWorkbenchRoot, 'packages/capture-runtime/dist/release');

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : undefined;
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  if (!port) throw new Error('Could not reserve a loopback port.');
  return port;
}

async function copyTestRelease(destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const name of CAPTURE_RUNTIME_RELEASE_ASSETS) {
    await copyFile(join(releaseRoot, name), join(destination, name));
  }
  const manifestPath = join(destination, 'capture-runtime-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    runtimeRequirements?: { 'windowsml-ocr'?: Record<string, unknown> };
  };
  const descriptor = manifest.runtimeRequirements?.['windowsml-ocr'];
  if (!descriptor) throw new Error('Capture runtime release is missing WindowsML metadata.');
  descriptor.bytes = 123_456;
  descriptor.sha256 = '2'.repeat(64);
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
}

async function startMirror(directory: string): Promise<{
  readonly baseUrl: string;
  readonly server: Server;
}> {
  const server = createServer((request, response) => {
    const name = request.url
      ? new URL(request.url, 'http://127.0.0.1').pathname.split('/').at(-1)
      : undefined;
    if (
      request.method !== 'GET' ||
      !name ||
      !CAPTURE_RUNTIME_RELEASE_ASSETS.includes(name)
    ) {
      response.writeHead(404).end();
      return;
    }
    const stream = createReadStream(join(directory, name));
    stream.once('error', () => response.destroy());
    response.writeHead(200, { Connection: 'close' });
    stream.pipe(response);
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mirror did not expose a port.');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v${CAPTURE_RUNTIME_VERSION}`,
    server,
  };
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
    throw new Error(`Downloaded capture-runtime listener remained on port ${port}.`);
  }
}

async function runBackendConsumer(
  port: number,
  token: string,
): Promise<void> {
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
      throw new Error(`cert-prep host flow failed with exit code ${exitCode}: ${stderr}`);
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
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'cert-prep-capture-runtime-consumer-'));
  let mirror: { baseUrl: string; server: Server } | undefined;
  let runtime: ChildProcess | undefined;
  let runtimePort: number | undefined;
  try {
    const mirrorRoot = join(temporaryRoot, 'mirror');
    const consumerWorkspace = join(temporaryRoot, 'consumer');
    await copyTestRelease(mirrorRoot);
    await verifyCaptureRuntimeReleaseDirectory(mirrorRoot);
    mirror = await startMirror(mirrorRoot);
    await mkdir(consumerWorkspace, { recursive: true });

    const installed = await installCaptureRuntime({
      workspaceRoot: consumerWorkspace,
      baseUrl: mirror.baseUrl,
      outputRoot: defaultCaptureRuntimeRoot(consumerWorkspace),
    });
    const token = `cert-prep-capture-runtime-smoke-${randomUUID()}`;
    runtimePort = await findFreePort();
    const runtimeData = join(temporaryRoot, 'runtime-data');
    await mkdir(runtimeData, { recursive: true });
    runtime = spawn(
      join(installed.outputRoot, CAPTURE_RUNTIME_FILE),
      ['serve', '--host', '127.0.0.1', '--port', String(runtimePort)],
      {
        cwd: installed.outputRoot,
        env: {
          ...process.env,
          CAPTURE_HOST: '127.0.0.1',
          CAPTURE_PORT: String(runtimePort),
          CAPTURE_API_TOKEN: token,
          CAPTURE_ALLOWED_HOSTS: `127.0.0.1:${runtimePort}`,
          CAPTURE_ALLOWED_ORIGINS: '',
          CAPTURE_ENABLE_API_DOCS: 'false',
          CAPTURE_APP_DATA_DIR: runtimeData,
          CAPTURE_EXTRACTION_PROVIDER: 'fake',
          CAPTURE_STRUCTURING_PROVIDER: 'host',
        },
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let runtimeError = '';
    runtime.stderr?.on('data', (chunk) => {
      runtimeError += String(chunk);
    });
    const deadline = Date.now() + 30_000;
    let readinessPassed = false;
    while (Date.now() < deadline) {
      if (runtime.exitCode !== null || runtime.signalCode !== null) {
        throw new Error(`Downloaded capture-runtime exited before readiness: ${runtimeError}`);
      }
      try {
        const unauthorized = await fetch(
          `http://127.0.0.1:${runtimePort}/v1/health/ready`,
          { headers: { Connection: 'close' } },
        );
        if (unauthorized.status !== 401) {
          throw new Error(`Readiness endpoint accepted an unauthenticated request: ${unauthorized.status}`);
        }
        const response = await fetch(
          `http://127.0.0.1:${runtimePort}/v1/health/ready`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Connection: 'close',
            },
            signal: AbortSignal.timeout(1_000),
          },
        );
        if (response.ok) {
          const health = (await response.json()) as {
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
            throw new Error('Downloaded capture-runtime readiness contract mismatch.');
          }
          readinessPassed = true;
          break;
        }
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.includes('accepted an unauthenticated') ||
            error.message.includes('contract mismatch'))
        ) {
          throw error;
        }
      }
      await delay(250);
    }
    if (!readinessPassed) {
      throw new Error(`capture-runtime did not become ready: ${runtimeError}`);
    }
    await runBackendConsumer(runtimePort, token);
    console.log(`cert-prep capture-runtime consumer smoke passed for ${CAPTURE_RUNTIME_VERSION}`);
  } finally {
    if (runtime && runtimePort) await stopRuntime(runtime, runtimePort);
    if (mirror) {
      mirror.server.closeIdleConnections();
      mirror.server.closeAllConnections();
      await new Promise<void>((resolvePromise) => mirror?.server.close(() => resolvePromise()));
    }
    const relativeRoot = relative(resolve(tmpdir()), resolve(temporaryRoot));
    if (
      !relativeRoot ||
      relativeRoot === '..' ||
      relativeRoot.startsWith(`..${sep}`)
    ) {
      throw new Error(`Refusing to remove unexpected smoke path: ${temporaryRoot}`);
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
