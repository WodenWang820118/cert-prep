import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { terminateProcessTreeByPid } from '../process-lifecycle/processes.mts';

const OLLAMA_TAGS_PATH = '/api/tags';
const POLL_INTERVAL_MS = 100;

type ProcessTerminationResult = ReturnType<typeof terminateProcessTreeByPid>;

export interface IsolatedOllamaOptions {
  readonly ollamaExe: string;
  readonly modelsRoot: string;
  readonly host: string;
  readonly timeoutMs: number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface IsolatedOllamaController {
  readonly pid: number;
  readonly host: string;
  readonly modelsRoot: string;
  readonly startedAt: string;
  stop(): Promise<void>;
}

export interface IsolatedOllamaDependencies {
  readonly spawnOllama: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
  readonly fetch: typeof globalThis.fetch;
  readonly terminateProcessTree: (pid: number) => ProcessTerminationResult;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly now: () => number;
  readonly wait: (milliseconds: number) => Promise<unknown>;
  readonly createAbortSignal: (timeoutMs: number) => AbortSignal | undefined;
}

const DEFAULT_DEPENDENCIES: IsolatedOllamaDependencies = {
  spawnOllama: (command, args, options) =>
    spawn(command, [...args], options),
  fetch: globalThis.fetch,
  terminateProcessTree: terminateProcessTreeByPid,
  isProcessAlive,
  now: Date.now,
  wait: delay,
  createAbortSignal: (timeoutMs) => AbortSignal.timeout(timeoutMs),
};

/** Starts a candidate-bundled Ollama server against a provably fresh model root. */
export async function startIsolatedOllama(
  options: IsolatedOllamaOptions,
  overrides: Partial<IsolatedOllamaDependencies> = {},
): Promise<IsolatedOllamaController> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const timeoutMs = requireTimeout(options.timeoutMs);
  const host = requireLoopbackHost(options.host);
  const ollamaExe = requireCanonicalOllamaExecutable(options.ollamaExe);
  const modelsRoot = createFreshModelsRoot(options.modelsRoot);
  const startedAtMs = dependencies.now();
  const startedAt = new Date(startedAtMs).toISOString();
  let child: ChildProcess | null = null;
  let childError: Error | null = null;

  try {
    child = dependencies.spawnOllama(ollamaExe, ['serve'], {
      cwd: dirname(ollamaExe),
      env: buildIsolatedEnvironment(options.env ?? process.env, host, modelsRoot),
      windowsHide: true,
      stdio: 'ignore',
      shell: false,
      detached: false,
    });
    child.once('error', (error) => {
      childError = error;
    });
    const pid = requireChildPid(child.pid);
    await waitForEmptyModels(
      child,
      pid,
      childErrorView(() => childError),
      host,
      timeoutMs,
      dependencies,
    );

    let stopPromise: Promise<void> | null = null;
    return {
      pid,
      host,
      modelsRoot,
      startedAt,
      stop: () => {
        stopPromise ??= stopAndVerify(child as ChildProcess, pid, timeoutMs, dependencies);
        return stopPromise;
      },
    };
  } catch (startupError) {
    const pid = child?.pid;
    if (child && pid !== undefined && Number.isSafeInteger(pid) && pid > 0) {
      try {
        await stopAndVerify(child, pid, timeoutMs, dependencies);
      } catch (cleanupError) {
        throw new AggregateError(
          [startupError, cleanupError],
          'Isolated Ollama startup failed and its process tree could not be cleaned up.',
        );
      }
    }
    throw startupError;
  }
}

function buildIsolatedEnvironment(
  inherited: NodeJS.ProcessEnv,
  host: string,
  modelsRoot: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (!key.toUpperCase().startsWith('OLLAMA_')) {
      env[key] = value;
    }
  }
  env.OLLAMA_HOST = host;
  env.OLLAMA_MODELS = modelsRoot;
  env.OLLAMA_KEEP_ALIVE = '0';
  return env;
}

async function waitForEmptyModels(
  child: ChildProcess,
  pid: number,
  childError: () => Error | null,
  host: string,
  timeoutMs: number,
  dependencies: IsolatedOllamaDependencies,
): Promise<void> {
  const deadline = dependencies.now() + timeoutMs;
  let lastConnectionError: unknown = null;

  while (true) {
    assertChildRunning(child, pid, childError(), dependencies);
    const remainingMs = deadline - dependencies.now();
    if (remainingMs <= 0) {
      const detail = lastConnectionError
        ? ` Last connection error: ${errorMessage(lastConnectionError)}`
        : '';
      throw new Error(
        `Isolated Ollama did not expose ${OLLAMA_TAGS_PATH} within ${timeoutMs} ms.${detail}`,
      );
    }

    let response: Response;
    try {
      response = await dependencies.fetch(`http://${host}${OLLAMA_TAGS_PATH}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: dependencies.createAbortSignal(Math.max(1, remainingMs)),
      });
    } catch (error) {
      lastConnectionError = error;
      await waitForNextPoll(deadline, dependencies);
      continue;
    }

    if (response.status !== 200) {
      throw new Error(
        `Isolated Ollama ${OLLAMA_TAGS_PATH} returned HTTP ${response.status}; expected 200 JSON.`,
      );
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('application/json')) {
      throw new Error(
        `Isolated Ollama ${OLLAMA_TAGS_PATH} did not return application/json.`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new Error(
        `Isolated Ollama ${OLLAMA_TAGS_PATH} returned invalid JSON: ${errorMessage(error)}`,
      );
    }
    if (!isJsonObject(body) || !Array.isArray(body.models)) {
      throw new Error(
        `Isolated Ollama ${OLLAMA_TAGS_PATH} JSON must contain a models array.`,
      );
    }
    if (body.models.length !== 0) {
      throw new Error(
        `Isolated Ollama reported ${body.models.length} preinstalled model(s); the acceptance run requires an empty model store.`,
      );
    }
    return;
  }
}

async function stopAndVerify(
  child: ChildProcess,
  pid: number,
  timeoutMs: number,
  dependencies: IsolatedOllamaDependencies,
): Promise<void> {
  let termination: ProcessTerminationResult | null = null;
  let terminationError: unknown = null;
  if (!childHasExited(child) && dependencies.isProcessAlive(pid)) {
    try {
      termination = dependencies.terminateProcessTree(pid);
    } catch (error) {
      terminationError = error;
    }
  }

  const deadline = dependencies.now() + timeoutMs;
  while (!childHasExited(child) && dependencies.isProcessAlive(pid)) {
    const remainingMs = deadline - dependencies.now();
    if (remainingMs <= 0) {
      const detail = terminationError
        ? errorMessage(terminationError)
        : termination?.error ?? 'process remained alive';
      throw new Error(
        `Isolated Ollama process tree ${pid} did not exit within ${timeoutMs} ms: ${detail}`,
      );
    }
    await dependencies.wait(Math.min(POLL_INTERVAL_MS, remainingMs));
  }
}

function assertChildRunning(
  child: ChildProcess,
  pid: number,
  childError: Error | null,
  dependencies: IsolatedOllamaDependencies,
): void {
  if (childError) {
    throw new Error(`Isolated Ollama failed to start: ${childError.message}`);
  }
  if (childHasExited(child) || !dependencies.isProcessAlive(pid)) {
    throw new Error(
      `Isolated Ollama exited before readiness (code=${child.exitCode ?? 'none'}, signal=${child.signalCode ?? 'none'}).`,
    );
  }
}

async function waitForNextPoll(
  deadline: number,
  dependencies: IsolatedOllamaDependencies,
): Promise<void> {
  const remainingMs = deadline - dependencies.now();
  if (remainingMs > 0) {
    await dependencies.wait(Math.min(POLL_INTERVAL_MS, remainingMs));
  }
}

function requireCanonicalOllamaExecutable(path: string): string {
  if (!isAbsolute(path) || basename(path).toLowerCase() !== 'ollama.exe') {
    throw new Error('Ollama executable must be an absolute path to ollama.exe.');
  }
  if (!existsSync(path)) {
    throw new Error(`Ollama executable does not exist: ${path}`);
  }
  const stat = lstatSync(path);
  const canonicalPath = realpathSync.native(path);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    !samePath(canonicalPath, resolve(path))
  ) {
    throw new Error(
      `Ollama executable must be a canonical non-symlink file: ${path}`,
    );
  }
  return canonicalPath;
}

function createFreshModelsRoot(path: string): string {
  if (!isAbsolute(path)) {
    throw new Error('Ollama models root must be an absolute path.');
  }
  const requestedPath = resolve(path);
  if (existsSync(requestedPath)) {
    const stat = lstatSync(requestedPath);
    const canonicalPath = realpathSync.native(requestedPath);
    if (stat.isSymbolicLink() || !samePath(canonicalPath, requestedPath)) {
      throw new Error(
        `Ollama models root must not be a symlink or reparse point: ${requestedPath}`,
      );
    }
    if (stat.isDirectory() && readdirSync(requestedPath).length > 0) {
      throw new Error(`Ollama models root must be empty: ${requestedPath}`);
    }
    throw new Error(
      `Ollama models root must be fresh and must not exist before startup: ${requestedPath}`,
    );
  }

  const parent = dirname(requestedPath);
  if (!existsSync(parent)) {
    throw new Error(`Ollama models root parent does not exist: ${parent}`);
  }
  const parentStat = lstatSync(parent);
  const canonicalParent = realpathSync.native(parent);
  if (
    parentStat.isSymbolicLink() ||
    !parentStat.isDirectory() ||
    !samePath(canonicalParent, resolve(parent))
  ) {
    throw new Error(
      `Ollama models root parent must be a canonical non-reparse directory: ${parent}`,
    );
  }

  mkdirSync(requestedPath);
  const createdStat = lstatSync(requestedPath);
  const canonicalPath = realpathSync.native(requestedPath);
  if (
    createdStat.isSymbolicLink() ||
    !createdStat.isDirectory() ||
    !samePath(canonicalPath, requestedPath) ||
    readdirSync(canonicalPath).length !== 0
  ) {
    throw new Error(
      `Ollama models root was not created as a fresh canonical directory: ${requestedPath}`,
    );
  }
  return canonicalPath;
}

function requireLoopbackHost(host: string): string {
  const match = /^127\.0\.0\.1:([1-9]\d{0,4})$/.exec(host);
  const port = match ? Number(match[1]) : 0;
  if (!match || port > 65_535) {
    throw new Error('Ollama host must be 127.0.0.1:<port> with a valid TCP port.');
  }
  return host;
}

function requireTimeout(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Ollama startup timeout must be a positive integer.');
  }
  return timeoutMs;
}

function requireChildPid(pid: number | undefined): number {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('Isolated Ollama did not report a valid child PID.');
  }
  return pid;
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function childErrorView(read: () => Error | null): () => Error | null {
  return read;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ESRCH'
    );
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
