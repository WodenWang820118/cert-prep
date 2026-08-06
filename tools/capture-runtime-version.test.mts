import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { assertCaptureRuntimeConsumerVersions } from './capture-runtime-version-check.mts';
import { CAPTURE_RUNTIME_VERSION } from './capture-runtime-version.mts';

test('all Cert Prep Capture Runtime consumers use one release version', () => {
  assert.doesNotThrow(() => assertCaptureRuntimeConsumerVersions());
});

test('CI published-artifact switch uses the current Capture Runtime release', () => {
  const workflow = readFileSync(
    join(import.meta.dirname, '..', '.github', 'workflows', 'ci.yml'),
    'utf8',
  );
  const currentSwitch = `CAPTURE_PUBLISHED_${CAPTURE_RUNTIME_VERSION.replaceAll('.', '_')}`;
  assert.match(workflow, new RegExp(currentSwitch, 'u'));
  assert.doesNotMatch(workflow, /CAPTURE_PUBLISHED_0_3_10/u);
});
