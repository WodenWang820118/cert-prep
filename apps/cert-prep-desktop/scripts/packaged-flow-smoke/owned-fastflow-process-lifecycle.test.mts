import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OwnedFastFlowProcessTracker } from './owned-fastflow-process-lifecycle.mts';
import type { ProcessRecord } from '../process-lifecycle/processes.mts';

const APP_PATH = 'C:\\Program Files\\Cert Prep\\cert-prep-desktop.exe';
const FLM_PATH = 'C:\\Program Files\\FastFlowLM\\flm.exe';

test('tracks only app descendants and publishes pid/name after stable release', async () => {
  const unrelated = processRecord(90, 1, 'flm.exe', FLM_PATH, 1_000);
  let current = [
    appProcess(),
    processRecord(11, 10, 'cert-prep-backend.exe', backendPath(), 2_100),
    processRecord(12, 11, 'flm.exe', FLM_PATH, 2_200),
    unrelated,
    processRecord(91, 1, 'flm.exe', FLM_PATH, 2_300),
  ];
  const tracker = trackerFor({
    baselineProcesses: [unrelated],
    snapshotProcesses: async () => current,
  });

  assert.equal(
    await tracker.startObservingAppTree(10, APP_PATH, FLM_PATH),
    true,
  );
  current = [appProcess()];
  assert.equal(await tracker.proveReleasedBeforeClose(10), true);
  await tracker.stopObservingAppTree();
  assert.deepEqual(tracker.preCloseEvidence(), {
    captured_at: '2026-07-13T00:00:00.000Z',
    released: true,
    pre_close_captured_at: '2026-07-13T00:00:00.000Z',
    pre_close_release_proven: true,
    pre_close_stable_empty_snapshots: 2,
    stable_empty_snapshots: 0,
    observed_owned_processes: [{ pid: 12, name: 'flm.exe' }],
    alive_owned_processes: [],
  });
  current = [unrelatedProcess()];

  const evidence = await tracker.finalize();

  assert.deepEqual(evidence, {
    captured_at: '2026-07-13T00:00:00.000Z',
    released: true,
    pre_close_captured_at: '2026-07-13T00:00:00.000Z',
    pre_close_release_proven: true,
    pre_close_stable_empty_snapshots: 2,
    stable_empty_snapshots: 2,
    observed_owned_processes: [{ pid: 12, name: 'flm.exe' }],
    alive_owned_processes: [],
  });
  assert.deepEqual(Object.keys(evidence.observed_owned_processes[0]), [
    'pid',
    'name',
  ]);
  assert.doesNotMatch(JSON.stringify(evidence), /CreationDate|Program Files|parent/i);
});

test('does not alias a reused pid to the observed FastFlow process', async () => {
  let current = appTreeWithFastFlow(2_200);
  const tracker = trackerFor({ snapshotProcesses: async () => current });
  assert.equal(
    await tracker.startObservingAppTree(10, APP_PATH, FLM_PATH),
    true,
  );

  const reused = processRecord(
    12,
    1,
    'notepad.exe',
    'C:\\Windows\\System32\\notepad.exe',
    9_900,
  );
  current = [appProcess(), reused];
  assert.equal(await tracker.proveReleasedBeforeClose(10), true);
  await tracker.stopObservingAppTree();
  current = [reused];

  const evidence = await tracker.finalize();
  assert.equal(evidence.released, true);
  assert.deepEqual(evidence.alive_owned_processes, []);
  assert.deepEqual(evidence.observed_owned_processes, [
    { pid: 12, name: 'flm.exe' },
  ]);
});

test('rejects app-root pid reuse and child creation before its parent', async () => {
  let current = [appProcess()];
  const rootReuse = trackerFor({ snapshotProcesses: async () => current });
  assert.equal(
    await rootReuse.startObservingAppTree(10, APP_PATH, FLM_PATH),
    true,
  );
  current = [
    processRecord(
      10,
      1,
      'cert-prep-desktop.exe',
      APP_PATH,
      8_000,
    ),
  ];
  assert.equal(await rootReuse.proveReleasedBeforeClose(10), false);
  await rootReuse.stopObservingAppTree();
  assert.equal(rootReuse.hasCaptureFailure(), true);

  current = [
    appProcess(),
    processRecord(11, 10, 'cert-prep-backend.exe', backendPath(), 2_100),
    processRecord(12, 11, 'flm.exe', FLM_PATH, 2_050),
  ];
  const invalidChain = trackerFor({ snapshotProcesses: async () => current });
  assert.equal(
    await invalidChain.startObservingAppTree(10, APP_PATH, FLM_PATH),
    false,
  );
  await invalidChain.stopObservingAppTree();
  assert.equal(invalidChain.hasCaptureFailure(), true);
});

test('a reappearing owned process resets the pre-close empty proof', async () => {
  const initial = appTreeWithFastFlow(2_200);
  const secondFastFlow = processRecord(13, 11, 'flm.exe', FLM_PATH, 2_400);
  const snapshots: ProcessRecord[][] = [
    initial,
    [appProcess()],
    [
      appProcess(),
      processRecord(11, 10, 'cert-prep-backend.exe', backendPath(), 2_100),
      secondFastFlow,
    ],
    [appProcess()],
    [appProcess()],
    [unrelatedProcess()],
    [unrelatedProcess()],
  ];
  const tracker = trackerFor({
    snapshotProcesses: async () => snapshots.shift() ?? [unrelatedProcess()],
    releaseSnapshotAttempts: 4,
  });
  assert.equal(
    await tracker.startObservingAppTree(10, APP_PATH, FLM_PATH),
    true,
  );

  assert.equal(await tracker.proveReleasedBeforeClose(10), true);
  await tracker.stopObservingAppTree();
  const evidence = await tracker.finalize();

  assert.equal(evidence.released, true);
  assert.deepEqual(evidence.observed_owned_processes, [
    { pid: 12, name: 'flm.exe' },
    { pid: 13, name: 'flm.exe' },
  ]);
});

test('snapshot failures and missing executable identity fail closed', async () => {
  let failSnapshot = false;
  let current = appTreeWithFastFlow(2_200);
  const failedSnapshot = trackerFor({
    snapshotProcesses: async () => {
      if (failSnapshot) {
        throw new Error('cim unavailable');
      }
      return current;
    },
  });
  assert.equal(
    await failedSnapshot.startObservingAppTree(10, APP_PATH, FLM_PATH),
    true,
  );
  failSnapshot = true;
  assert.equal(await failedSnapshot.observeAppTree(10), false);
  assert.equal(await failedSnapshot.proveReleasedBeforeClose(10), false);
  await failedSnapshot.stopObservingAppTree();
  const failedEvidence = await failedSnapshot.finalize();
  assert.equal(failedEvidence.released, false);
  assert.equal(failedEvidence.stable_empty_snapshots, 0);
  assert.deepEqual(failedEvidence.alive_owned_processes, [
    { pid: 12, name: 'flm.exe' },
  ]);

  current = [
    appProcess(),
    processRecord(11, 10, 'cert-prep-backend.exe', backendPath(), 2_100),
    processRecord(12, 11, 'flm.exe', '', 2_200),
  ];
  const missingPath = trackerFor({ snapshotProcesses: async () => current });
  assert.equal(
    await missingPath.startObservingAppTree(10, APP_PATH, FLM_PATH),
    false,
  );
  await missingPath.stopObservingAppTree();
  assert.equal(missingPath.hasCaptureFailure(), true);
});

test('stop waits for an in-flight release proof before cleanup continues', async () => {
  let snapshotCalls = 0;
  const control: {
    releaseSnapshot?: () => void;
    markSnapshotStarted?: () => void;
  } = {};
  const snapshotStarted = new Promise<void>((resolve) => {
    control.markSnapshotStarted = resolve;
  });
  const tracker = trackerFor({
    snapshotProcesses: async () => {
      snapshotCalls += 1;
      if (snapshotCalls === 2) {
        control.markSnapshotStarted?.();
        return await new Promise<ProcessRecord[]>((resolve) => {
          control.releaseSnapshot = () => resolve([appProcess()]);
        });
      }
      return [appProcess()];
    },
  });
  assert.equal(
    await tracker.startObservingAppTree(10, APP_PATH, FLM_PATH),
    true,
  );

  const proof = tracker.proveReleasedBeforeClose(10);
  await snapshotStarted;
  let stopCompleted = false;
  const stop = tracker.stopObservingAppTree().then(() => {
    stopCompleted = true;
  });
  await Promise.resolve();
  assert.equal(stopCompleted, false);

  assert.ok(control.releaseSnapshot);
  control.releaseSnapshot();
  assert.equal(await proof, true);
  await stop;
  assert.equal(stopCompleted, true);
});

test('an owned process still alive at close never passes release evidence', async () => {
  let current = appTreeWithFastFlow(2_200);
  const tracker = trackerFor({
    snapshotProcesses: async () => current,
    releaseSnapshotAttempts: 2,
  });
  assert.equal(
    await tracker.startObservingAppTree(10, APP_PATH, FLM_PATH),
    true,
  );
  assert.equal(await tracker.proveReleasedBeforeClose(10), false);
  await tracker.stopObservingAppTree();
  current = [processRecord(12, 1, 'flm.exe', FLM_PATH, 2_200)];

  const evidence = await tracker.finalize();
  assert.equal(evidence.released, false);
  assert.equal(evidence.stable_empty_snapshots, 0);
  assert.deepEqual(evidence.alive_owned_processes, [
    { pid: 12, name: 'flm.exe' },
  ]);
});

test('post-close disappearance cannot manufacture missing pre-close proof', async () => {
  let current = appTreeWithFastFlow(2_200);
  const tracker = trackerFor({
    snapshotProcesses: async () => current,
    releaseSnapshotAttempts: 2,
  });
  assert.equal(
    await tracker.startObservingAppTree(10, APP_PATH, FLM_PATH),
    true,
  );
  assert.equal(await tracker.proveReleasedBeforeClose(10), false);
  await tracker.stopObservingAppTree();

  current = [unrelatedProcess()];
  const evidence = await tracker.finalize();

  assert.equal(evidence.stable_empty_snapshots, 2);
  assert.equal(evidence.released, false);
  assert.deepEqual(evidence.alive_owned_processes, []);
});

test('post-close discovery catches a FastFlow process missed by the handoff', async () => {
  let current = [appProcess()];
  const tracker = trackerFor({
    snapshotProcesses: async () => current,
    releaseSnapshotAttempts: 2,
  });
  assert.equal(
    await tracker.startObservingAppTree(10, APP_PATH, FLM_PATH),
    true,
  );
  assert.equal(await tracker.proveReleasedBeforeClose(10), true);
  await tracker.stopObservingAppTree();

  current = [
    unrelatedProcess(),
    processRecord(77, 1, 'flm.exe', FLM_PATH, 2_500),
  ];
  const evidence = await tracker.finalize();

  assert.equal(evidence.released, false);
  assert.equal(evidence.pre_close_release_proven, false);
  assert.deepEqual(evidence.observed_owned_processes, [
    { pid: 77, name: 'flm.exe' },
  ]);
  assert.deepEqual(evidence.alive_owned_processes, [
    { pid: 77, name: 'flm.exe' },
  ]);
});

test('rejects untrusted FastFlow paths and ambiguous process tables', async () => {
  let current = appTreeWithFastFlow(2_200);
  const untrustedPath = trackerFor({ snapshotProcesses: async () => current });
  assert.equal(
    await untrustedPath.startObservingAppTree(
      10,
      APP_PATH,
      'C:\\Temp\\flm.exe',
    ),
    false,
  );
  await untrustedPath.stopObservingAppTree();
  assert.equal(untrustedPath.hasCaptureFailure(), true);

  current = [appProcess(), appProcess()];
  const duplicatePid = trackerFor({ snapshotProcesses: async () => current });
  assert.equal(
    await duplicatePid.startObservingAppTree(10, APP_PATH, FLM_PATH),
    false,
  );
  assert.equal(duplicatePid.hasCaptureFailure(), true);

  const emptySnapshot = trackerFor({ snapshotProcesses: async () => [] });
  assert.equal(
    await emptySnapshot.startObservingAppTree(10, APP_PATH, FLM_PATH),
    false,
  );
  assert.equal(emptySnapshot.hasCaptureFailure(), true);
});

function trackerFor({
  baselineProcesses = [unrelatedProcess()],
  snapshotProcesses,
  releaseSnapshotAttempts = 10,
}: {
  baselineProcesses?: readonly ProcessRecord[];
  snapshotProcesses: () => Promise<ProcessRecord[]>;
  releaseSnapshotAttempts?: number;
}): OwnedFastFlowProcessTracker {
  return new OwnedFastFlowProcessTracker({
    baselineProcesses,
    snapshotProcesses,
    delayForSnapshot: async () => undefined,
    now: () => new Date('2026-07-13T00:00:00.000Z'),
    releaseSnapshotAttempts,
    releaseSnapshotIntervalMs: 0,
    platform: 'win32',
  });
}

function appTreeWithFastFlow(fastFlowCreation: number): ProcessRecord[] {
  return [
    appProcess(),
    processRecord(11, 10, 'cert-prep-backend.exe', backendPath(), 2_100),
    processRecord(12, 11, 'flm.exe', FLM_PATH, fastFlowCreation),
  ];
}

function appProcess(): ProcessRecord {
  return processRecord(
    10,
    1,
    'cert-prep-desktop.exe',
    APP_PATH,
    2_000,
  );
}

function backendPath(): string {
  return 'C:\\Program Files\\Cert Prep\\resources\\cert-prep-backend.exe';
}

function unrelatedProcess(): ProcessRecord {
  return processRecord(
    500,
    1,
    'explorer.exe',
    'C:\\Windows\\explorer.exe',
    1_000,
  );
}

function processRecord(
  pid: number,
  parentPid: number,
  name: string,
  executablePath: string,
  creationEpochMs: number,
): ProcessRecord {
  return {
    pid,
    parentPid,
    name,
    executablePath,
    commandLine: '',
    creationDate: `/Date(${creationEpochMs})/`,
    workingSetBytes: null,
  };
}
