import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { parsePackagedFlowSmokeArgs } from './args.mts';
import type { AcceptanceLane } from './types.mts';

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
    () => parsePackagedFlowSmokeArgs(['--llm-model', ' ']),
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
  assert.equal(parsed.acceptanceLane, 'none');
  assert.equal(parsed.streamingCompleteTimeoutMs, 1_200_000);
  assert.match(
    parsed.outDir,
    /tmp[\\/]cert-prep-desktop[\\/]packaged-streaming-baseline[\\/]/,
  );
  assert.equal(parsed.appDataDir, `${parsed.outDir}\\app-data`);
});

test('packaged flow smoke accepts the typed XDNA2 lane', () => {
  const xdna2 = parsePackagedFlowSmokeArgs(
    acceptanceLaneArgs('xdna2-fastflow', 'auto'),
  );
  assert.equal(xdna2.acceptanceLane, 'xdna2-fastflow');
  assert.equal(xdna2.llmProvider, 'auto');

  assert.throws(
    () => parsePackagedFlowSmokeArgs(['--acceptance-lane', 'forced-ollama']),
    /must be one of: none, xdna2-fastflow/,
  );
});

test('XDNA2 acceptance fails fast when its packaged evidence contract drifts', () => {
  const xdna2 = acceptanceLaneArgs('xdna2-fastflow', 'auto');
  const cases: Array<{
    name: string;
    args: string[];
    expected: RegExp;
  }> = [
    {
      name: 'production summary',
      args: xdna2.filter((arg) => arg !== '--production-summary'),
      expected: /requires --production-summary/,
    },
    {
      name: 'WindowsML OCR',
      args: replaceArgumentValue(xdna2, '--ocr-provider', 'other'),
      expected: /requires --ocr-provider windowsml/,
    },
    {
      name: 'practice-ready proof',
      args: xdna2.filter(
        (arg) => arg !== '--verify-streaming-practice-ready',
      ),
      expected: /requires --verify-streaming-practice-ready/,
    },
    {
      name: 'XDNA2 provider preference',
      args: replaceArgumentValue(xdna2, '--llm-provider', 'fastflowlm'),
      expected: /requires --llm-provider auto/,
    },
    {
      name: 'acceptance model',
      args: replaceArgumentValue(xdna2, '--llm-model', 'qwen3.5:2b'),
      expected: /requires --llm-model qwen3\.5:4b/,
    },
    {
      name: 'exact fallback list',
      args: replaceArgumentValue(
        xdna2,
        '--llm-fallback-models',
        'qwen3.5:2b,qwen3.5:0.8b',
      ),
      expected: /requires --llm-fallback-models qwen3\.5:2b exactly/,
    },
  ];

  for (const scenario of cases) {
    assert.throws(
      () => parsePackagedFlowSmokeArgs(scenario.args),
      scenario.expected,
      scenario.name,
    );
  }
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

test('packaged flow smoke rejects retired Ollama model argument aliases', () => {
  for (const alias of ['--ollama-model', '--ollama-fallback-models']) {
    assert.throws(
      () => parsePackagedFlowSmokeArgs([alias, 'qwen3.5:2b']),
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

test('packaged production targets pin the typed XDNA2 acceptance lane', () => {
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

  for (const target of [
    'packaged-streaming-production-windowsml',
    'packaged-streaming-production-recorded-windowsml',
  ]) {
    const command = project.targets?.[target]?.options?.command ?? '';
    const parsed = parsePackagedFlowSmokeArgs(targetCommandArgs(command));
    assert.equal(parsed.acceptanceLane, 'xdna2-fastflow');
    assert.equal(parsed.llmProvider, 'auto');
    assert.equal(parsed.ollamaModel, 'qwen3.5:4b');
    assert.deepEqual(parsed.ollamaFallbackModels, ['qwen3.5:2b']);
    assert.equal(parsed.productionSummary, true);
    assert.equal(parsed.ocrProvider, 'windowsml');
    assert.equal(parsed.verifyStreamingPracticeReady, true);
  }

  const productionOutputs = [
    project.targets?.['packaged-streaming-production-windowsml']?.outputs?.[0],
    project.targets?.['packaged-streaming-production-recorded-windowsml']
      ?.outputs?.[0],
  ];
  assert.equal(productionOutputs.every(Boolean), true);
  assert.equal(new Set(productionOutputs).size, productionOutputs.length);
});

function acceptanceLaneArgs(
  lane: Exclude<AcceptanceLane, 'none'>,
  llmProvider: 'auto',
): string[] {
  return [
    '--production-summary',
    '--ocr-provider',
    'windowsml',
    '--llm-provider',
    llmProvider,
    '--llm-model',
    'qwen3.5:4b',
    '--llm-fallback-models',
    'qwen3.5:2b',
    '--verify-streaming-practice-ready',
    '--acceptance-lane',
    lane,
  ];
}

function replaceArgumentValue(
  args: readonly string[],
  flag: string,
  value: string,
): string[] {
  const updated = [...args];
  const index = updated.indexOf(flag);
  assert.notEqual(index, -1, `${flag} must exist in the test fixture`);
  updated[index + 1] = value;
  return updated;
}

function targetCommandArgs(command: string): string[] {
  const [runtime, script, ...args] = command.trim().split(/\s+/);
  assert.equal(runtime, 'node');
  assert.equal(
    script,
    'apps/cert-prep-desktop/scripts/packaged-flow-smoke.mts',
  );
  return args;
}
