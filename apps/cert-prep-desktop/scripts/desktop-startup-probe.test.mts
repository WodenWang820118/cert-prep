import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import {
  DESKTOP_STACK_RESERVE_BYTES,
  STARTUP_PROBE_PHASES,
  captureTrialUrl,
  classifyDesktopStartupFailure,
  parseDesktopStartupProbeArgs,
  parsePeStackReserve,
  redactProbeEnvironment,
} from './desktop-startup-probe.mts';

test('startup probe phases separate direct launch, CDP attach, and viewport mutation', () => {
  assert.deepEqual(STARTUP_PROBE_PHASES, [
    'no-cdp',
    'cdp-attach',
    'cdp-viewport',
  ]);
});

test('startup probe CLI resolves the supplied Windows workspace root and phase', () => {
  const workspace = mkdtempSync(resolve(tmpdir(), 'cert-prep-startup-probe-'));
  try {
    const options = parseDesktopStartupProbeArgs(
      [
        '--out-dir',
        'probe-output',
        '--phase',
        'cdp-viewport',
        '--verify-capture-trial',
      ],
      workspace,
    );
    assert.equal(options.workspaceRoot, workspace);
    assert.equal(options.phaseSelection, 'cdp-viewport');
    assert.equal(options.verifyCaptureTrial, true);
    assert.equal(options.outDir, resolve(workspace, 'probe-output'));
    assert.equal(options.appDataDir, resolve(workspace, 'probe-output/app-data'));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('capture-trial verification rejects non-viewport phases', () => {
  const workspace = mkdtempSync(resolve(tmpdir(), 'cert-prep-startup-probe-'));
  try {
    assert.throws(
      () =>
        parseDesktopStartupProbeArgs(
          [
            '--out-dir',
            'probe-output',
            '--phase',
            'cdp-attach',
            '--verify-capture-trial',
          ],
          workspace,
        ),
      /requires --phase cdp-viewport/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('capture-trial route is derived only from a loaded application URL', () => {
  assert.equal(
    captureTrialUrl('http://tauri.localhost/'),
    'http://tauri.localhost/capture-workbench-trial',
  );
  assert.throws(() => captureTrialUrl('about:blank'), /loaded application URL/);
});

test('native stack overflow classification wins over a later closed-page error', () => {
  assert.deepEqual(
    classifyDesktopStartupFailure({
      phase: 'cdp-viewport',
      exitCode: 0xc00000fd,
      stderr: "thread 'main' (1960) has overflowed its stack",
      error: 'page.setViewportSize: Target page, context or browser has been closed',
    }),
    {
      kind: 'stack-overflow',
      phase: 'cdp-viewport',
      secondaryError:
        'page.setViewportSize: Target page, context or browser has been closed',
    },
  );
});

test('probe environment records a bearer token only as redacted', () => {
  assert.deepEqual(
    redactProbeEnvironment({
      CERT_PREP_DESKTOP_DATA_DIR: 'C:\\qa\\app-data',
      CAPTURE_RUNTIME_BEARER_TOKEN: 'never-write-this-token',
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9491',
    }),
    {
      CAPTURE_RUNTIME_BEARER_TOKEN: '[REDACTED]',
      CERT_PREP_DESKTOP_DATA_DIR: 'C:\\qa\\app-data',
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9491',
    },
  );
});

test('PE parser reads a PE32+ eight-mebibyte stack reserve', () => {
  const fixture = Buffer.alloc(512);
  fixture.writeUInt16LE(0x5a4d, 0);
  fixture.writeUInt32LE(0x80, 0x3c);
  fixture.set(Buffer.from([0x50, 0x45, 0x00, 0x00]), 0x80);
  fixture.writeUInt16LE(0x8664, 0x84);
  fixture.writeUInt16LE(0x20b, 0x98);
  fixture.writeBigUInt64LE(BigInt(DESKTOP_STACK_RESERVE_BYTES), 0x98 + 72);

  assert.equal(parsePeStackReserve(fixture), DESKTOP_STACK_RESERVE_BYTES);
});
