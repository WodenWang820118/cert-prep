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
  assert.equal(parsed.ocrProvider, 'windowsml');
  assert.equal(parsed.ocrPageWorkers, 2);
  assert.equal(parsed.llmProvider, 'ollama');
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

test('packaged production targets pin the Ollama-only Alpha policy', () => {
  const project = JSON.parse(
    readFileSync(new URL('../../project.json', import.meta.url), 'utf8'),
  ) as {
    targets?: Record<
      string,
      { outputs?: string[]; options?: { command?: string } }
    >;
  };
  assert.equal(project.targets?.['packaged-streaming-baseline'], undefined);
  const baselineCommand =
    project.targets?.['packaged-streaming-baseline-windowsml']?.options
      ?.command ?? '';
  assert.match(baselineCommand, /--ocr-provider windowsml(?:\s|$)/);

  const productionTarget =
    project.targets?.['packaged-streaming-production-windowsml'];
  const command = productionTarget?.options?.command ?? '';
  const parsed = parsePackagedFlowSmokeArgs(targetCommandArgs(command));
  assert.equal(parsed.llmProvider, 'ollama');
  assert.equal(parsed.productionSummary, true);
  assert.equal(parsed.ocrProvider, 'windowsml');
  assert.equal(parsed.verifyStreamingPracticeReady, true);
  assert.doesNotMatch(command, /(?:fallback|record-video|llm-model)/);
  assert.equal(
    project.targets?.['packaged-streaming-production-recorded-windowsml'],
    undefined,
  );
  assert.equal(Boolean(productionTarget?.outputs?.[0]), true);

  for (const target of Object.values(project.targets ?? {})) {
    assert.doesNotMatch(target.options?.command ?? '', /--acceptance-lane/);
  }
});

function targetCommandArgs(command: string): string[] {
  const [runtime, script, ...args] = command.trim().split(/\s+/);
  assert.equal(runtime, 'node');
  assert.equal(
    script,
    'apps/cert-prep-desktop/scripts/packaged-flow-smoke.mts',
  );
  return args;
}
