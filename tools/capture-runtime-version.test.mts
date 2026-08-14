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
  assert.doesNotMatch(workflow, /CAPTURE_PUBLISHED_0_3_11/u);
});

test('the alpha release workflow is a published consumer with runtime gates', () => {
  const workflow = readFileSync(
    join(import.meta.dirname, '..', '.github', 'workflows', 'release-alpha.yml'),
    'utf8',
  );
  assert.doesNotMatch(workflow, /CAPTURE_PUBLISHED_0_3_9/u);
  assert.doesNotMatch(workflow, /pre-publication Capture Workbench bridge/u);
  assert.match(workflow, /packages:\s*read/u);
  assert.match(workflow, /registry-url:\s*https:\/\/npm\.pkg\.github\.com/u);
  assert.match(workflow, /CAPTURE_REQUIRE_PUBLISHED_CAPTURE_ARTIFACTS:\s*'1'/u);
  assert.match(workflow, /cert-prep-desktop:install-capture-runtime/u);
  assert.match(workflow, /cert-prep-desktop:capture-runtime-consumer-smoke/u);
});
