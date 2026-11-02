import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSmokeRunState } from './run-state.mts';
import type { SmokeMetrics, SmokeOptions } from './types.mts';

test('smoke run state keeps the caller options and metrics and starts idle', () => {
  const options = { cdpPort: 9444 } as SmokeOptions;
  const metrics = { status: 'running' } as SmokeMetrics;

  const run = createSmokeRunState(options, metrics);

  assert.equal(run.options, options);
  assert.equal(run.metrics, metrics);
  assert.equal(run.port, 9444);
  assert.deepEqual(run.processBaseline, { all: [], nodePids: new Set() });
  assert.deepEqual(omit(run, ['options', 'metrics', 'processBaseline']), {
    app: null,
    appExit: null,
    resourceSampling: null,
    browser: null,
    page: null,
    port: 9444,
    projectApi: null,
    uploadedDocument: null,
    streamingDraftParseStartedAt: null,
    streamingDraftCaptureOpen: false,
    streamingApiPollErrorCaptured: false,
  });
  assert.notEqual(
    createSmokeRunState(options, metrics).processBaseline,
    run.processBaseline,
  );
});

function omit(value: object, keys: readonly string[]): object {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key)),
  );
}
