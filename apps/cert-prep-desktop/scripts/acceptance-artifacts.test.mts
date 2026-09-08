import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  collectAcceptanceArtifactInputs,
  sanitizeAcceptanceFixtureMetadata,
  writeAcceptanceManifest,
} from './acceptance-artifacts.mts';

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

function canonicalOcrProofBytes(): Buffer {
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
    sourceSha256: 'a'.repeat(64),
    requestedPageScope: [1],
    dmlNodeCount: 3,
    runtimeSha256: 'b'.repeat(64),
    workerSha256: 'c'.repeat(64),
    modelSha256: 'd'.repeat(64),
    profileId: 'capture-workbench-ocr-pipeline-v1',
    profileSpecSha256: 'e'.repeat(64),
    contractSetSha256: 'f'.repeat(64),
  };
  const proof = {
    ...withoutDigest,
    executionSha256: createHash('sha256')
      .update(canonical(withoutDigest))
      .digest('hex'),
  };
  return Buffer.from(`${canonical(proof)}\n`, 'utf8');
}

test('acceptance artifacts exclude isolated app data and redact logs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cert-acceptance-artifacts-'));
  try {
    const artifactRoot = join(
      root,
      'output',
      'playwright',
      'cert-prep',
      'run-1',
    );
    const screenshot = join(artifactRoot, 'ready.png');
    const log = join(artifactRoot, 'run.log');
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(screenshot, Buffer.from('png'));
    await writeFile(
      log,
      'Authorization: Bearer secret-token at C:\\Users\\Private\\fixture.pdf',
    );
    await mkdir(join(artifactRoot, 'app-data'), { recursive: true });
    await mkdir(join(artifactRoot, 'runtime'), { recursive: true });
    await writeFile(
      join(artifactRoot, 'app-data', 'private.json'),
      JSON.stringify({ raw: 'evidence' }),
    );
    await writeFile(
      join(artifactRoot, 'runtime', 'private.db'),
      Buffer.from('database'),
    );

    const artifacts = await collectAcceptanceArtifactInputs(artifactRoot);
    assert.deepEqual(
      artifacts.map((artifact) => artifact.path),
      [screenshot, log],
    );

    await writeAcceptanceManifest(artifactRoot, {
      project: 'cert-prep',
      runId: 'run-1',
      status: 'failed',
      recordVideo: false,
      artifacts,
      errors: ['Authorization: Bearer secret-token'],
      consoleErrors: [],
      pageErrors: [],
      cleanup: {
        app: false,
        sidecar: false,
        cdpPort: false,
        temporaryAppData: false,
      },
    });

    assert.doesNotMatch(
      await readFile(log, 'utf8'),
      /secret-token|C:\\Users\\Private/u,
    );
    assert.doesNotMatch(
      await readFile(join(artifactRoot, 'acceptance-manifest.json'), 'utf8'),
      /secret-token|C:\\Users\\Private/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('acceptance rejects an escaped artifact before sanitizing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cert-acceptance-containment-'));
  try {
    const artifactRoot = join(root, 'artifacts');
    const outsideLog = join(root, 'outside.log');
    const original =
      'Authorization: Bearer must-remain-untouched at C:\\Users\\Private\\fixture.pdf';
    await writeFile(outsideLog, original, 'utf8');

    await assert.rejects(
      writeAcceptanceManifest(artifactRoot, {
        project: 'cert-prep',
        runId: 'run-escaped',
        status: 'failed',
        recordVideo: false,
        artifacts: [{ path: outsideLog, kind: 'log' }],
        errors: [],
        consoleErrors: [],
        pageErrors: [],
        cleanup: {},
      }),
      /escaped its isolated output root/u,
    );
    assert.equal(await readFile(outsideLog, 'utf8'), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('acceptance persistence omits private fixture basenames from manifests and source suites', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cert-acceptance-private-fixture-'));
  try {
    const artifactRoot = join(root, 'output', 'playwright', 'cert-prep', 'run-private-fixture');
    const privateFixtureName = 'private-exam-2026.pdf';
    const sourceHash = 'a'.repeat(64);
    const sourceSuite = {
      pdf: {
        fixture: { name: privateFixtureName, sha256: sourceHash },
        evidence: { fixtureName: privateFixtureName, sourceSha256: sourceHash },
      },
    };
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(
      join(artifactRoot, 'acceptance-sources.json'),
      `${JSON.stringify(sanitizeAcceptanceFixtureMetadata(sourceSuite))}\n`,
      'utf8',
    );

    await writeAcceptanceManifest(artifactRoot, {
      project: 'cert-prep',
      runId: 'run-private-fixture',
      status: 'completed',
      recordVideo: false,
      artifacts: [],
      errors: [],
      consoleErrors: [],
      pageErrors: [],
      cleanup: {},
      fixture: { name: privateFixtureName, sha256: sourceHash },
      fixtures: sourceSuite,
      evidence: sourceSuite,
    });

    const sourceSuiteText = await readFile(
      join(artifactRoot, 'acceptance-sources.json'),
      'utf8',
    );
    const manifestText = await readFile(
      join(artifactRoot, 'acceptance-manifest.json'),
      'utf8',
    );
    assert.doesNotMatch(sourceSuiteText, /private-exam-2026\.pdf/u);
    assert.doesNotMatch(manifestText, /private-exam-2026\.pdf/u);
    const manifest = JSON.parse(manifestText) as {
      fixture?: unknown;
      fixtures?: { pdf?: { fixture?: unknown } };
      evidence?: { pdf?: { fixtureName?: unknown } };
    };
    assert.deepEqual(manifest.fixture, { sha256: sourceHash });
    assert.deepEqual(manifest.fixtures?.pdf?.fixture, { sha256: sourceHash });
    assert.equal(manifest.evidence?.pdf?.fixtureName, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('acceptance preserves the producer bytes of the OCR execution proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cert-acceptance-proof-'));
  try {
    const artifactRoot = join(root, 'output', 'playwright', 'cert-prep', 'run-proof');
    const proof = join(artifactRoot, 'ocr-device-proof-v1.json');
    const producerBytes = canonicalOcrProofBytes();
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(proof, producerBytes);

    await writeAcceptanceManifest(artifactRoot, {
      project: 'cert-prep',
      runId: 'run-proof',
      status: 'completed',
      recordVideo: false,
      artifacts: [{ path: proof, kind: 'log' }],
      errors: [],
      consoleErrors: [],
      pageErrors: [],
      cleanup: {},
    });

    assert.deepEqual(await readFile(proof), producerBytes);
    const manifest = JSON.parse(
      await readFile(join(artifactRoot, 'acceptance-manifest.json'), 'utf8'),
    ) as { artifacts: Array<{ bytes: number; sha256: string }> };
    assert.deepEqual(manifest.artifacts[0], {
      path: 'ocr-device-proof-v1.json',
      kind: 'log',
      bytes: producerBytes.length,
      sha256: createHash('sha256').update(producerBytes).digest('hex'),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('acceptance rejects a poisoned OCR proof instead of publishing a completed manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cert-acceptance-poisoned-proof-'));
  try {
    const artifactRoot = join(root, 'output', 'playwright', 'cert-prep', 'run-poisoned-proof');
    const proof = join(artifactRoot, 'ocr-device-proof-v1.json');
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(
      proof,
      `${JSON.stringify({
        schemaVersion: '1',
        token: 'Bearer secret-token',
        localPath: 'C:\\private\\fixture.jpeg',
        rawOcrText: 'sensitive OCR output',
      })}\n`,
      'utf8',
    );

    await assert.rejects(
      writeAcceptanceManifest(artifactRoot, {
        project: 'cert-prep',
        runId: 'run-poisoned-proof',
        status: 'completed',
        recordVideo: false,
        artifacts: [{ path: proof, kind: 'log' }],
        errors: [],
        consoleErrors: [],
        pageErrors: [],
        cleanup: {},
      }),
      /unsafe OCR execution proof/u,
    );
    await assert.rejects(
      readFile(join(artifactRoot, 'acceptance-manifest.json'), 'utf8'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
