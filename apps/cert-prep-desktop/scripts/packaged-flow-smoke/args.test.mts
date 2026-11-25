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
    '--question-jobs-chunk-limit',
    '1',
    '--question-job-workers',
    '2',
    '--wait-for-question-jobs',
    '--question-jobs-complete-timeout-ms',
    '1234',
    '--verify-generated-questions-practice-ready',
    '--app-data-dir',
    'tmp/baseline-app-data',
  ]);

  assert.equal(parsed.cdpPort, 9555);
  assert.equal(parsed.llmProvider, 'ollama');
  assert.equal(parsed.questionJobsChunkLimit, 1);
  assert.equal(parsed.questionJobWorkers, 2);
  assert.equal(parsed.waitForQuestionJobs, true);
  assert.equal(parsed.questionJobsCompleteTimeoutMs, 1234);
  assert.equal(parsed.verifyGeneratedQuestionsPracticeReady, true);
  assert.match(parsed.appDataDir ?? '', /tmp[\\/]baseline-app-data$/);
  assert.throws(
    () => parsePackagedFlowSmokeArgs(['--question-jobs-chunk-limit', '0']),
    /positive integer/,
  );
  assert.throws(
    () => parsePackagedFlowSmokeArgs(['--question-jobs-complete-timeout-ms', '0']),
    /positive integer/,
  );
  assert.throws(
    () => parsePackagedFlowSmokeArgs(['--unknown']),
    /Unknown argument/,
  );
});

test('packaged question generation baseline defaults to isolated output and app data', () => {
  const parsed = parsePackagedFlowSmokeArgs(
    ['--wait-for-question-jobs'],
    'C:\\workspace',
  );

  assert.equal(parsed.waitForQuestionJobs, true);
  assert.equal(parsed.verifyGeneratedQuestionsPracticeReady, false);
  assert.equal(parsed.questionJobsCompleteTimeoutMs, 1_200_000);
  assert.match(
    parsed.outDir,
    /tmp[\\/]cert-prep-desktop[\\/]packaged-question-generation-baseline[\\/]/,
  );
  assert.equal(parsed.appDataDir, `${parsed.outDir}\\app-data`);
});

test('packaged question generation production enables completion wait and production output root', () => {
  const parsed = parsePackagedFlowSmokeArgs(
    ['--production-summary', '--allow-capture-chunk-variance'],
    'C:\\workspace',
  );

  assert.equal(parsed.productionSummary, true);
  assert.equal(parsed.allowCaptureChunkVariance, true);
  assert.equal(parsed.waitForQuestionJobs, true);
  assert.equal(parsed.verifyGeneratedQuestionsPracticeReady, false);
  assert.equal(parsed.llmProvider, 'auto');
  assert.match(
    parsed.outDir,
    /tmp[\\/]cert-prep-desktop[\\/]packaged-question-generation-production[\\/]/,
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

test('generated-question practice-ready verification implies completion wait', () => {
  const parsed = parsePackagedFlowSmokeArgs(
    ['--verify-generated-questions-practice-ready'],
    'C:\\workspace',
  );

  assert.equal(parsed.verifyGeneratedQuestionsPracticeReady, true);
  assert.equal(parsed.waitForQuestionJobs, true);
  assert.match(
    parsed.outDir,
    /tmp[\\/]cert-prep-desktop[\\/]packaged-question-generation-baseline[\\/]/,
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
