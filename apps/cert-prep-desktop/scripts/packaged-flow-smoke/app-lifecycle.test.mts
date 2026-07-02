import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';

import {
  createCleanupWithTimeoutController,
  startAcceptanceVideoForSmoke,
} from './app-lifecycle.mts';
import type { SmokeRunState } from './types.mts';

test('cleanup timeout does not mark the underlying cleanup as finished', async () => {
  const target = {};
  const cleanupControl: { finish: () => void } = {
    finish: () => assert.fail('cleanup resolver was not initialized'),
  };
  const timeoutResolvers: Array<() => void> = [];
  const controller = createCleanupWithTimeoutController({
    cleanup: async () => {
      await new Promise<void>((resolve) => {
        cleanupControl.finish = resolve;
      });
    },
    timeoutMs: 10,
    delayForTimeout: async () => {
      await new Promise<void>((resolve) => timeoutResolvers.push(resolve));
    },
  });

  const cleanupView = controller.cleanupWithTimeout(target);
  assert.equal(controller.isFinished(target), false);

  timeoutResolvers.shift()?.();
  await assert.rejects(cleanupView, /cleanup is still running/);
  assert.equal(controller.isFinished(target), false);

  cleanupControl.finish();
  await setImmediate();

  await controller.cleanupWithTimeout(target);
  assert.equal(controller.isFinished(target), true);
});

test('concurrent cleanup timeout callers reuse one actual cleanup', async () => {
  const target = {};
  let cleanupCalls = 0;
  const cleanupControl: { finish: () => void } = {
    finish: () => assert.fail('cleanup resolver was not initialized'),
  };
  const controller = createCleanupWithTimeoutController({
    cleanup: async () => {
      cleanupCalls += 1;
      await new Promise<void>((resolve) => {
        cleanupControl.finish = resolve;
      });
    },
    timeoutMs: 10,
    delayForTimeout: async () => {
      await new Promise<void>(() => undefined);
    },
  });

  const first = controller.cleanupWithTimeout(target);
  const second = controller.cleanupWithTimeout(target);

  assert.strictEqual(first, second);
  assert.equal(cleanupCalls, 1);

  cleanupControl.finish();
  await first;
  await controller.cleanupWithTimeout(target);

  assert.equal(cleanupCalls, 1);
  assert.equal(controller.isFinished(target), true);
});

test('acceptance video start failures are recorded without aborting smoke', async () => {
  const run = {
    metrics: {
      observations: [],
    },
  } as unknown as SmokeRunState;

  await startAcceptanceVideoForSmoke(run, async () => {
    throw new Error('screencast denied');
  });

  assert.deepEqual(run.metrics.observations, [
    'acceptance video start failed: screencast denied',
  ]);
});
