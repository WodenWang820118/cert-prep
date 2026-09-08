import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  OwnedProjectionProcessManager,
  resolveProjectionInvocation,
} from './capture-projection-process.mts';

const workspaceRoot = process.cwd();

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await delay(25);
    }
  }
  throw new Error(`Timed out waiting for ${path}.`);
}

async function waitForProcessExit(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await withTimeout(
    new Promise<void>((resolve) => child.once('close', () => resolve())),
    timeoutMs,
    `Process ${String(child.pid)} did not exit.`,
  );
}

test('Windows Corepack resolution is shell-free and preserves argument boundaries', () => {
  const invocation = resolveProjectionInvocation(
    'corepack',
    ['pnpm', '--version', '--config.user-agent=token stays an argument'],
    {
      platform: 'win32',
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      path: 'C:\\Program Files\\nodejs',
      corepackScript: 'C:\\Program Files\\nodejs\\node_modules\\corepack\\dist\\corepack.js',
    },
  );

  assert.equal(invocation.command, 'C:\\Program Files\\nodejs\\node.exe');
  assert.deepEqual(invocation.args, [
    'C:\\Program Files\\nodejs\\node_modules\\corepack\\dist\\corepack.js',
    'pnpm',
    '--version',
    '--config.user-agent=token stays an argument',
  ]);
  assert.equal(invocation.shell, false);
  assert.equal(invocation.windowsHide, true);
});

test('production path executes bounded real corepack pnpm --version on this host', async () => {
  const manager = new OwnedProjectionProcessManager();
  const run = manager.run({
    command: 'corepack',
    args: ['pnpm', '--version'],
    cwd: workspaceRoot,
    env: {},
  });

  try {
    await withTimeout(run, 15_000, 'Real corepack pnpm --version probe exceeded its bound.');
  } finally {
    await manager.closeOwnedProcesses();
  }
});

test('cleanup terminates owned descendants while preserving an external baseline process', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'capture-projection-process-'));
  const markerPath = join(tempRoot, 'descendant-pid.txt');
  const baseline = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
    cwd: workspaceRoot,
    windowsHide: true,
    stdio: 'ignore',
  });
  const manager = new OwnedProjectionProcessManager();
  const childScript = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { windowsHide: true, stdio: 'ignore' });`,
    `writeFileSync(${JSON.stringify(markerPath)}, String(child.pid));`,
    'setInterval(() => {}, 1_000);',
  ].join('');
  const run = manager.run({
    command: process.execPath,
    args: ['-e', childScript],
    cwd: workspaceRoot,
    env: {},
  });
  const runResult = run.then(
    () => undefined,
    (error: unknown) => error,
  );

  try {
    const descendantPid = Number(await waitForFile(markerPath));
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
    assert.equal(baseline.exitCode, null);

    assert.equal(await manager.closeOwnedProcesses(), 1);
    const runError = await runResult;
    assert.ok(runError instanceof Error);
    assert.equal(baseline.exitCode, null);

    const descendantExit = await new Promise<boolean>((resolve) => {
      const deadline = Date.now() + 1_000;
      const poll = (): void => {
        try {
          process.kill(descendantPid, 0);
          if (Date.now() < deadline) {
            setTimeout(poll, 25);
          } else {
            resolve(false);
          }
        } catch {
          resolve(true);
        }
      };
      poll();
    });
    assert.equal(descendantExit, true);
  } finally {
    baseline.kill();
    await waitForProcessExit(baseline).catch(() => undefined);
    await manager.closeOwnedProcesses().catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true });
  }
});
