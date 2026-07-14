import assert from 'node:assert/strict';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import {
  startIsolatedOllama,
  type IsolatedOllamaDependencies,
} from './ollama-isolation.mts';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

test('removes inherited OLLAMA drift and sets the isolated child environment', async () => {
  const fixture = createFixture();
  const child = fakeChild(4101);
  let alive = true;
  let command = '';
  let args: readonly string[] = [];
  let spawnOptions: SpawnOptions | undefined;
  let terminationCount = 0;

  const controller = await startIsolatedOllama(
    {
      ...fixture,
      host: '127.0.0.1:34101',
      timeoutMs: 500,
      env: {
        Path: 'C:\\Windows',
        OLLAMA_HOST: '0.0.0.0:11434',
        ollama_models: 'C:\\polluted-models',
        OLLAMA_DEBUG: '1',
        OLLAMA_KEEP_ALIVE: '99',
        CERT_PREP_RUN_MARKER: 'isolation-test',
      },
    },
    dependencies({
      child,
      fetch: async () => jsonResponse({ models: [] }),
      isAlive: () => alive,
      spawn: (spawnCommand, spawnArgs, options) => {
        command = spawnCommand;
        args = spawnArgs;
        spawnOptions = options;
        return child;
      },
      terminate: () => {
        terminationCount += 1;
        alive = false;
      },
    }),
  );

  assert.equal(command, fixture.ollamaExe);
  assert.deepEqual(args, ['serve']);
  assert.equal(spawnOptions?.windowsHide, true);
  assert.equal(spawnOptions?.stdio, 'ignore');
  assert.equal(spawnOptions?.shell, false);
  assert.equal(spawnOptions?.detached, false);
  assert.equal(spawnOptions?.env?.Path, 'C:\\Windows');
  assert.equal(spawnOptions?.env?.CERT_PREP_RUN_MARKER, 'isolation-test');
  assert.equal(spawnOptions?.env?.OLLAMA_HOST, '127.0.0.1:34101');
  assert.equal(spawnOptions?.env?.OLLAMA_MODELS, fixture.modelsRoot);
  assert.equal(spawnOptions?.env?.OLLAMA_KEEP_ALIVE, '0');
  assert.deepEqual(
    Object.keys(spawnOptions?.env ?? {})
      .filter((key) => key.toUpperCase().startsWith('OLLAMA_'))
      .sort(),
    ['OLLAMA_HOST', 'OLLAMA_KEEP_ALIVE', 'OLLAMA_MODELS'],
  );
  assert.deepEqual(
    {
      pid: controller.pid,
      host: controller.host,
      modelsRoot: controller.modelsRoot,
      startedAt: controller.startedAt,
    },
    {
      pid: 4101,
      host: '127.0.0.1:34101',
      modelsRoot: fixture.modelsRoot,
      startedAt: '2026-07-14T00:00:00.000Z',
    },
  );

  await controller.stop();
  assert.equal(terminationCount, 1);
});

test('fails closed and cleans up when the fresh endpoint reports a preinstalled model', async () => {
  const fixture = createFixture();
  const child = fakeChild(4102);
  let alive = true;
  let terminationCount = 0;

  await assert.rejects(
    startIsolatedOllama(
      {
        ...fixture,
        host: '127.0.0.1:34102',
        timeoutMs: 500,
      },
      dependencies({
        child,
        fetch: async () => jsonResponse({ models: [{ name: 'qwen3.5:4b' }] }),
        isAlive: () => alive,
        terminate: () => {
          terminationCount += 1;
          alive = false;
        },
      }),
    ),
    /reported 1 preinstalled model/,
  );
  assert.equal(terminationCount, 1);
});

test('cleans up the child process tree when startup times out', async () => {
  const fixture = createFixture();
  const child = fakeChild(4103);
  const clock = fakeClock();
  let alive = true;
  let fetchCount = 0;
  let terminationCount = 0;

  await assert.rejects(
    startIsolatedOllama(
      {
        ...fixture,
        host: '127.0.0.1:34103',
        timeoutMs: 250,
      },
      dependencies({
        child,
        fetch: async () => {
          fetchCount += 1;
          throw new Error('connection refused');
        },
        isAlive: () => alive,
        now: clock.now,
        wait: clock.wait,
        terminate: () => {
          terminationCount += 1;
          alive = false;
        },
      }),
    ),
    /did not expose \/api\/tags within 250 ms.*connection refused/,
  );
  assert.ok(fetchCount >= 1);
  assert.equal(terminationCount, 1);
});

test('stop is idempotent across concurrent and repeated calls', async () => {
  const fixture = createFixture();
  const child = fakeChild(4104);
  let alive = true;
  let terminationCount = 0;

  const controller = await startIsolatedOllama(
    {
      ...fixture,
      host: '127.0.0.1:34104',
      timeoutMs: 500,
    },
    dependencies({
      child,
      fetch: async () => jsonResponse({ models: [] }),
      isAlive: () => alive,
      terminate: () => {
        terminationCount += 1;
        alive = false;
      },
    }),
  );

  await Promise.all([controller.stop(), controller.stop(), controller.stop()]);
  await controller.stop();
  assert.equal(terminationCount, 1);
});

test('rejects existing empty and non-empty model roots before spawning', async () => {
  const empty = createFixture();
  mkdirSync(empty.modelsRoot);
  let spawnCount = 0;
  await assert.rejects(
    startIsolatedOllama(
      { ...empty, host: '127.0.0.1:34105', timeoutMs: 500 },
      dependencies({
        child: fakeChild(4105),
        spawn: () => {
          spawnCount += 1;
          return fakeChild(4105);
        },
      }),
    ),
    /must be fresh and must not exist/,
  );

  const nonEmpty = createFixture();
  mkdirSync(nonEmpty.modelsRoot);
  writeFileSync(join(nonEmpty.modelsRoot, 'manifest'), 'preinstalled');
  await assert.rejects(
    startIsolatedOllama(
      { ...nonEmpty, host: '127.0.0.1:34106', timeoutMs: 500 },
      dependencies({ child: fakeChild(4106) }),
    ),
    /models root must be empty/,
  );
  assert.equal(spawnCount, 0);
});

interface DependencyOptions {
  readonly child: ChildProcess;
  readonly fetch?: typeof globalThis.fetch;
  readonly isAlive?: (pid: number) => boolean;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<unknown>;
  readonly spawn?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
  readonly terminate?: (pid: number) => void;
}

function dependencies({
  child,
  fetch = async () => jsonResponse({ models: [] }),
  isAlive = () => true,
  now = () => Date.parse('2026-07-14T00:00:00.000Z'),
  wait = async () => undefined,
  spawn = () => child,
  terminate = () => undefined,
}: DependencyOptions): Partial<IsolatedOllamaDependencies> {
  return {
    spawnOllama: spawn,
    fetch,
    terminateProcessTree: (pid) => {
      terminate(pid);
      return {
        attempted: true,
        method: 'taskkill_process_tree',
        exitCode: 0,
        error: null,
      };
    },
    isProcessAlive: isAlive,
    now,
    wait,
    createAbortSignal: () => undefined,
  };
}

function createFixture(): { ollamaExe: string; modelsRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-ollama-isolation-'));
  temporaryRoots.push(root);
  const ollamaExe = join(root, 'ollama.exe');
  writeFileSync(ollamaExe, 'fixture');
  return { ollamaExe, modelsRoot: join(root, 'models') };
}

function fakeChild(pid: number): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
  }) as unknown as ChildProcess;
}

function fakeClock(): {
  now: () => number;
  wait: (milliseconds: number) => Promise<void>;
} {
  let value = Date.parse('2026-07-14T00:00:00.000Z');
  return {
    now: () => value,
    wait: async (milliseconds) => {
      value += milliseconds;
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
