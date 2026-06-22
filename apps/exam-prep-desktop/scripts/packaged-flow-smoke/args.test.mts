import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parsePackagedFlowSmokeArgs } from './args.mts';

test('packaged flow smoke args validate numeric knobs', () => {
  const parsed = parsePackagedFlowSmokeArgs([
    '--cdp-port',
    '9555',
    '--ocr-provider',
    'directml',
    '--ocr-page-workers',
    '2',
    '--ollama-model',
    'qwen3:8b',
    '--ollama-fallback-models',
    'qwen3:14b, qwen3:4b',
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
  assert.equal(parsed.ocrProvider, 'directml');
  assert.equal(parsed.ocrPageWorkers, 2);
  assert.equal(parsed.ollamaModel, 'qwen3:8b');
  assert.deepEqual(parsed.ollamaFallbackModels, ['qwen3:14b', 'qwen3:4b']);
  assert.equal(parsed.streamingDraftPageLimit, 1);
  assert.equal(parsed.streamingDraftWorkers, 2);
  assert.equal(parsed.waitForStreamingComplete, true);
  assert.equal(parsed.streamingCompleteTimeoutMs, 1234);
  assert.equal(parsed.verifyStreamingPracticeReady, true);
  assert.match(parsed.appDataDir ?? '', /tmp[\\/]baseline-app-data$/);
  assert.throws(
    () => parsePackagedFlowSmokeArgs(['--ocr-page-workers', '0']),
    /positive integer/,
  );
  assert.throws(
    () => parsePackagedFlowSmokeArgs(['--streaming-draft-page-limit', '0']),
    /positive integer/,
  );
  assert.throws(
    () => parsePackagedFlowSmokeArgs(['--ollama-model', ' ']),
    /must not be empty/,
  );
  assert.throws(
    () => parsePackagedFlowSmokeArgs(['--ocr-provider', ' ']),
    /must not be empty/,
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
    /tmp[\\/]exam-prep-desktop[\\/]packaged-streaming-baseline[\\/]/,
  );
  assert.equal(parsed.appDataDir, `${parsed.outDir}\\app-data`);
});

test('packaged streaming production enables completion wait and production output root', () => {
  const parsed = parsePackagedFlowSmokeArgs(
    ['--production-summary', '--allow-ocr-chunk-variance'],
    'C:\\workspace',
  );

  assert.equal(parsed.productionSummary, true);
  assert.equal(parsed.allowOcrChunkVariance, true);
  assert.equal(parsed.waitForStreamingComplete, true);
  assert.equal(parsed.verifyStreamingPracticeReady, false);
  assert.deepEqual(parsed.ollamaFallbackModels, ['qwen3:8b']);
  assert.match(
    parsed.outDir,
    /tmp[\\/]exam-prep-desktop[\\/]packaged-streaming-production[\\/]/,
  );
  assert.equal(parsed.appDataDir, `${parsed.outDir}\\app-data`);
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
    /tmp[\\/]exam-prep-desktop[\\/]packaged-streaming-baseline[\\/]/,
  );
});
