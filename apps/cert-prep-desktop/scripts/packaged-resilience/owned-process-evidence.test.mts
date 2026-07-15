import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ProcessRecord } from '../process-lifecycle/processes.mts';
import { OwnedProcessEvidenceTracker } from './owned-process-evidence.mts';

const APP_PATH = 'C:\\Program Files\\Cert Prep\\cert-prep-desktop.exe';

test('proves exact trees from multiple app sessions are absent for two snapshots', async () => {
  const baseline = [processRecord(5, 0, 'explorer.exe', 'baseline')];
  const snapshots: ProcessRecord[][] = [
    [
      ...baseline,
      processRecord(100, 5, 'cert-prep-desktop.exe', 'run-1', APP_PATH),
      processRecord(101, 100, 'cert-prep-backend.exe', 'backend-1'),
    ],
    [
      ...baseline,
      processRecord(200, 5, 'cert-prep-desktop.exe', 'run-2', APP_PATH),
      processRecord(201, 200, 'flm.exe', 'flm-2'),
    ],
    [...baseline],
    [...baseline],
  ];
  const tracker = new OwnedProcessEvidenceTracker({
    baselineProcesses: baseline,
    snapshotProcesses: () => snapshots.shift() ?? baseline,
    wait: async () => undefined,
    releaseAttempts: 4,
  });

  assert.deepEqual(tracker.captureAppTree(100, APP_PATH), [100, 101]);
  assert.deepEqual(tracker.captureAppTree(200, APP_PATH), [200, 201]);
  const proof = await tracker.proveReleased(200, '2026-07-14T01:00:00.000Z');

  assert.deepEqual(proof.observedAppPids, [100, 200]);
  assert.deepEqual(proof.observedOwnedPids, [100, 101, 200, 201]);
  assert.deepEqual(proof.finalOwnedPids, []);
  assert.equal(proof.stableEmptySnapshots, 2);
  assert.equal(proof.residueCount, 0);
});

test('fails closed when a captured helper or new FastFlow residue survives', async () => {
  const baseline = [processRecord(5, 0, 'explorer.exe', 'baseline')];
  const live = [
    ...baseline,
    processRecord(300, 5, 'cert-prep-desktop.exe', 'run-3', APP_PATH),
    processRecord(301, 300, 'cert-prep-backend.exe', 'backend-3'),
  ];
  const postClose = [
    ...baseline,
    processRecord(301, 4, 'cert-prep-backend.exe', 'backend-3'),
    processRecord(302, 4, 'flm.exe', 'flm-3'),
  ];
  const snapshots = [live, postClose, postClose];
  const tracker = new OwnedProcessEvidenceTracker({
    baselineProcesses: baseline,
    snapshotProcesses: () => snapshots.shift() ?? postClose,
    wait: async () => undefined,
    releaseAttempts: 2,
  });

  tracker.captureAppTree(300, APP_PATH);
  const proof = await tracker.proveReleased(300, '2026-07-14T01:00:00.000Z');

  assert.deepEqual(proof.finalOwnedPids, [301]);
  assert.equal(proof.stableEmptySnapshots, 0);
  assert.equal(proof.residueCount, 2);
});

test('rejects a PID that is not the installed executable', () => {
  const process = processRecord(
    400,
    5,
    'cert-prep-desktop.exe',
    'run-4',
    'C:\\Temp\\other.exe',
  );
  const tracker = new OwnedProcessEvidenceTracker({
    baselineProcesses: [],
    snapshotProcesses: () => [process],
  });

  assert.throws(
    () => tracker.captureAppTree(400, APP_PATH),
    /bind the live app PID to the installed executable/,
  );
});

test('counts a newly spawned isolated Ollama process as residue', async () => {
  const baseline = [processRecord(5, 0, 'explorer.exe', 'baseline')];
  const live = [
    ...baseline,
    processRecord(500, 5, 'cert-prep-desktop.exe', 'run-5', APP_PATH),
  ];
  const postClose = [
    ...baseline,
    processRecord(501, 5, 'ollama.exe', 'ollama-5'),
  ];
  const snapshots = [live, postClose, postClose];
  const tracker = new OwnedProcessEvidenceTracker({
    baselineProcesses: baseline,
    snapshotProcesses: () => snapshots.shift() ?? postClose,
    wait: async () => undefined,
    releaseAttempts: 2,
  });

  tracker.captureAppTree(500, APP_PATH);
  const proof = await tracker.proveReleased(500, '2026-07-14T01:00:00.000Z');

  assert.equal(proof.stableEmptySnapshots, 0);
  assert.equal(proof.residueCount, 1);
});

test('rejects an observed child without an absolute executable path', () => {
  const processes = [
    processRecord(600, 5, 'cert-prep-desktop.exe', 'run-6', APP_PATH),
    processRecord(601, 600, 'cert-prep-backend.exe', 'backend-6', ''),
  ];
  const tracker = new OwnedProcessEvidenceTracker({
    baselineProcesses: [],
    snapshotProcesses: () => processes,
  });

  assert.throws(
    () => tracker.captureAppTree(600, APP_PATH),
    /could not identify process 601/,
  );
});

function processRecord(
  pid: number,
  parentPid: number,
  name: string,
  creationDate: string,
  executablePath = `C:\\Program Files\\Cert Prep\\${name}`,
): ProcessRecord {
  return {
    pid,
    parentPid,
    name,
    executablePath,
    commandLine: `"${executablePath}"`,
    creationDate,
    workingSetBytes: 1,
  };
}
