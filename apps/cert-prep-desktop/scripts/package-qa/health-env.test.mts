import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parsePackageQaArgs,
  parsePackageQaEnv,
} from './cli.mts';
import {
  buildRuntimeLaunchEnv,
  summarizeLlmHealth,
  summarizeOcrHealth,
} from './health.mts';
import { initialInstallerSizeGate } from './size-gate.mts';

test('health summaries keep OCR fallback and LLM model state', () => {
  assert.deepEqual(
    summarizeOcrHealth({
      provider: 'paddle',
      engine: 'paddleocr',
      available: true,
      detail: 'ready',
      selected_device: 'cpu',
      cuda_available: false,
      gpu_count: 0,
      fallback_reason: 'cuda_unavailable',
      extra: 'ignored',
    }),
    {
      provider: 'paddle',
      engine: 'paddleocr',
      available: true,
      detail: 'ready',
      selected_device: 'cpu',
      cuda_available: false,
      gpu_count: 0,
      fallback_reason: 'cuda_unavailable',
      unavailable_reason: null,
    },
  );

  assert.deepEqual(
    summarizeLlmHealth({
      provider: 'ollama',
      model: 'qwen3.5:4b',
      available: false,
      detail: 'model not found',
      extra: 'ignored',
    }),
    {
      provider: 'ollama',
      model: 'qwen3.5:4b',
      available: false,
      detail: 'model not found',
      unavailable_reason: null,
    },
  );
});

test('package QA parses OCR page worker count from QA-specific inputs', () => {
  assert.deepEqual(
    parsePackageQaEnv({ CERT_PREP_PACKAGE_QA_OCR_PAGE_WORKERS: '2' }),
    { ocrPageWorkers: 2 },
  );
  assert.equal(
    parsePackageQaArgs(['--ocr-page-workers', '4'], {
      CERT_PREP_PACKAGE_QA_OCR_PAGE_WORKERS: '2',
    }).ocrPageWorkers,
    4,
  );
  assert.throws(
    () => parsePackageQaArgs(['--ocr-page-workers', '0'], {}),
    /positive integer/,
  );
});

test('runtime launch env sets OCR page workers only from explicit QA config', () => {
  const baseOptions = {
    port: 8765,
    token: 'token',
    dataDir: 'data',
    llmModel: 'qwen3.5:4b',
    windowsmlOcrRuntimeManifest: 'windowsml-ocr-runtime-manifest.json',
  };

  const ambientOnly = buildRuntimeLaunchEnv({
    ...baseOptions,
    baseEnv: { CERT_PREP_OCR_PAGE_WORKERS: '9', PATH: 'test-path' },
  });
  assert.equal(ambientOnly.CERT_PREP_OCR_PAGE_WORKERS, undefined);
  assert.equal(
    ambientOnly.CERT_PREP_STREAMING_DRAFT_GENERATION_ON_UPLOAD,
    'true',
  );
  assert.equal(ambientOnly.CERT_PREP_OCR_PROVIDER, 'windowsml');
  assert.equal(
    ambientOnly.CERT_PREP_WINDOWSML_OCR_RUNTIME_MANIFEST_PATH,
    'windowsml-ocr-runtime-manifest.json',
  );
  assert.equal('CERT_PREP_OCR_RUNTIME_MANIFEST_PATH' in ambientOnly, false);
  assert.equal(ambientOnly.CERT_PREP_OCR_WINDOWSML_DEVICE_ID, '-1');
  assert.equal(ambientOnly.CERT_PREP_OCR_WINDOWSML_DEVICE_POLICY, 'PREFER_NPU');
  assert.equal(ambientOnly.PATH, 'test-path');

  const explicit = buildRuntimeLaunchEnv({
    ...baseOptions,
    ocrPageWorkers: 3,
    baseEnv: { CERT_PREP_OCR_PAGE_WORKERS: '9' },
  });
  assert.equal(explicit.CERT_PREP_OCR_PAGE_WORKERS, '3');
});

test('initialInstallerSizeGate warns and fails at configured thresholds', () => {
  assert.equal(initialInstallerSizeGate([{ mb: 100 }]).status, 'passed');
  assert.equal(initialInstallerSizeGate([{ mb: 180 }]).status, 'warning');
  assert.equal(initialInstallerSizeGate([{ mb: 300 }]).status, 'failed');
});
