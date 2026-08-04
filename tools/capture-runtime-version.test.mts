import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertCaptureRuntimeConsumerVersions } from './capture-runtime-version-check.mts';

test('all Cert Prep Capture Runtime consumers use one release version', () => {
  assert.doesNotThrow(() => assertCaptureRuntimeConsumerVersions());
});
