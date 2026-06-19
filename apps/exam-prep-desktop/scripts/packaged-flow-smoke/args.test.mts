import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parsePackagedFlowSmokeArgs } from './args.mts';

test('packaged flow smoke args validate numeric knobs', () => {
  const parsed = parsePackagedFlowSmokeArgs([
    '--cdp-port',
    '9555',
    '--ocr-page-workers',
    '2',
    '--ollama-model',
    'qwen3:8b',
    '--streaming-draft-page-limit',
    '1',
    '--streaming-draft-workers',
    '2',
  ]);

  assert.equal(parsed.cdpPort, 9555);
  assert.equal(parsed.ocrPageWorkers, 2);
  assert.equal(parsed.ollamaModel, 'qwen3:8b');
  assert.equal(parsed.streamingDraftPageLimit, 1);
  assert.equal(parsed.streamingDraftWorkers, 2);
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
    () => parsePackagedFlowSmokeArgs(['--unknown']),
    /Unknown argument/,
  );
});
