import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { parsePackagedFlowSmokeArgs } from './args.mts';

test('packaged flow smoke args validate numeric knobs', () => {
  const parsed = parsePackagedFlowSmokeArgs([
    '--cdp-port',
    '9555',
    '--llm-provider',
    'ollama',
    '--streaming-draft-page-limit',
    '1',
    '--streaming-draft-workers',
    '2',
    '--wait-for-streaming-complete',
    '--streaming-complete-timeout-ms',
    '1234',
    '--verify-streaming-practice-ready',
    '--app-data-dir',
    'tmp/baseline-app-data',
  ]);

  assert.equal(parsed.cdpPort, 9555);
  assert.equal(parsed.llmProvider, 'ollama');
  assert.equal(parsed.streamingDraftPageLimit, 1);
  assert.equal(parsed.streamingDraftWorkers, 2);
  assert.equal(parsed.waitForStreamingComplete, true);
  assert.equal(parsed.streamingCompleteTimeoutMs, 1234);
  assert.equal(parsed.verifyStreamingPracticeReady, true);
  assert.match(parsed.appDataDir ?? '', /tmp[\\/]baseline-app-data$/);
  assert.throws(
    () => parsePackagedFlowSmokeArgs(['--streaming-draft-page-limit', '0']),
    /positive integer/,
  );
  assert.throws(
    () => parsePackagedFlowSmokeArgs(['--streaming-complete-timeout-ms', '0']),
    /positive integer/,
  );
  assert.throws(
    () => parsePackagedFlowSmokeArgs(['--unknown']),
    /Unknown argument/,
  );
});

test('packaged streaming baseline defaults to isolated output and app data', () => {
  const parsed = parsePackagedFlowSmokeArgs(
    ['--wait-for-streaming-complete'],
    'C:\\workspace',
  );

  assert.equal(parsed.waitForStreamingComplete, true);
  assert.equal(parsed.verifyStreamingPracticeReady, false);
  assert.equal(parsed.streamingCompleteTimeoutMs, 1_200_000);
  assert.match(
    parsed.outDir,
    /tmp[\\/]cert-prep-desktop[\\/]packaged-streaming-baseline[\\/]/,
  );
  assert.equal(parsed.appDataDir, `${parsed.outDir}\\app-data`);
});

test('packaged streaming production enables completion wait and production output root', () => {
  const parsed = parsePackagedFlowSmokeArgs(
    ['--production-summary', '--allow-capture-chunk-variance'],
    'C:\\workspace',
  );

  assert.equal(parsed.productionSummary, true);
  assert.equal(parsed.allowCaptureChunkVariance, true);
  assert.equal(parsed.waitForStreamingComplete, true);
  assert.equal(parsed.verifyStreamingPracticeReady, false);
  assert.equal(parsed.llmProvider, 'auto');
  assert.match(
    parsed.outDir,
    /tmp[\\/]cert-prep-desktop[\\/]packaged-streaming-production[\\/]/,
  );
  assert.equal(parsed.appDataDir, `${parsed.outDir}\\app-data`);
});

test('packaged flow smoke rejects retired model and video arguments', () => {
  for (const alias of [
    '--llm-model',
    '--ollama-model',
    '--ollama-fallback-models',
    '--llm-fallback-models',
    '--record-video',
  ]) {
    assert.throws(
      () => parsePackagedFlowSmokeArgs([alias, 'qwen3.5:4b']),
      new RegExp(`Unknown argument: ${alias}`),
    );
  }
});

test('streaming practice-ready verification implies completion wait', () => {
  const parsed = parsePackagedFlowSmokeArgs(
    ['--verify-streaming-practice-ready'],
    'C:\\workspace',
  );

  assert.equal(parsed.verifyStreamingPracticeReady, true);
  assert.equal(parsed.waitForStreamingComplete, true);
  assert.match(
    parsed.outDir,
    /tmp[\\/]cert-prep-desktop[\\/]packaged-streaming-baseline[\\/]/,
  );
});

test('packaged flow smoke can write timestamped output under an explicit root', () => {
  const parsed = parsePackagedFlowSmokeArgs(
    ['--production-summary', '--out-root', 'tmp/production'],
    'C:\\workspace',
  );

  assert.match(parsed.outDir, /tmp[\\/]production[\\/]/);
  assert.equal(parsed.appDataDir, `${parsed.outDir}\\app-data`);
});

test('packaged targets use Capture Runtime without retired provider flags', () => {
  const project = JSON.parse(
    readFileSync(new URL('../../project.json', import.meta.url), 'utf8'),
  ) as {
    targets?: Record<
      string,
      { outputs?: string[]; options?: { command?: string } }
    >;
  };
  for (const target of Object.values(project.targets ?? {})) {
    assert.doesNotMatch(target.options?.command ?? '', /--acceptance-lane/);
    assert.doesNotMatch(target.options?.command ?? '', /--capture-provider|--capture-page-workers/i);
  }
});
