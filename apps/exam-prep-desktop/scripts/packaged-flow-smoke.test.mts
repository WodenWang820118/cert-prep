import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';

import {
  classifyStreamingDraftStatus,
  closeMainWindowPowerShellCommand,
  collectProcessTree,
  draftJobStatusCounts,
  isExamPrepResidue,
  parsePackagedFlowSmokeArgs,
  parseProcessSnapshotJson,
  resolveWindowsPowerShellExecutable,
  sanitizeDraftJobSnapshot,
  sanitizeQuestionDraftSnapshot,
  selectExamPrepResidue,
  selectNewWorkspaceNodeHelpers,
} from './packaged-flow-smoke.mts';

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
    processRecord(10, 1, 'exam-prep-desktop.exe', 'exam-prep-desktop.exe'),
    processRecord(11, 10, 'exam-prep-backend.exe', 'exam-prep-backend.exe'),
    processRecord(12, 11, 'exam-prep-ocr-runtime.exe', 'exam-prep-ocr-runtime.exe --ocr-worker'),
    processRecord(13, 11, 'conhost.exe', 'conhost.exe'),
    processRecord(20, 1, 'exam-prep-backend.exe', 'unrelated backend'),
  ];

  assert.deepEqual(
    collectProcessTree(processes, 10).map((record) => record.pid),
    [10, 11, 12, 13],
  );
  assert.deepEqual(
    selectExamPrepResidue(processes, 10).map((record) => record.pid),
    [10, 11, 12],
  );
  assert.equal(isExamPrepResidue(processes[3]), false);
});

test('new node helper cleanup excludes baseline and protected service processes', () => {
  const workspaceRoot = 'C:\\software-dev\\cert-prep';
  const ownerPid = 9000;
  const after = [
    processRecord(100, 1, 'node.exe', 'node C:\\tools\\nx-mcp\\server.js'),
    processRecord(200, ownerPid, 'node.exe', 'node C:\\software-dev\\cert-prep\\apps\\exam-prep-desktop\\scripts\\helper.mts'),
    processRecord(201, 200, 'node.exe', 'node C:\\software-dev\\cert-prep\\node_modules\\playwright\\driver.js'),
    processRecord(202, ownerPid, 'node.exe', 'node C:\\Users\\User\\AppData\\Local\\Programs\\Microsoft VS Code\\resources\\app\\out\\bootstrap-fork.js'),
    processRecord(203, 1, 'node.exe', 'node C:\\software-dev\\cert-prep\\other-worker.mts'),
    processRecord(204, 1, 'node.exe', `node ${join(workspaceRoot, 'tmp', 'exam-prep-desktop', 'packaged-flow-smoke', 'run', 'marker.js')}`),
  ];

  const selected = selectNewWorkspaceNodeHelpers({
    beforeNodePids: new Set([100]),
    after,
    ownerPid,
    workspaceRoot,
    runMarker: join(workspaceRoot, 'tmp', 'exam-prep-desktop', 'packaged-flow-smoke', 'run'),
  });

  assert.deepEqual(
    selected.map((record) => record.pid),
    [200, 201, 204],
  );
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
      { EXAM_PREP_POWERSHELL_EXE: 'C:\\tools\\powershell.exe' },
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

test('streaming draft status classification separates active, ready, and blockers', () => {
  assert.equal(classifyStreamingDraftStatus('Drafting 1/3'), 'active');
  assert.equal(classifyStreamingDraftStatus('2 drafts ready'), 'ready');
  assert.equal(classifyStreamingDraftStatus('Model missing'), 'blocked');
  assert.equal(
    classifyStreamingDraftStatus('Reasoning unavailable'),
    'blocked',
  );
  assert.equal(classifyStreamingDraftStatus('No draft jobs'), 'none');
});

test('streaming draft job snapshots keep status evidence without response secrets', () => {
  const payload = {
    items: [
      {
        status: 'running',
        generated_count: 0,
        question: 'SECRET streamed question',
        authorization: 'Bearer hidden-token',
      },
      { status: 'skipped_missing_model', generated_count: 2 },
      { status: 'running', generated_count: 1 },
    ],
  };

  assert.deepEqual(draftJobStatusCounts(payload), {
    running: 2,
    skipped_missing_model: 1,
  });

  const snapshot = sanitizeDraftJobSnapshot(payload, 42.4);

  assert.deepEqual(snapshot, {
    elapsed_ms: 42,
    source: 'draft-jobs',
    item_count: 3,
    status_counts: {
      running: 2,
      skipped_missing_model: 1,
    },
    generated_count: 3,
    blocker: 'skipped_missing_model',
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|hidden-token|Bearer/i);
});

test('streaming question draft snapshots count usable drafts without storing text', () => {
  const payload = {
    items: [
      {
        question: 'SECRET qwen draft',
        choices: ['SECRET A', 'B'],
        answer: 'SECRET A',
        headers: { authorization: 'Bearer hidden-token' },
      },
      {
        question: 'Incomplete draft',
        choices: ['A'],
      },
    ],
  };

  const snapshot = sanitizeQuestionDraftSnapshot(payload, 101);

  assert.deepEqual(snapshot, {
    elapsed_ms: 101,
    source: 'question-drafts',
    item_count: 2,
    usable_count: 1,
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|hidden-token|Bearer/i);
});

test('packaged flow smoke args validate numeric knobs', () => {
  assert.equal(
    parsePackagedFlowSmokeArgs(['--cdp-port', '9555', '--ocr-page-workers', '2']).cdpPort,
    9555,
  );
  assert.throws(
    () => parsePackagedFlowSmokeArgs(['--ocr-page-workers', '0']),
    /positive integer/,
  );
  assert.throws(
    () => parsePackagedFlowSmokeArgs(['--unknown']),
    /Unknown argument/,
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
