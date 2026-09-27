import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  readAndValidateOcrExecutionProof,
  type OcrExecutionProofExpectation,
} from './ocr-execution-proof.mts';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const hashes = {
  sourceSha256: '9b1a' + 'a'.repeat(60),
  runtimeSha256: 'b'.repeat(64),
  workerExecutableSha256: 'c'.repeat(64),
  modelSha256: 'd'.repeat(64),
  profileSpecSha256: 'e'.repeat(64),
  contractSetSha256: 'f'.repeat(64),
};

const expected: OcrExecutionProofExpectation = {
  ...hashes,
  profileId: 'capture-workbench-ocr-pipeline-v1',
  expectedAdapterClass: 'dedicated',
  expectedAdapterDescriptionIncludes: 'RTX 4060',
};

function proofFixture(): Record<string, unknown> {
  const identity = {
    adapterClass: 'dedicated',
    adapterLuid: '00000000000000aa',
    vendorId: '10de',
    deviceId: '2204',
    subsystemId: '00000001',
    revision: '01',
    description: 'NVIDIA GeForce RTX 4060 Laptop GPU',
  };
  const identitySha256 = createHash('sha256')
    .update(canonical(identity))
    .digest('hex');
  const withoutDigest = {
    schemaVersion: '1',
    selectionProof: {
      identity: { ...identity, identitySha256 },
      highPerformanceRank: 0,
      dmlDeviceId: 0,
      adapterMapSha256: '1'.repeat(64),
      planSha256: '2'.repeat(64),
    },
    pipelineConstruction: {
      pre: {
        adapterLuid: identity.adapterLuid,
        adapterMapSha256: '1'.repeat(64),
        factoryCurrent: true,
      },
      post: {
        adapterLuid: identity.adapterLuid,
        adapterMapSha256: '1'.repeat(64),
        factoryCurrent: true,
      },
    },
    sessionDeviceProofs: [
      {
        sessionIndex: 0,
        providerOrder: ['DmlExecutionProvider', 'CPUExecutionProvider'],
        dmlDeviceId: 0,
        fallbackDisabled: true,
        dmlNodeCount: 3,
        cpuNodeCount: 1,
        evidenceSource: 'ort-graph-assignment',
      },
    ],
    sourceSha256: hashes.sourceSha256,
    requestedPageScope: [1],
    dmlNodeCount: 3,
    runtimeSha256: hashes.runtimeSha256,
    workerSha256: hashes.workerExecutableSha256,
    modelSha256: hashes.modelSha256,
    profileId: expected.profileId,
    profileSpecSha256: hashes.profileSpecSha256,
    contractSetSha256: hashes.contractSetSha256,
  };
  return {
    ...withoutDigest,
    executionSha256: createHash('sha256')
      .update(canonical(withoutDigest))
      .digest('hex'),
  };
}

async function writeProof(root: string, proof = proofFixture()): Promise<void> {
  await writeFile(
    join(root, 'ocr-device-proof-v1.json'),
    `${canonical(proof)}\n`,
    'utf8',
  );
}

test('validates one immutable GPU proof and binds every acceptance identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cert-ocr-proof-'));
  await writeProof(root);

  const result = await readAndValidateOcrExecutionProof(root, expected);

  assert.equal(result.sourceSha256, hashes.sourceSha256);
  assert.equal(result.workerSha256, hashes.workerExecutableSha256);
  assert.equal(result.adapterClass, 'dedicated');
  assert.match(result.adapterDescription, /RTX 4060/u);
  assert.equal(result.dmlNodeCount, 3);
  assert.equal(result.sessionCount, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'root'), false);
});
test('fails closed for missing, malformed, duplicate, CPU-only, and mismatched proof evidence', async () => {
  const missing = await mkdtemp(join(tmpdir(), 'cert-ocr-proof-missing-'));
  await assert.rejects(
    readAndValidateOcrExecutionProof(missing, expected),
    /exactly one/u,
  );

  const malformed = await mkdtemp(join(tmpdir(), 'cert-ocr-proof-malformed-'));
  await writeFile(join(malformed, 'ocr-device-proof-v1.json'), '{not-json', 'utf8');
  await assert.rejects(
    readAndValidateOcrExecutionProof(malformed, expected),
    /invalid/u,
  );

  const duplicate = await mkdtemp(join(tmpdir(), 'cert-ocr-proof-duplicate-'));
  await mkdir(join(duplicate, 'nested'));
  await writeProof(duplicate);
  await writeProof(join(duplicate, 'nested'));
  await assert.rejects(
    readAndValidateOcrExecutionProof(duplicate, expected),
    /exactly one/u,
  );

  for (const [label, mutate] of [
    ['source mismatch', (proof: Record<string, unknown>) => { proof.sourceSha256 = '0'.repeat(64); }],
    ['CPU-only', (proof: Record<string, unknown>) => { (proof.sessionDeviceProofs as Record<string, unknown>[])[0].dmlNodeCount = 0; }],
    ['fallback enabled', (proof: Record<string, unknown>) => { (proof.sessionDeviceProofs as Record<string, unknown>[])[0].fallbackDisabled = false; }],
  ] as const) {
    const root = await mkdtemp(join(tmpdir(), `cert-ocr-proof-${label.replaceAll(' ', '-')}-`));
    const proof = proofFixture();
    mutate(proof);
    const withoutDigest = { ...proof };
    delete withoutDigest.executionSha256;
    proof.executionSha256 = createHash('sha256').update(canonical(withoutDigest)).digest('hex');
    await writeProof(root, proof);
    await assert.rejects(readAndValidateOcrExecutionProof(root, expected));
  }
});
