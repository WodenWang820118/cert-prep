import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  captureRuntimeInstallationCompleted,
  pythonRuntimeReadyPattern,
  pythonRuntimeStartupState,
  waitForCaptureRuntimeRunning,
} from './runtime-install-flow.mts';

function statusReader(statuses: readonly Record<string, unknown>[]) {
  const commands: string[] = [];
  let index = 0;
  const invoke = async (command: string): Promise<unknown> => {
    commands.push(command);
    const status = statuses[Math.min(index, statuses.length - 1)];
    index += 1;
    return status;
  };
  return { commands, invoke };
}

test('the Start wait ends when Capture Runtime reports running and never starts it again', async () => {
  const reader = statusReader([
    { status: 'starting', detail: 'Starting Capture Runtime.' },
    { status: 'running', detail: 'Capture Runtime is running.' },
  ]);

  await waitForCaptureRuntimeRunning(reader.invoke, { intervalMs: 1 });

  assert.deepEqual(reader.commands, ['capture_runtime_status', 'capture_runtime_status']);
});

test('a failed Capture Runtime status fails the Start wait at once with its reason', async () => {
  const reader = statusReader([
    {
      status: 'failed',
      detail: 'Backend candidate did not become ready.',
      unavailable_reason: 'capture_runtime_failed',
    },
    { status: 'running' },
  ]);

  await assert.rejects(
    waitForCaptureRuntimeRunning(reader.invoke, { intervalMs: 1 }),
    /Capture Runtime Start failed: Backend candidate did not become ready\.; capture_runtime_failed/,
  );
  assert.deepEqual(reader.commands, ['capture_runtime_status']);
});

test('a status call that stays pending ends at the Start deadline with the last status', async () => {
  const commands: string[] = [];
  const timeouts: number[] = [];
  let calls = 0;
  const invoke = (command: string, timeoutMs: number): Promise<unknown> => {
    commands.push(command);
    timeouts.push(timeoutMs);
    calls += 1;
    // The host answers once, then blocks on its ownership lock during Start.
    return calls === 1
      ? Promise.resolve({ status: 'starting' })
      : new Promise(() => undefined);
  };
  const startedAt = Date.now();

  await assert.rejects(
    waitForCaptureRuntimeRunning(invoke, { timeoutMs: 50, intervalMs: 1 }),
    /last status was starting/,
  );

  assert.ok(Date.now() - startedAt < 1_000);
  assert.deepEqual(commands, ['capture_runtime_status', 'capture_runtime_status']);
  assert.ok(timeouts.every((timeoutMs) => timeoutMs > 0 && timeoutMs <= 50));
});

test('a failed status read is reported with the timeout', async () => {
  const invoke = async (): Promise<unknown> => {
    throw new Error('Tauri command timed out.');
  };

  await assert.rejects(
    waitForCaptureRuntimeRunning(invoke, { timeoutMs: 5, intervalMs: 1 }),
    /last status was unknown; last status read failed: Tauri command timed out\./,
  );
});

test('the Start wait times out naming the last status', async () => {
  const reader = statusReader([{ status: 'starting' }]);

  await assert.rejects(
    waitForCaptureRuntimeRunning(reader.invoke, { timeoutMs: 5, intervalMs: 1 }),
    /last status was starting/,
  );
  assert.ok(reader.commands.every((command) => command === 'capture_runtime_status'));
});

test('Capture Runtime installation accepts its completed terminal status', () => {
  assert.equal(captureRuntimeInstallationCompleted('completed'), true);
  assert.equal(captureRuntimeInstallationCompleted('succeeded'), true);
  assert.equal(captureRuntimeInstallationCompleted('running'), false);
  assert.equal(captureRuntimeInstallationCompleted(null), false);
});

test('python runtime readiness requires a backend-ready detail', () => {
  for (const text of [
    'Projects',
    'Select or create a project',
    'Workspace ready',
    'Python 3.12',
    'Python backend runtime installation queued.',
    'Status: Python backend runtime is ready.',
    'Python backend runtime is ready. Continue',
    'Python 3.12.12 / development',
  ]) {
    assert.equal(pythonRuntimeReadyPattern().test(text), false, text);
  }

  for (const text of [
    'Python backend runtime is ready.',
    'Python backend runtime is running.',
    'Python backend runtime is already running.',
    'Python 3.12.12 / packaged',
  ]) {
    assert.equal(pythonRuntimeReadyPattern().test(text), true, text);
  }

  assert.equal(
    pythonRuntimeReadyPattern().test(
      'Python backend\r\n  Python backend runtime is ready.  \r\nOllama',
    ),
    true,
  );
});

test('python runtime startup state waits through the initial shell race', () => {
  assert.equal(pythonRuntimeStartupState('Cert Prep\nProjects'), 'pending');
  assert.equal(
    pythonRuntimeStartupState(
      'Python backend runtime is not installed.\nInstall runtime',
    ),
    'installable',
  );
  assert.equal(
    pythonRuntimeStartupState(
      'Python backend runtime is ready.\nInstall runtime',
    ),
    'ready',
  );
});
