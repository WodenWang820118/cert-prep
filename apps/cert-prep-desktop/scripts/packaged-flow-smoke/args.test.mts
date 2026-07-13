import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { parsePackagedFlowSmokeArgs } from './args.mts';

test('packaged flow smoke args validate numeric knobs', () => {
  const parsed = parsePackagedFlowSmokeArgs([
    '--cdp-port',
    '9555',
    '--ocr-provider',
    'windowsml',
    '--ocr-page-workers',
    '2',
    '--llm-provider',
    'fastflowlm',
    '--llm-model',
    'qwen3.5:2b',
    '--llm-fallback-models',
    'qwen3.5:4b, qwen3.5:0.8b',
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
  assert.equal(parsed.ocrProvider, 'windowsml');
  assert.equal(parsed.ocrPageWorkers, 2);
  assert.equal(parsed.llmProvider, 'fastflowlm');
  assert.equal(parsed.ollamaModel, 'qwen3.5:2b');
  assert.deepEqual(parsed.ollamaFallbackModels, ['qwen3.5:4b', 'qwen3.5:0.8b']);
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
    /tmp[\\/]cert-prep-desktop[\\/]packaged-streaming-baseline[\\/]/,
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
  assert.deepEqual(parsed.ollamaFallbackModels, ['qwen3.5:2b']);
  assert.equal(parsed.llmProvider, 'auto');
  assert.match(
    parsed.outDir,
    /tmp[\\/]cert-prep-desktop[\\/]packaged-streaming-production[\\/]/,
  );
  assert.equal(parsed.appDataDir, `${parsed.outDir}\\app-data`);
});

test('packaged flow smoke keeps ollama argument aliases for old QA commands', () => {
  const parsed = parsePackagedFlowSmokeArgs([
    '--llm-provider',
    'ollama',
    '--ollama-model',
    'qwen3.5:2b',
    '--ollama-fallback-models',
    'qwen3.5:0.8b',
  ]);

  assert.equal(parsed.llmProvider, 'ollama');
  assert.equal(parsed.ollamaModel, 'qwen3.5:2b');
  assert.deepEqual(parsed.ollamaFallbackModels, ['qwen3.5:0.8b']);
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

test('record video can be enabled by flag or environment', () => {
  assert.equal(
    parsePackagedFlowSmokeArgs(['--record-video'], 'C:\\workspace').recordVideo,
    true,
  );

  const previous = process.env.CERT_PREP_PACKAGE_SMOKE_RECORD_VIDEO;
  try {
    process.env.CERT_PREP_PACKAGE_SMOKE_RECORD_VIDEO = '1';
    assert.equal(parsePackagedFlowSmokeArgs([], 'C:\\workspace').recordVideo, true);
  } finally {
    if (previous === undefined) {
      delete process.env.CERT_PREP_PACKAGE_SMOKE_RECORD_VIDEO;
    } else {
      process.env.CERT_PREP_PACKAGE_SMOKE_RECORD_VIDEO = previous;
    }
  }
});

test('packaged flow smoke can write timestamped output under an explicit root', () => {
  const parsed = parsePackagedFlowSmokeArgs(
    ['--production-summary', '--out-root', 'tmp/recorded-production'],
    'C:\\workspace',
  );

  assert.match(parsed.outDir, /tmp[\\/]recorded-production[\\/]/);
  assert.equal(parsed.appDataDir, `${parsed.outDir}\\app-data`);
});

test('both packaged production targets exercise auto provider selection', () => {
  const project = JSON.parse(
    readFileSync(new URL('../../project.json', import.meta.url), 'utf8'),
  ) as {
    targets?: Record<string, { options?: { command?: string } }>;
  };
  for (const target of [
    'packaged-streaming-production-windowsml',
    'packaged-streaming-production-recorded-windowsml',
  ]) {
    const command = project.targets?.[target]?.options?.command ?? '';
    assert.match(command, /--llm-provider auto(?:\s|$)/);
    assert.doesNotMatch(command, /--llm-provider fastflowlm(?:\s|$)/);
  }
});
