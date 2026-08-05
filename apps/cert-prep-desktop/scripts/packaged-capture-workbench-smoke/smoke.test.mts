import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { parsePackagedCaptureWorkbenchSmokeArgs } from './args.mts';
import { redactCaptureEvidence } from './evidence.mts';
import {
  assertGracefulCloseSummary,
  CAPTURE_WORKBENCH_READY_STATUS_PATTERN,
} from './runner.mts';
import {
  imageOnlyPdf,
  minimalPng,
  minimalWav,
  mixedTextAndImagePdf,
} from './negative-data-contract.mts';
import {
  assertLazyCaptureRuntimeJourney,
  type LazyCaptureRuntimeJourney,
} from './journey-contract.mts';
import {
  assertSafePackagedCaptureEnvironment,
  browserRequestViolations,
} from './request-security.mts';
import {
  assertCapturedRuntimeCleared,
  isOwnedBackendAndCaptureRunning,
  isOwnedBackendOnly,
  ownedRuntimePhaseFromSnapshots,
  parseListeningPortSnapshotJson,
} from './runtime-process-evidence.mts';
import type { ProcessRecord } from '../process-lifecycle/processes.mts';

test('requires a supplied exe and fresh isolated output paths', () => {
  const parsed = parsePackagedCaptureWorkbenchSmokeArgs(
    [
      '--exe',
      'fresh-install/cert-prep-desktop.exe',
      '--out-dir',
      'tmp/cert-prep-desktop/capture-e2e/run-1',
      '--app-data-dir',
      'tmp/cert-prep-desktop/capture-e2e/run-1/app-data',
      '--cdp-port',
      '9557',
    ],
    'C:\\workspace',
  );

  assert.equal(parsed.cdpPort, 9557);
  assert.match(parsed.exePath, /fresh-install[\\/]cert-prep-desktop\.exe$/);
  assert.match(parsed.appDataDir, /capture-e2e[\\/]run-1[\\/]app-data$/);
  assert.throws(
    () => parsePackagedCaptureWorkbenchSmokeArgs(['--exe', 'app.exe']),
    /--out-dir is required/,
  );
  assert.throws(
    () =>
      parsePackagedCaptureWorkbenchSmokeArgs([
        '--exe',
        'app.exe',
        '--out-dir',
        'tmp/run',
        '--app-data-dir',
        'tmp/other-data',
        '--cdp-port',
        '9557',
      ]),
    /direct child of --out-dir/,
  );
});

test('waits for the current host-managed Capture Workbench ready status', () => {
  const captureTrialPageSource = readFileSync(
    new URL(
      '../../../../apps/cert-prep/src/app/pages/capture-workbench-trial/capture-workbench-trial.page.ts',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(
    captureTrialPageSource,
    CAPTURE_WORKBENCH_READY_STATUS_PATTERN,
  );
  assert.doesNotMatch(captureTrialPageSource, /Image and audio capture are unavailable/);
});

test('rejects a forced app termination as packaged acceptance evidence', () => {
  assert.throws(
    () =>
      assertGracefulCloseSummary({
        label: 'capture-final-close',
        app_pid: 42,
        normal_close_requested: true,
        exited_after_normal_close: false,
        forced: true,
        residue: [],
        gracefulExited: false,
        fallbackUsed: true,
        exitCode: null,
        residualProcesses: [],
      }),
    /normal graceful-close path/u,
  );
});

test('builds real negative media fixtures without embedding fallback text', () => {
  const png = minimalPng();
  const wav = minimalWav();
  const scanned = imageOnlyPdf();
  const mixed = mixedTextAndImagePdf();

  assert.deepEqual(png.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'));
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(scanned.subarray(0, 8).toString('ascii'), '%PDF-1.4');
  assert.equal(scanned.includes(Buffer.from('/Subtype /Image')), true);
  assert.equal(scanned.includes(Buffer.from(' Tj')), false);
  assert.equal(mixed.includes(Buffer.from('/Count 2')), true);
  assert.equal(mixed.includes(Buffer.from('Embedded text page')), true);
  assert.equal(mixed.includes(Buffer.from('/Subtype /Image')), true);
  assert.equal(scanned.subarray(-6).toString('ascii'), '%%EOF\n');
  assert.equal(mixed.subarray(-6).toString('ascii'), '%%EOF\n');
});

test('redacts auth, tokens, URLs, and raw text from Capture evidence', () => {
  const redacted = redactCaptureEvidence({
    apiBaseUrl: 'http://127.0.0.1:8123',
    authorization: 'Bearer should-never-persist',
    raw: {
      sourceText: 'private source text',
      extractionEngine: { engine: 'pdf-embedded-text', device: 'cpu' },
      source: { sha256: 'a'.repeat(64), fileName: 'fixture.pdf' },
    },
    responseHeaders: { authorization: 'Bearer also-secret', xRequestId: 'safe' },
    errors: [
      'request failed: Bearer third-secret at http://127.0.0.1:8123 token=final-secret',
      'spawn failed --token process-secret; api_key: key-secret; password password-secret',
    ],
  });

  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes('should-never-persist'), false);
  assert.equal(serialized.includes('also-secret'), false);
  assert.equal(serialized.includes('127.0.0.1:8123'), false);
  assert.equal(serialized.includes('private source text'), false);
  assert.equal(serialized.includes('third-secret'), false);
  assert.equal(serialized.includes('final-secret'), false);
  assert.equal(serialized.includes('process-secret'), false);
  assert.equal(serialized.includes('key-secret'), false);
  assert.equal(serialized.includes('password-secret'), false);
  assert.deepEqual(redacted, {
    raw: {
      source: { sha256: 'a'.repeat(64), fileName: 'fixture.pdf' },
      extractionEngine: { engine: 'pdf-embedded-text', device: 'cpu' },
    },
    responseHeaders: { xRequestId: 'safe' },
    errors: [
      'request failed: Bearer [REDACTED] at [REDACTED_URL] token=[REDACTED]',
      'spawn failed --token=[REDACTED]; api_key=[REDACTED]; password=[REDACTED]',
    ],
  });
});

test('accepts authenticated Capture Runtime proxy requests only on the backend origin', () => {
  const allowedOrigins = {
    appOrigin: 'http://tauri.localhost',
    backendOrigin: 'http://127.0.0.1:8123',
    expectedBackendAuthorization: 'Bearer backend-only-token',
  };

  assert.deepEqual(
    browserRequestViolations(allowedOrigins, {
      url: 'http://127.0.0.1:8123/capture-runtime/ready',
      headers: { Authorization: 'Bearer backend-only-token' },
    }),
    [],
  );
  assert.deepEqual(
    browserRequestViolations(allowedOrigins, {
      url: 'http://127.0.0.1:8123/capture-runtime/requirements',
      headers: { authorization: 'Bearer sidecar-or-stale-token' },
    }),
    ['backend_authorization_mismatch'],
  );
  assert.deepEqual(
    browserRequestViolations(allowedOrigins, {
      url: 'http://127.0.0.1:9311/ready',
      headers: {},
    }),
    ['non_backend_loopback_request'],
  );
  assert.deepEqual(
    browserRequestViolations(allowedOrigins, {
      url: 'https://example.invalid/telemetry',
      headers: { authorization: 'Bearer leaked-token' },
    }),
    ['non_backend_authorization_header'],
  );
});

test('rejects inherited extraction and backend auto-install bypasses', () => {
  assert.doesNotThrow(() =>
    assertSafePackagedCaptureEnvironment({ CERT_PREP_LLM_PROVIDER: 'fake' }),
  );
  assert.throws(
    () =>
      assertSafePackagedCaptureEnvironment({
        CAPTURE_EXTRACTION_PROVIDER: 'fake',
      }),
    /ambient extraction override/i,
  );
  assert.throws(
    () =>
      assertSafePackagedCaptureEnvironment({
        cert_prep_package_qa_auto_install_bundled_backend: 'TRUE',
      }),
    /Python backend consent/i,
  );
});

test('collects only owned backend, Capture Runtime, and listener identities', () => {
  const processes: ProcessRecord[] = [
    processRecord(10, 1, 'cert-prep-desktop.exe'),
    processRecord(11, 10, 'cert-prep-backend.exe'),
    processRecord(13, 11, 'cert-prep-backend.exe'),
    processRecord(12, 10, 'capture-runtime-x86_64-pc-windows-msvc.exe'),
    processRecord(14, 12, 'capture-runtime-x86_64-pc-windows-msvc.exe'),
    processRecord(20, 1, 'other-app.exe'),
    processRecord(21, 20, 'capture-runtime.exe'),
  ];
  const listeners = parseListeningPortSnapshotJson(
    JSON.stringify([
      { OwningProcess: 13, LocalAddress: '127.0.0.1', LocalPort: 8123 },
      { OwningProcess: 14, LocalAddress: '127.0.0.1', LocalPort: 9311 },
      { OwningProcess: 21, LocalAddress: '127.0.0.1', LocalPort: 9411 },
    ]),
  );

  const captured = ownedRuntimePhaseFromSnapshots(processes, listeners, 10);
  assert.deepEqual(captured, {
    backendProcesses: [
      identity(11, 'cert-prep-backend.exe'),
      identity(13, 'cert-prep-backend.exe'),
    ],
    backendListenerPorts: [8123],
    captureProcesses: [
      identity(12, 'capture-runtime-x86_64-pc-windows-msvc.exe'),
      identity(14, 'capture-runtime-x86_64-pc-windows-msvc.exe'),
    ],
    captureListenerPorts: [9311],
  });
  assert.equal(isOwnedBackendAndCaptureRunning(captured), true);
  assert.equal(
    isOwnedBackendOnly({
      ...captured,
      captureProcesses: [],
      captureListenerPorts: [],
    }),
    true,
  );
  assert.doesNotThrow(() =>
    assertCapturedRuntimeCleared(captured, [
      { ...processes[1], creationDate: 'new-generation' },
    ], []),
  );
  assert.throws(
    () => assertCapturedRuntimeCleared(captured, processes, []),
    /process residue/,
  );
  assert.throws(
    () =>
      assertCapturedRuntimeCleared(captured, [], [
        { pid: 99, address: '127.0.0.1', port: 9311 },
      ]),
    /listener residue/,
  );
});

test('requires the full explicit lazy Capture Runtime journey', () => {
  const journey = validLazyJourney();
  assert.doesNotThrow(() => assertLazyCaptureRuntimeJourney(journey));

  assert.throws(
    () =>
      assertLazyCaptureRuntimeJourney({
        ...journey,
        captureInstalledStopped: {
          ...journey.captureInstalledStopped,
          captureProcesses: [identity(41, 'capture-runtime.exe')],
          captureListenerPorts: [9311],
        },
      }),
    /Install must leave Capture Runtime stopped/,
  );
  assert.throws(
    () =>
      assertLazyCaptureRuntimeJourney({
        ...journey,
        captureRunning: {
          ...journey.captureRunning,
          backendProcesses: journey.captureInstalledStopped.backendProcesses,
        },
      }),
    /fresh owned backend identity/,
  );
  assert.throws(
    () =>
      assertLazyCaptureRuntimeJourney({
        ...journey,
        relaunchedInstalledStopped: {
          ...journey.relaunchedInstalledStopped,
          captureProcesses: [identity(88, 'capture-runtime.exe')],
        },
      }),
    /Relaunch must not auto-start Capture Runtime/,
  );
});

function validLazyJourney(): LazyCaptureRuntimeJourney {
  const firstBackend = identity(21, 'cert-prep-backend.exe');
  const restartedBackend = identity(31, 'cert-prep-backend.exe');
  const relaunchedBackend = identity(51, 'cert-prep-backend.exe');
  return {
    firstShell: {
      ...phase('missing', false),
      runtimeRouteVisible: true,
    },
    backendReadyCaptureMissing: {
      ...phase('missing', true),
      backendProcesses: [firstBackend],
      backendListenerPorts: [8123],
      pythonBackendConsentCompleted: true,
    },
    captureInstalledStopped: {
      ...phase('installed-stopped', true),
      backendProcesses: [firstBackend],
      backendListenerPorts: [8123],
    },
    captureRunning: {
      ...phase('running', true),
      backendProcesses: [restartedBackend],
      backendListenerPorts: [8223],
      captureProcesses: [identity(41, 'capture-runtime.exe')],
      captureListenerPorts: [9311],
      backendConfigurationChanged: true,
      priorBackendAccessRejected: true,
    },
    firstClose: phase('closed', false),
    relaunchedInstalledStopped: {
      ...phase('installed-stopped', true),
      backendProcesses: [relaunchedBackend],
      backendListenerPorts: [8323],
    },
    relaunchedRunningPersisted: {
      ...phase('running', true),
      backendProcesses: [identity(61, 'cert-prep-backend.exe')],
      backendListenerPorts: [8423],
      captureProcesses: [identity(71, 'capture-runtime.exe')],
      captureListenerPorts: [9411],
      persistedDocumentVisible: true,
    },
    finalClose: phase('closed', false),
  };
}

function phase(
  captureStatus: 'missing' | 'installed-stopped' | 'running' | 'closed',
  backendReady: boolean,
) {
  return {
    captureStatus,
    backendReady,
    backendProcesses: [],
    backendListenerPorts: [],
    captureProcesses: [],
    captureListenerPorts: [],
  };
}

function identity(pid: number, imageName: string) {
  return {
    pid,
    creationDate: `20260802010${pid}.000000+000`,
    imagePath: `C:\\scoped\\${imageName}`,
  };
}

function processRecord(
  pid: number,
  parentPid: number,
  name: string,
): ProcessRecord {
  return {
    pid,
    parentPid,
    name,
    executablePath: `C:\\scoped\\${name}`,
    commandLine: '',
    creationDate: `20260802010${pid}.000000+000`,
    workingSetBytes: 1,
  };
}
