import assert from 'node:assert/strict';
import test from 'node:test';

import { createResult, parseArguments } from './capture-candidate-gate.mts';

const candidateId = 'a'.repeat(64);
const manifestSha256 = 'b'.repeat(64);
const commit = 'c'.repeat(40);

test('candidate gate parses the producer dispatch contract', () => {
  const parsed = parseArguments([
    '--candidate',
    'candidate',
    '--candidate-id',
    candidateId,
    '--candidate-manifest-sha256',
    manifestSha256,
    '--source-commit',
    commit,
    '--release-version',
    '0.3.11',
    '--workflow-run-id',
    '42',
    '--output',
    'result.json',
    '--skip-checks',
  ]);
  assert.equal(parsed.workflowRunId, 42);
  assert.equal(parsed.skipChecks, true);
  assert.equal(parsed.releaseVersion, '0.3.11');
});

test('candidate gate emits the canonical independent result envelope', () => {
  const result = createResult({
    consumerCommit: commit,
    workflowRunId: 42,
    candidateId,
    candidateManifestSha256: manifestSha256,
    startedAt: '2026-08-06T00:00:00.000Z',
    completedAt: '2026-08-06T00:01:00.000Z',
    checks: [{ name: 'candidate-identity', status: 'passed' }],
  });
  assert.deepEqual(result, {
    schemaVersion: '1',
    consumerRepository: 'WodenWang820118/cert-prep',
    consumerCommit: commit,
    workflowPath: '.github/workflows/capture-candidate-gate.yml',
    workflowRunId: 42,
    candidateId,
    candidateManifestSha256: manifestSha256,
    verdict: 'passed',
    checks: [{ name: 'candidate-identity', status: 'passed' }],
    startedAt: '2026-08-06T00:00:00.000Z',
    completedAt: '2026-08-06T00:01:00.000Z',
  });
});
