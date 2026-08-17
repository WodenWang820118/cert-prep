import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { assertCaptureRuntimeConsumerVersions } from './capture-runtime-version-check.mts';

test('all Cert Prep Capture Runtime consumers use one release version', () => {
  assert.doesNotThrow(() => assertCaptureRuntimeConsumerVersions());
});

test('CI installs the published Capture Workbench packages directly', () => {
  const workflow = readFileSync(
    join(import.meta.dirname, '..', '.github', 'workflows', 'ci.yml'),
    'utf8',
  );
  assert.match(workflow, /pnpm install --frozen-lockfile/u);
  assert.doesNotMatch(workflow, /CAPTURE_PUBLISHED_/u);
  assert.doesNotMatch(workflow, /prepublication-stable-version/u);
});

test('the alpha release workflow is a published consumer with runtime gates', () => {
  const workflow = readFileSync(
    join(import.meta.dirname, '..', '.github', 'workflows', 'release-alpha.yml'),
    'utf8',
  );
  assert.doesNotMatch(workflow, /pre-publication Capture Workbench bridge/u);
  assert.match(workflow, /packages:\s*read/u);
  assert.match(workflow, /registry-url:\s*https:\/\/npm\.pkg\.github\.com/u);
  assert.doesNotMatch(workflow, /CAPTURE_REQUIRE_PUBLISHED_CAPTURE_ARTIFACTS/u);
  assert.match(workflow, /cert-prep-desktop:install-capture-runtime/u);
  assert.match(workflow, /cert-prep-desktop:capture-runtime-consumer-smoke/u);
});
