import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ChildProcess } from 'node:child_process';

import {
  closeMainWindowPowerShellCommand,
  collectProcessTree,
  createShutdownCleanupHandler,
  isCertPrepResidue,
  OwnedProcessTracker,
  parseProcessSnapshotJson,
  resolveWindowsPowerShellExecutable,
  selectCertPrepResidue,
  selectNewWorkspaceNodeHelpers,
} from './processes.mts';

test('process snapshot parsing normalizes single and array PowerShell JSON output', () => {
  assert.deepEqual(parseProcessSnapshotJson(''), []);

  assert.deepEqual(
    parseProcessSnapshotJson(
      JSON.stringify({
        ProcessId: 42,
        ParentProcessId: 7,
        Name: 'node.exe',
        ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe',
        CommandLine: 'node script.mts',
      }),
    ),
    [
      {
        pid: 42,
        parentPid: 7,
        name: 'node.exe',
        executablePath: 'C:\\Program Files\\nodejs\\node.exe',
        commandLine: 'node script.mts',
      },
    ],
  );

  assert.equal(
    parseProcessSnapshotJson(
      JSON.stringify([{ ProcessId: '100', ParentProcessId: '42', Name: 'app.exe' }]),
    )[0].pid,
    100,
  );
});

test('process tree residue detection stays scoped to launched app descendants', () => {
  const processes = [
    processRecord(10, 1, 'cert-prep-desktop.exe', 'cert-prep-desktop.exe'),
    processRecord(11, 10, 'cert-prep-backend.exe', 'cert-prep-backend.exe'),
    processRecord(12, 11, 'cert-prep-ocr-runtime.exe', 'cert-prep-ocr-runtime.exe --ocr-worker'),
    processRecord(13, 11, 'conhost.exe', 'conhost.exe'),
    processRecord(20, 1, 'cert-prep-backend.exe', 'unrelated backend'),
  ];

  assert.deepEqual(
    collectProcessTree(processes, 10).map((record) => record.pid),
    [10, 11, 12, 13],
  );
  assert.deepEqual(
    selectCertPrepResidue(processes, 10).map((record) => record.pid),
    [10, 11, 12],
  );
  assert.equal(isCertPrepResidue(processes[3]), false);
});

test('new node helper cleanup excludes baseline and protected service processes', () => {
  const workspaceRoot = 'C:\\software-dev\\cert-prep';
  const ownerPid = 9000;
  const after = [
    processRecord(100, 1, 'node.exe', 'node C:\\tools\\nx-mcp\\server.js'),
    processRecord(200, ownerPid, 'node.exe', 'node C:\\software-dev\\cert-prep\\apps\\cert-prep-desktop\\scripts\\helper.mts'),
    processRecord(201, 200, 'node.exe', 'node C:\\software-dev\\cert-prep\\node_modules\\playwright\\driver.js'),
    processRecord(202, ownerPid, 'node.exe', 'node C:\\Users\\User\\AppData\\Local\\Programs\\Microsoft VS Code\\resources\\app\\out\\bootstrap-fork.js'),
    processRecord(203, 1, 'node.exe', 'node C:\\software-dev\\cert-prep\\other-worker.mts'),
    processRecord(204, 1, 'node.exe', `node ${join(workspaceRoot, 'tmp', 'cert-prep-desktop', 'packaged-flow-smoke', 'run', 'marker.js')}`),
  ];

  const selected = selectNewWorkspaceNodeHelpers({
    beforeNodePids: new Set([100]),
    after,
    ownerPid,
    workspaceRoot,
    runMarker: join(workspaceRoot, 'tmp', 'cert-prep-desktop', 'packaged-flow-smoke', 'run'),
  });

  assert.deepEqual(
    selected.map((record) => record.pid),
    [200, 201, 204],
  );
});

test('owned process tracker cleanup is idempotent for exited children', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    exitCode: 0,
    signalCode: null,
  }) as ChildProcess;
  const tracker = new OwnedProcessTracker();
  tracker.registerChild('already-exited', child);

  const first = await tracker.cleanup('first');
  const second = tracker.cleanupSync('second');

  assert.deepEqual(first, [
    {
      label: 'already-exited',
      pid: 4242,
      reason: 'first',
      attempted: false,
      method: 'already_exited',
      alreadyExited: true,
      forced: false,
      stopped: true,
      exitCode: 0,
      signal: null,
      error: null,
    },
  ]);
  assert.deepEqual(second, first);
});

test('shutdown cleanup handler runs cleanup and exit only once', async () => {
  const previousExitCode = process.exitCode;
  const cleanupReasons: string[] = [];
  const exitCodes: number[] = [];
  try {
    const handler = createShutdownCleanupHandler({
      cleanup: async (reason) => {
        cleanupReasons.push(reason);
      },
      exit: (code) => {
        exitCodes.push(code ?? 0);
      },
    });

    await handler('SIGINT', null, 130);
    await handler('SIGTERM', null, 143);

    assert.deepEqual(cleanupReasons, ['SIGINT']);
    assert.deepEqual(exitCodes, [130]);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('close helper requests a normal Windows main-window close by PID', () => {
  const command = closeMainWindowPowerShellCommand(4242);

  assert.match(command, /Get-Process -Id 4242/);
  assert.match(command, /CloseMainWindow\(\)/);
  assert.doesNotMatch(command, /Alt\+F4/i);
  assert.doesNotMatch(command, /taskkill/i);
});

test('PowerShell executable resolution survives reduced PATH environments', () => {
  assert.equal(
    resolveWindowsPowerShellExecutable(
      { CERT_PREP_POWERSHELL_EXE: 'C:\\tools\\powershell.exe' },
      () => false,
    ),
    'C:\\tools\\powershell.exe',
  );

  assert.equal(
    resolveWindowsPowerShellExecutable({ SystemRoot: 'C:\\Windows' }, (path) =>
      path.endsWith('System32\\WindowsPowerShell\\v1.0\\powershell.exe'),
    ),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );

  assert.equal(
    resolveWindowsPowerShellExecutable({ SystemRoot: 'C:\\Windows' }, () => false),
    'powershell.exe',
  );
});

function processRecord(
  pid: number,
  parentPid: number,
  name: string,
  commandLine: string,
) {
  return {
    pid,
    parentPid,
    name,
    executablePath: '',
    commandLine,
  };
}
