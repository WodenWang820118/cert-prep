import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildProcessResidueAuditReport } from './process-residue-audit.mts';
import type { ProcessRecord } from './process-lifecycle/processes.mts';

test('process residue audit returns an explicit unsupported report off Windows', () => {
  const report = buildProcessResidueAuditReport({
    workspaceRoot: 'C:\\software-dev\\cert-prep',
    platform: 'linux',
    generatedAt: '2026-06-24T00:00:00.000Z',
    processes: [processRecord(1, 0, 'node', 'node helper')],
  });

  assert.deepEqual(report, {
    schemaVersion: 1,
    generatedAt: '2026-06-24T00:00:00.000Z',
    platform: 'linux',
    workspaceRoot: 'C:\\software-dev\\cert-prep',
    unsupportedReason:
      'Process residue audit is currently implemented for Windows only.',
    processes: [],
  });
});

test('process residue audit reports classification, actions, and working set', () => {
  const workspaceRoot = 'C:\\software-dev\\cert-prep';
  const report = buildProcessResidueAuditReport({
    workspaceRoot,
    platform: 'win32',
    generatedAt: '2026-06-24T00:00:00.000Z',
    processes: [
      processRecord(
        100,
        1,
        'python.exe',
        'python C:\\Users\\User\\.mcp\\agy-codex\\server.py',
        64_000,
      ),
      processRecord(
        101,
        1,
        'node.exe',
        'node C:\\software-dev\\cert-prep\\node_modules\\playwright\\test-server.js',
        128_000,
      ),
      processRecord(
        102,
        1,
        'cert-prep-backend.exe',
        'cert-prep-backend.exe',
        null,
      ),
    ],
  });

  assert.equal(report.unsupportedReason, null);
  assert.deepEqual(
    report.processes.map((record) => ({
      pid: record.pid,
      workingSetBytes: record.workingSetBytes,
      classification: record.classification,
      recommendedAction: record.recommendedAction,
      protected: record.protected,
    })),
    [
      {
        pid: 100,
        workingSetBytes: 64_000,
        classification: 'tooling_resident',
        recommendedAction: 'protected_do_not_touch',
        protected: true,
      },
      {
        pid: 101,
        workingSetBytes: 128_000,
        classification: 'workspace_tooling_review',
        recommendedAction: 'review_only',
        protected: false,
      },
      {
        pid: 102,
        workingSetBytes: null,
        classification: 'cert_prep_residue',
        recommendedAction: 'manual_cleanup_candidate',
        protected: false,
      },
    ],
  );
});

function processRecord(
  pid: number,
  parentPid: number,
  name: string,
  commandLine: string,
  workingSetBytes: number | null = null,
): ProcessRecord {
  return {
    pid,
    parentPid,
    name,
    executablePath: '',
    commandLine,
    workingSetBytes,
  };
}
