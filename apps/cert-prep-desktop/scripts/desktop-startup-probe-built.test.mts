import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  DESKTOP_STACK_RESERVE_BYTES,
  readPeStackReserve,
} from './desktop-startup-probe.mts';

test('fresh desktop binary reserves the candidate eight-mebibyte stack', () => {
  const executable = resolve(
    process.env.CERT_PREP_DESKTOP_PROBE_EXE ??
      'apps/cert-prep-desktop/src-tauri/target/x86_64-pc-windows-msvc/release/cert-prep-desktop.exe',
  );
  assert.equal(existsSync(executable), true, `missing desktop executable: ${executable}`);
  assert.equal(readPeStackReserve(executable), DESKTOP_STACK_RESERVE_BYTES);
});
