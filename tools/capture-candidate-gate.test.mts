import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  rename,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import test from 'node:test';
import { basename, dirname, join } from 'node:path';

import {
  CAPTURE_DOCUMENT_SCHEMA_FILE,
  CAPTURE_DOCUMENT_SCHEMA_SHA256,
  CAPTURE_RUNTIME_FILE,
} from '../apps/cert-prep-desktop/scripts/package-qa/constants.mts';
import { CAPTURE_RUNTIME_VERSION } from './capture-runtime-version.mts';
import {
  createResult,
  assertCandidateConsumerVersionContract,
  assertConsumerVersionContract,
  parseArguments,
  reverifyCandidateArtifactReceipt,
  runCandidateGate,
  validateRuntimeCandidateContent,
  validateRuntimeCandidateManifest,
  verifyCandidateArtifactReceipt,
  verifyCandidate,
} from './capture-candidate-gate.mts';

const candidateId = 'a'.repeat(64);
const manifestSha256 = 'b'.repeat(64);
const commit = 'c'.repeat(40);
const LOCAL_PROBE_VERSION = '0.4.4';

test('strict local runtime observation rejects an unsealed inventory', async () => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'cert-runtime-candidate-'));
  try {
    const manifest = { schemaVersion: '1', candidateKind: 'runtime', sourceCommit: commit, releaseVersion: '0.4.4', releaseMode: 'model-enabled', artifacts: [] };
    const bytes = Buffer.from(JSON.stringify({ ...manifest, candidateId: sha256(Buffer.from(JSON.stringify(manifest))) }));
    await writeFile(join(root, 'candidate-manifest.json'), bytes);
    await assert.rejects(() => validateRuntimeCandidateManifest({ candidate: root, candidateId: sha256(Buffer.from(JSON.stringify(manifest))), candidateManifestSha256: sha256(bytes), sourceCommit: commit }), /canonical 20-artifact inventory/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('content-only runtime validation is invariant to source provenance', async () => {
  const fixture = await createStrictRuntimeCandidateFixture();
  try {
    const variants = [
      { name: 'valid', sourceCommit: commit },
      { name: 'missing', sourceCommit: undefined },
      { name: 'malformed', sourceCommit: 'not-a-git-sha' },
      { name: 'different', sourceCommit: 'd'.repeat(40) },
    ] as const;
    let expectedContentIdentity: Record<string, unknown> | undefined;

    for (const variant of variants) {
      const authority = await writeStrictRuntimeCandidateManifest(
        fixture,
        variant.sourceCommit,
      );
      const observation = await validateRuntimeCandidateContent({
        candidate: fixture.root,
        ...authority,
      });
      const {
        candidateId: _candidateId,
        candidateManifestSha256: _candidateManifestSha256,
        manifestSha256: _manifestSha256,
        sourceCommit: observedSourceCommit,
        ...contentIdentity
      } = observation;

      expectedContentIdentity ??= contentIdentity;
      assert.deepEqual(
        contentIdentity,
        expectedContentIdentity,
        variant.name,
      );
      assert.equal(observedSourceCommit, variant.sourceCommit, variant.name);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('strict runtime validation preserves source-commit policy', async () => {
  const fixture = await createStrictRuntimeCandidateFixture();
  try {
    const validAuthority = await writeStrictRuntimeCandidateManifest(
      fixture,
      commit,
    );
    const valid = await validateRuntimeCandidateManifest({
      candidate: fixture.root,
      ...validAuthority,
      sourceCommit: commit,
    });
    assert.equal(valid.sourceCommit, commit);

    for (const variant of [
      { name: 'missing', sourceCommit: undefined },
      { name: 'malformed', sourceCommit: 'not-a-git-sha' },
      { name: 'different', sourceCommit: 'd'.repeat(40) },
    ] as const) {
      const authority = await writeStrictRuntimeCandidateManifest(
        fixture,
        variant.sourceCommit,
      );
      await assert.rejects(
        validateRuntimeCandidateManifest({
          candidate: fixture.root,
          ...authority,
          sourceCommit: commit,
        }),
        /Local runtime candidate manifest identity is invalid\./u,
        variant.name,
      );
    }

    await assert.rejects(
      validateRuntimeCandidateManifest({
        candidate: fixture.root,
        ...validAuthority,
        sourceCommit: 'not-a-git-sha',
      }),
      /Local runtime candidate source commit is invalid\./u,
    );

    const differentAuthority = await writeStrictRuntimeCandidateManifest(
      fixture,
      'd'.repeat(40),
    );
    await writeFile(fixture.runtimePath, 'drifted runtime executable');
    await assert.rejects(
      validateRuntimeCandidateManifest({
        candidate: fixture.root,
        ...differentAuthority,
        sourceCommit: commit,
      }),
      /Local runtime candidate manifest identity is invalid\./u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('content-only runtime validation rejects one-byte artifact drift', async () => {
  const fixture = await createStrictRuntimeCandidateFixture();
  try {
    const authority = await writeStrictRuntimeCandidateManifest(fixture, commit);
    const runtimeBytes = await readFile(fixture.runtimePath);
    await writeFile(
      fixture.runtimePath,
      Buffer.concat([runtimeBytes, Buffer.from([0])]),
    );

    await assert.rejects(
      validateRuntimeCandidateContent({
        candidate: fixture.root,
        ...authority,
      }),
      /Local runtime candidate artifact changed or mismatched:/u,
    );
    await assert.rejects(
      validateRuntimeCandidateManifest({
        candidate: fixture.root,
        ...authority,
        sourceCommit: commit,
      }),
      /Local runtime candidate artifact changed or mismatched:/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

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
    CAPTURE_RUNTIME_VERSION,
    '--workflow-run-id',
    '42',
    '--output',
    'result.json',
    '--skip-checks',
  ]);
  assert.equal(parsed.workflowRunId, 42);
  assert.equal(parsed.skipChecks, true);
  assert.equal(parsed.releaseVersion, CAPTURE_RUNTIME_VERSION);
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

test('local-probe identity accepts package semver drift and direct_url metadata', async () => {
  const fixture = await createCandidateFixture({
    candidateVersion: '0.4.1',
    packageMetadata: { direct_url: 'file:///temporary/local-wheel.whl' },
  });
  try {
    const catalog = JSON.parse(
      await readFile(fixture.catalogPath, 'utf8'),
    ) as Record<string, unknown>;
    catalog.runtimeVersion = LOCAL_PROBE_VERSION;
    await writeFile(fixture.catalogPath, JSON.stringify(catalog));
    const result = await verifyCandidate({
      ...fixture.input,
      identityMode: 'local-probe',
      probeManifest: fixture.probePath,
      releaseVersion: LOCAL_PROBE_VERSION,
    });
    assert.equal(result.identity.mode, 'local-probe');
    assert.equal(
      result.identity.softChecks.find(
        (check) => check.name === 'capture-runtime-version',
      )?.observed,
      '0.4.1',
    );
    assert.equal(
      result.identity.softChecks.find(
        (check) => check.name === 'local-direct-url-metadata',
      )?.observed,
      'present',
    );
    assert.deepEqual(
      result.identity.hardChecks.map((check) => check.name),
      [
        'capture-runtime-api-2.0',
        'capture-ocr-projection-schema-3',
        'capture-contract-set-sha256',
        'capture-runtime-core-sha256',
        'capture-ocr-worker-sha256',
      ],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('local-probe identity rejects mixed runtime, worker, contract, or source-tree inputs', async () => {
  const cases: readonly {
    readonly name: string;
    readonly mutate: (fixture: CandidateFixture) => Promise<void>;
    readonly error: RegExp;
  }[] = [
    {
      name: 'runtime core',
      mutate: async (fixture) => {
        await writeFile(fixture.corePath, 'different runtime core');
      },
      error: /does not match its manifest/u,
    },
    {
      name: 'OCR worker',
      mutate: async (fixture) => {
        await writeFile(fixture.workerPath, 'different OCR worker');
        const workerBytes = await readFile(fixture.workerPath);
        await writeFile(
          fixture.catalogPath,
          JSON.stringify({
            runtimeVersion: fixture.candidateVersion,
            requirements: [
              {
                requirementId: 'windowsml-ocr',
                artifacts: [
                  {
                    fileName: basename(fixture.workerPath),
                    bytes: workerBytes.length,
                    sha256: sha256(workerBytes),
                  },
                ],
              },
            ],
          }),
        );
      },
      error: /does not match the producer probe/u,
    },
    {
      name: 'contract set',
      mutate: async (fixture) => {
        const changedContract = JSON.parse(
          await readFile(fixture.contractPath, 'utf8'),
        ) as { operations: unknown[] };
        changedContract.operations.push({
          method: 'GET',
          path: '/v2/captures/{capture_id}/result',
          responseSchema: 'CaptureDocument',
        });
        const changedContractJson = JSON.stringify(changedContract);
        const contractBytes = Buffer.from(changedContractJson);
        await writeFile(fixture.contractPath, contractBytes);
        await writeFile(fixture.contractDigestPath, sha256(contractBytes));
        const manifest = JSON.parse(
          await readFile(fixture.manifestPath, 'utf8'),
        ) as Record<string, unknown>;
        manifest.contractSetSha256 = sha256(contractBytes);
        await writeFile(fixture.manifestPath, JSON.stringify(manifest));
        fixture.input.candidateManifestSha256 = sha256(
          Buffer.from(JSON.stringify(manifest)),
        );
      },
      error: /does not match the producer probe/u,
    },
    {
      name: 'source tree',
      mutate: async (fixture) => {
        await writeFile(join(fixture.root, 'package', 'package.json'), '{}');
      },
      error: /link or non-file|only packaged Workbench archives/u,
    },
  ];
  for (const testCase of cases) {
    const fixture = await createCandidateFixture({ candidateVersion: '0.4.1' });
    try {
      await testCase.mutate(fixture);
      await assert.rejects(
        verifyCandidate({
          ...fixture.input,
          identityMode: 'local-probe',
          probeManifest: fixture.probePath,
          releaseVersion: LOCAL_PROBE_VERSION,
        }),
        testCase.error,
        testCase.name,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('release identity remains strict when candidate metadata drifts', async () => {
  const fixture = await createCandidateFixture({ candidateVersion: '0.4.1' });
  try {
    await assert.rejects(
      verifyCandidate({
        ...fixture.input,
        identityMode: 'release',
        releaseVersion: LOCAL_PROBE_VERSION,
      }),
      /Candidate manifest identity does not match/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('release identity rejects local direct_url metadata', async () => {
  const fixture = await createCandidateFixture({
    candidateVersion: LOCAL_PROBE_VERSION,
    packageMetadata: { direct_url: 'file:///temporary/local-wheel.whl' },
  });
  try {
    await assert.rejects(
      verifyCandidate({
        ...fixture.input,
        identityMode: 'release',
        releaseVersion: LOCAL_PROBE_VERSION,
      }),
      /local direct_url metadata/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('release identity accepts an exact model-enabled candidate', async () => {
  const fixture = await createCandidateFixture({
    candidateVersion: LOCAL_PROBE_VERSION,
  });
  try {
    const result = await verifyCandidate({
      ...fixture.input,
      identityMode: 'release',
      releaseVersion: LOCAL_PROBE_VERSION,
    });
    assert.equal(result.releaseMode, 'model-enabled');
    assert.equal(result.identity.mode, 'release');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('candidate artifact receipt verifies the complete producer manifest and ledger', async () => {
  const fixture = await createCombinedCandidateFixture();
  try {
    const receipt = await verifyCandidateArtifactReceipt(fixture.input);
    assert.equal(receipt.candidateId, fixture.input.candidateId);
    assert.equal(receipt.sourceCommit, fixture.input.sourceCommit);
    assert.equal(receipt.releaseVersion, fixture.input.releaseVersion);
    assert.equal(receipt.releaseMode, 'model-enabled');
    assert.match(receipt.packageCandidateId, /^[0-9a-f]{64}$/u);
    assert.match(receipt.runtimeCandidateId, /^[0-9a-f]{64}$/u);
    assert.equal(receipt.artifacts.length, fixture.artifactCount);
    await reverifyCandidateArtifactReceipt(receipt);
    await assert.rejects(
      verifyCandidateArtifactReceipt({
        ...fixture.input,
        candidateManifestSha256: '0'.repeat(64),
      }),
      /manifest hash/u,
    );
    await assert.rejects(
      verifyCandidateArtifactReceipt({
        ...fixture.input,
        candidateId: '0'.repeat(64),
      }),
      /manifest identity/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('candidate artifact receipt rejects a consistently substituted runtime schema', async () => {
  const fixture = await createCombinedCandidateFixture();
  try {
    const schemaPath = join(
      fixture.root,
      'runtime',
      CAPTURE_DOCUMENT_SCHEMA_FILE,
    );
    const substitutedSchemaBytes = Buffer.from('substituted schema bytes');
    const substitutedSchemaSha256 = sha256(substitutedSchemaBytes);
    await writeFile(schemaPath, substitutedSchemaBytes);

    const runtimeManifestPath = join(
      fixture.root,
      'runtime',
      'capture-runtime-manifest.json',
    );
    const runtimeManifest = JSON.parse(
      await readFile(runtimeManifestPath, 'utf8'),
    ) as Record<string, unknown>;
    runtimeManifest.schemaSha256 = substitutedSchemaSha256;
    const runtimeManifestBytes = Buffer.from(JSON.stringify(runtimeManifest));
    await writeFile(runtimeManifestPath, runtimeManifestBytes);

    const manifest = JSON.parse(
      await readFile(fixture.manifestPath, 'utf8'),
    ) as Record<string, unknown>;
    const artifacts = manifest.artifacts as Array<Record<string, unknown>>;
    const schemaArtifact = artifacts.find(
      (artifact) => artifact.path === `runtime/${CAPTURE_DOCUMENT_SCHEMA_FILE}`,
    );
    assert.ok(schemaArtifact);
    schemaArtifact.bytes = substitutedSchemaBytes.length;
    schemaArtifact.sha256 = substitutedSchemaSha256;
    const runtimeManifestArtifact = artifacts.find(
      (artifact) => artifact.path === 'runtime/capture-runtime-manifest.json',
    );
    assert.ok(runtimeManifestArtifact);
    runtimeManifestArtifact.bytes = runtimeManifestBytes.length;
    runtimeManifestArtifact.sha256 = sha256(runtimeManifestBytes);
    const { candidateId: _candidateId, ...baseManifest } = manifest;
    manifest.candidateId = sha256(Buffer.from(JSON.stringify(baseManifest)));
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(fixture.manifestPath, manifestBytes);
    const candidateManifestSha256 = sha256(manifestBytes);
    await writeFile(
      join(fixture.root, 'candidate-manifest.json.sha256'),
      `${candidateManifestSha256}  candidate-manifest.json\n`,
    );

    const ledgerPath = join(fixture.root, 'release-ledger.json');
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as Record<
      string,
      unknown
    >;
    ledger.candidateId = manifest.candidateId;
    ledger.candidateManifestSha256 = candidateManifestSha256;
    ledger.schemaSha256 = substitutedSchemaSha256;
    await writeFile(ledgerPath, JSON.stringify(ledger));

    await assert.rejects(
      verifyCandidateArtifactReceipt({
        ...fixture.input,
        candidateId: String(manifest.candidateId),
        candidateManifestSha256,
      }),
      /pinned canonical schema/u,
    );
    assert.notEqual(
      substitutedSchemaSha256,
      CAPTURE_DOCUMENT_SCHEMA_SHA256,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('candidate artifact receipt binds every supplied release identity', async () => {
  const fixture = await createCombinedCandidateFixture();
  try {
    const cases = [
      { field: 'releaseMode' as const, value: 'core-only' as const },
      { field: 'packageCandidateId' as const, value: '0'.repeat(64) },
      { field: 'runtimeCandidateId' as const, value: '0'.repeat(64) },
      { field: 'contractSetSha256' as const, value: '0'.repeat(64) },
    ];
    for (const testCase of cases) {
      await assert.rejects(
        verifyCandidateArtifactReceipt({
          ...fixture.input,
          [testCase.field]: testCase.value,
        }),
        /Candidate manifest identity is invalid/u,
        testCase.field,
      );
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('candidate artifact receipt rejects stale same-version bytes, size, and hash', async () => {
  const fixture = await createCombinedCandidateFixture();
  try {
    const receipt = await verifyCandidateArtifactReceipt(fixture.input);
    await writeFile(fixture.artifactPath, Buffer.from('same version but changed'));
    await assert.rejects(
      reverifyCandidateArtifactReceipt(receipt),
      /changed or mismatched/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('candidate artifact receipt rejects an omitted release-ledger entry', async () => {
  const fixture = await createCombinedCandidateFixture();
  try {
    const ledgerPath = join(fixture.root, 'release-ledger.json');
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      artifacts: unknown[];
    };
    ledger.artifacts = ledger.artifacts.slice(1);
    await writeFile(ledgerPath, JSON.stringify(ledger));
    await assert.rejects(
      verifyCandidateArtifactReceipt(fixture.input),
      /artifact inventory is incomplete/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('candidate artifact receipt rejects incomplete, extra, duplicate, and aliased records', async () => {
  const cases = [
    {
      name: 'omitted artifact',
      mutate: (manifest: Record<string, unknown>) => {
        manifest.artifacts = (manifest.artifacts as unknown[]).slice(1);
      },
      error: /does not match the candidate root/u,
    },
    {
      name: 'extra declared artifact',
      mutate: (manifest: Record<string, unknown>) => {
        const artifacts = manifest.artifacts as Array<Record<string, unknown>>;
        manifest.artifacts = [
          ...artifacts,
          { path: 'runtime/not-present.bin', bytes: 1, sha256: 'a'.repeat(64) },
        ];
      },
      error: /does not match the candidate root/u,
    },
    {
      name: 'duplicate artifact',
      mutate: (manifest: Record<string, unknown>) => {
        const artifacts = manifest.artifacts as unknown[];
        manifest.artifacts = [...artifacts, artifacts[0]];
      },
      error: /inventory is not canonical/u,
    },
    {
      name: 'traversal artifact',
      mutate: (manifest: Record<string, unknown>) => {
        const artifacts = [...(manifest.artifacts as Array<Record<string, unknown>>)];
        artifacts[0] = { ...artifacts[0], path: '../escape.bin' };
        manifest.artifacts = artifacts.sort((left, right) =>
          String(left.path).localeCompare(String(right.path)),
        );
      },
      error: /not canonical/u,
    },
  ];
  for (const testCase of cases) {
    const fixture = await createCombinedCandidateFixture();
    try {
      const input = await refreshCombinedCandidateManifest(
        fixture,
        testCase.mutate,
      );
      await assert.rejects(
        verifyCandidateArtifactReceipt(input),
        testCase.error,
        testCase.name,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('candidate artifact receipt rejects a filesystem extra and link', async () => {
  const extraFixture = await createCombinedCandidateFixture();
  try {
    await writeFile(
      join(extraFixture.root, 'runtime', 'unexpected.bin'),
      Buffer.from('unexpected'),
    );
    await assert.rejects(
      verifyCandidateArtifactReceipt(extraFixture.input),
      /does not match the candidate root/u,
    );
  } finally {
    await rm(extraFixture.root, { recursive: true, force: true });
  }

  const linkFixture = await createCombinedCandidateFixture();
  const backup = `${linkFixture.artifactPath}.regular`;
  try {
    await rename(linkFixture.artifactPath, backup);
    await symlink(backup, linkFixture.artifactPath, 'file');
    await assert.rejects(
      verifyCandidateArtifactReceipt(linkFixture.input),
      /link or non-file|regular file/u,
    );
  } catch (error) {
    if (
      !(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error.code === 'EPERM' || error.code === 'EACCES')
      )
    ) {
      throw error;
    }
  } finally {
    await rm(linkFixture.artifactPath, { force: true });
    await rename(backup, linkFixture.artifactPath).catch(() => undefined);
    await rm(linkFixture.root, { recursive: true, force: true });
  }

  const parentLinkFixture = await createCombinedCandidateFixture();
  const parentDirectory = dirname(parentLinkFixture.root);
  const parentLink = join(
    parentDirectory,
    `${basename(parentLinkFixture.root)}-parent-link`,
  );
  try {
    await symlink(
      parentDirectory,
      parentLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(
      verifyCandidateArtifactReceipt({
        ...parentLinkFixture.input,
        candidate: join(parentLink, basename(parentLinkFixture.root)),
      }),
      /symbolic-link or junction ancestor/u,
    );
  } catch (error) {
    if (
      !(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error.code === 'EPERM' ||
          error.code === 'EACCES' ||
          error.code === 'ENOTSUP')
      )
    ) {
      throw error;
    }
  } finally {
    await rm(parentLink, { recursive: true, force: true });
    await rm(parentLinkFixture.root, { recursive: true, force: true });
  }
});

test('candidate artifact receipt rejects candidate ID replay and caller mutation', async () => {
  const replayFixture = await createCombinedCandidateFixture();
  try {
    const input = await refreshCombinedCandidateManifest(
      replayFixture,
      (manifest) => {
        manifest.releaseMode = 'core-only';
      },
      true,
    );
    await assert.rejects(
      verifyCandidateArtifactReceipt(input),
      /candidateId derivation/u,
    );
  } finally {
    await rm(replayFixture.root, { recursive: true, force: true });
  }

  const mutationFixture = await createCombinedCandidateFixture();
  try {
    const receipt = await verifyCandidateArtifactReceipt(mutationFixture.input);
    assert.throws(() => {
      (receipt as { candidateId: string }).candidateId = 'f'.repeat(64);
    }, TypeError);
    assert.throws(() => {
      (receipt.artifacts as Array<unknown>).pop();
    }, TypeError);
    assert.throws(() => {
      (receipt.artifacts[0] as { sha256: string }).sha256 = 'f'.repeat(64);
    }, TypeError);
    await reverifyCandidateArtifactReceipt(receipt);
    await assert.rejects(
      reverifyCandidateArtifactReceipt({
        ...receipt,
        schemaVersion: '2',
      } as unknown as typeof receipt),
      /receipt schema/u,
    );
  } finally {
    await rm(mutationFixture.root, { recursive: true, force: true });
  }
});

const CONSUMER_INVENTORY_SOURCE_PATHS = [
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'tools/capture-runtime-version.mts',
  'apps/cert-prep-backend/pyproject.toml',
  'apps/cert-prep-backend/uv.lock',
  'apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/runtime_policy.py',
  'apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/mapping.py',
  'apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/client.py',
  'apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/runtime_provenance.py',
  'apps/cert-prep-desktop/src-tauri/src/constants.rs',
  'apps/cert-prep-desktop/src-tauri/Cargo.toml',
  'apps/cert-prep-desktop/src-tauri/Cargo.lock',
  'apps/cert-prep-desktop/src-tauri/src/capture_manifest.rs',
  'apps/cert-prep-desktop/src-tauri/src/manifests.rs',
  'apps/cert-prep-desktop/src-tauri/src/backend_process.rs',
  'apps/cert-prep-desktop/src-tauri/src/capture_runtime.rs',
  'apps/cert-prep-desktop/project.json',
  'apps/cert-prep-desktop/scripts/package-qa/constants.mts',
  'tools/install-capture-runtime.mts',
  'tools/capture-runtime-consumer-smoke.mts',
  'apps/cert-prep/src/app/pages/capture-workbench-trial/cert-prep-capture-client.ts',
  'libs/cert-prep-api/src/lib/cert-prep-api.generated.ts',
] as const;

async function createConsistentConsumerWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(
    join(
      process.env.TEMP ?? process.env.TMP ?? '.',
      'cert-candidate-consumer-4-2-',
    ),
  );
  const sourceRoot = join(import.meta.dirname, '..');
  for (const relativePath of CONSUMER_INVENTORY_SOURCE_PATHS) {
    const destination = join(workspaceRoot, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(sourceRoot, relativePath), destination);
  }

  const replace = async (
    relativePath: string,
    transform: (content: string) => string,
  ): Promise<void> => {
    const path = join(workspaceRoot, relativePath);
    await writeFile(path, transform(await readFile(path, 'utf8')));
  };
  await replace('package.json', (content) =>
    content.replace(
      /("@gx-capture\/capture-workbench-ui"\s*:\s*")0\.4\.1("\s*[,}])/u,
      '$10.4.4$2',
    ),
  );
  await replace('pnpm-workspace.yaml', (content) =>
    content.replace(
      /(@gx-capture\/capture-(?:workbench-ui|runtime-client)@)0\.4\.1/gu,
      '$10.4.4',
    ),
  );
  await replace('pnpm-lock.yaml', (content) =>
    content.replace(
      /(@gx-capture\/capture-(?:workbench-ui|runtime-client)@)0\.4\.1/gu,
      '$10.4.4',
    ),
  );
  await replace('tools/capture-runtime-version.mts', (content) =>
    content.replaceAll("'0.4.1'", "'0.4.4'"),
  );
  await replace('apps/cert-prep-backend/pyproject.toml', (content) =>
    content.replaceAll('capture-runtime-client==0.4.1', 'capture-runtime-client==0.4.4'),
  );
  await replace('apps/cert-prep-backend/uv.lock', (content) =>
    content.replace(
      /(name = "capture-runtime-client"\r?\nversion = ")0\.4\.1("\r?\n)/u,
      '$10.4.4$2',
    ),
  );
  await replace('apps/cert-prep-desktop/src-tauri/src/constants.rs', (content) =>
    content.replaceAll('"0.4.1"', '"0.4.4"'),
  );
  await replace('apps/cert-prep-desktop/src-tauri/Cargo.toml', (content) =>
    content.replace(
      /(capture-sidecar-launcher\s*=\s*")0\.4\.1("\s*$)/mu,
      '$10.4.4$2',
    ),
  );
  await replace('apps/cert-prep-desktop/src-tauri/Cargo.lock', (content) =>
    content.replace(
      /(\[\[package\]\]\r?\nname = "capture-sidecar-launcher"\r?\nversion = ")0\.4\.1("\r?\n)/u,
      '$10.4.4$2',
    ),
  );
  await replace('apps/cert-prep-desktop/project.json', (content) =>
    content.replaceAll('capture-runtime/0.4.1', 'capture-runtime/0.4.4'),
  );
  await mkdir(join(workspaceRoot, 'node_modules/@gx-capture/capture-workbench-ui'), {
    recursive: true,
  });
  await mkdir(join(workspaceRoot, 'node_modules/@gx-capture/capture-runtime-client'), {
    recursive: true,
  });
  await writeFile(
    join(
      workspaceRoot,
      'node_modules/@gx-capture/capture-workbench-ui/package.json',
    ),
    JSON.stringify({ name: '@gx-capture/capture-workbench-ui', version: '0.4.4' }),
  );
  await writeFile(
    join(
      workspaceRoot,
      'node_modules/@gx-capture/capture-runtime-client/package.json',
    ),
    JSON.stringify({ name: '@gx-capture/capture-runtime-client', version: '0.4.4' }),
  );
  return workspaceRoot;
}

async function rewriteCandidateContract(
  fixture: CandidateFixture,
  value: unknown,
): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value));
  await writeFile(fixture.contractPath, bytes);
  await writeFile(fixture.contractDigestPath, sha256(bytes));
  const manifest = JSON.parse(
    await readFile(fixture.manifestPath, 'utf8'),
  ) as Record<string, unknown>;
  manifest.contractSetSha256 = sha256(bytes);
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(fixture.manifestPath, manifestBytes);
  fixture.input.candidateManifestSha256 = sha256(manifestBytes);
}

test('file candidate binds verified contract bytes and reaches complete inventory', async () => {
  const fixture = await createCandidateFixture({ candidateVersion: '0.4.4' });
  const workspaceRoot = await createConsistentConsumerWorkspace();
  try {
    const verified = await verifyCandidate({
      ...fixture.input,
      identityMode: 'release',
      releaseVersion: '0.4.4',
    });
    const before = Buffer.from(verified.contractSource.bytes);
    await assertCandidateConsumerVersionContract({
      workspaceRoot,
      expectedVersion: '0.4.4',
      contractSource: verified.contractSource,
    });
    assert.deepEqual(Buffer.from(verified.contractSource.bytes), before);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('file dependency cannot bypass the verified consumer contract source', async () => {
  const fixture = await createCandidateFixture({ candidateVersion: '0.4.4' });
  const workspaceRoot = await createConsistentConsumerWorkspace();
  try {
    const packagePath = join(workspaceRoot, 'package.json');
    const packageManifest = JSON.parse(await readFile(packagePath, 'utf8')) as {
      dependencies: Record<string, unknown>;
    };
    packageManifest.dependencies['@gx-capture/capture-workbench-ui'] =
      'file:../candidate';
    await writeFile(packagePath, JSON.stringify(packageManifest));
    await assert.rejects(
      assertConsumerVersionContract('0.4.4', 'release', undefined, workspaceRoot),
      /Verified candidate consumer contract source is required/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('a newer candidate cannot use the published consumer pins as a bypass', async () => {
  const fixture = await createCandidateFixture({ candidateVersion: '99.0.0' });
  let nxCalled = false;
  let outputWritten = false;
  try {
    await assert.rejects(
      runCandidateGate(
        {
          ...fixture.input,
          identityMode: 'release',
          releaseVersion: '99.0.0',
          output: join(fixture.root, 'result.json'),
          workflowRunId: 2,
          skipChecks: false,
        },
        {
          workspaceRoot: join(import.meta.dirname, '..'),
          runNx: () => {
            nxCalled = true;
          },
          writeResult: async () => {
            outputWritten = true;
          },
          consumerCommit: commit,
        },
      ),
      /Capture Runtime consumer inventory blocked/u,
    );
    assert.equal(nxCalled, false);
    assert.equal(outputWritten, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('the exact published pin non-file path passes without a candidate contract', async () => {
  const fixture = await createCandidateFixture({
    candidateVersion: CAPTURE_RUNTIME_VERSION,
  });
  const nxTargets: string[] = [];
  let outputWritten = false;
  try {
    const result = await runCandidateGate(
      {
        ...fixture.input,
        identityMode: 'release',
        releaseVersion: CAPTURE_RUNTIME_VERSION,
        output: join(fixture.root, 'legacy-result.json'),
        workflowRunId: 5,
        skipChecks: false,
      },
      {
        workspaceRoot: join(import.meta.dirname, '..'),
        runNx: (target) => nxTargets.push(target),
        writeResult: async () => {
          outputWritten = true;
        },
        consumerCommit: commit,
      },
    );
    assert.equal(result.verdict, 'passed');
    assert.deepEqual(nxTargets, [
      'cert-prep-desktop:capture-runtime-consumer-test',
      'cert-prep-backend:test',
      'cert-prep-desktop:package-qa-test',
    ]);
    assert.equal(outputWritten, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a consistent phase2 non-file candidate reaches Nx and result output only after inventory', async () => {
  const fixture = await createCandidateFixture({ candidateVersion: '0.4.4' });
  const workspaceRoot = await createConsistentConsumerWorkspace();
  const nxTargets: string[] = [];
  let outputWritten = false;
  try {
    const result = await runCandidateGate(
      {
        ...fixture.input,
        identityMode: 'release',
        releaseVersion: '0.4.4',
        output: join(workspaceRoot, 'result.json'),
        workflowRunId: 3,
        skipChecks: false,
      },
      {
        workspaceRoot,
        runNx: (target) => nxTargets.push(target),
        writeResult: async () => {
          outputWritten = true;
        },
        consumerCommit: commit,
      },
    );
    assert.equal(result.verdict, 'passed');
    assert.deepEqual(nxTargets, [
      'cert-prep-desktop:capture-runtime-consumer-test',
      'cert-prep-backend:test',
      'cert-prep-desktop:package-qa-test',
    ]);
    assert.equal(outputWritten, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('contract source and manifest failures stop before Nx and result output', async () => {
  const fixture = await createCandidateFixture({ candidateVersion: '0.4.4' });
  const workspaceRoot = await createConsistentConsumerWorkspace();
  let nxCalled = false;
  let outputWritten = false;
  try {
    await rm(fixture.contractPath);
    await assert.rejects(
      runCandidateGate(
        {
          ...fixture.input,
          identityMode: 'release',
          releaseVersion: '0.4.4',
          output: join(workspaceRoot, 'result.json'),
          workflowRunId: 1,
          skipChecks: false,
        },
        {
          workspaceRoot,
          runNx: () => {
            nxCalled = true;
          },
          writeResult: async () => {
            outputWritten = true;
          },
          consumerCommit: commit,
        },
      ),
      /Candidate contract set is not readable/u,
    );
    assert.equal(nxCalled, false);
    assert.equal(outputWritten, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('contract bytes, sidecar digest, and manifest digest are all required', async () => {
  const fixture = await createCandidateFixture({ candidateVersion: '0.4.4' });
  try {
    const validContract = JSON.parse(
      await readFile(fixture.contractPath, 'utf8'),
    );
    await writeFile(fixture.contractDigestPath, 'f'.repeat(64));
    await assert.rejects(
      verifyCandidate({
        ...fixture.input,
        identityMode: 'release',
        releaseVersion: '0.4.4',
      }),
      /Candidate contract-set SHA-256 file does not match its bytes/u,
    );

    await rewriteCandidateContract(fixture, validContract);
    const manifest = JSON.parse(
      await readFile(fixture.manifestPath, 'utf8'),
    ) as Record<string, unknown>;
    manifest.contractSetSha256 = 'e'.repeat(64);
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(fixture.manifestPath, manifestBytes);
    fixture.input.candidateManifestSha256 = sha256(manifestBytes);
    await assert.rejects(
      verifyCandidate({
        ...fixture.input,
        identityMode: 'release',
        releaseVersion: '0.4.4',
      }),
      /Candidate manifest contract-set SHA-256 does not match/u,
    );

    await writeFile(fixture.contractPath, '{');
    const malformedBytes = await readFile(fixture.contractPath);
    await writeFile(fixture.contractDigestPath, sha256(malformedBytes));
    const malformedManifest = JSON.parse(
      await readFile(fixture.manifestPath, 'utf8'),
    ) as Record<string, unknown>;
    malformedManifest.contractSetSha256 = sha256(malformedBytes);
    const malformedManifestBytes = Buffer.from(JSON.stringify(malformedManifest));
    await writeFile(fixture.manifestPath, malformedManifestBytes);
    fixture.input.candidateManifestSha256 = sha256(malformedManifestBytes);
    await assert.rejects(
      verifyCandidate({
        ...fixture.input,
        identityMode: 'release',
        releaseVersion: '0.4.4',
      }),
      /Candidate contract set is not valid JSON/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('wrong contract identity is rejected by complete inventory after byte binding', async () => {
  const fixture = await createCandidateFixture({ candidateVersion: '0.4.4' });
  const workspaceRoot = await createConsistentConsumerWorkspace();
  let nxCalled = false;
  let outputWritten = false;
  try {
    const wrongContract = {
      contractSetVersion: '9',
      schemas: [
        {
          name: 'CaptureOcrProjectionV3',
          schema: {
            properties: {
              apiVersion: { const: '9.0' },
              runtimeVersion: { const: '9.9.9' },
              schemaVersion: { const: '3' },
            },
          },
        },
        {
          name: 'OcrComputePreflightV2',
          schema: {
            properties: {
              apiVersion: { const: '9.0' },
              contractSetVersion: { const: '9' },
              runtimeVersion: { const: '9.9.9' },
              schemaVersion: { const: '9' },
            },
          },
        },
        {
          name: 'RuntimeReady',
          schema: {
            properties: {
              apiVersion: { const: '9.0' },
              captureDocumentSchemaVersion: { const: '9' },
              contractSetVersion: { const: '9' },
              runtimeVersion: { const: '9.9.9' },
            },
          },
        },
      ],
      operations: [
        {
          method: 'GET',
          path: '/v2/captures/{capture_id}/ocr',
          responseSchema: 'CaptureOcrProjectionV3',
        },
      ],
    };
    await rewriteCandidateContract(fixture, wrongContract);
    await assert.rejects(
      runCandidateGate(
        {
          ...fixture.input,
          identityMode: 'release',
          releaseVersion: '0.4.4',
          output: join(workspaceRoot, 'result.json'),
          workflowRunId: 4,
          skipChecks: false,
        },
        {
          workspaceRoot,
          runNx: () => {
            nxCalled = true;
          },
          writeResult: async () => {
            outputWritten = true;
          },
          consumerCommit: commit,
        },
      ),
      /Capture Runtime consumer inventory blocked/u,
    );
    assert.equal(nxCalled, false);
    assert.equal(outputWritten, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('wrong projection schema identity is rejected from candidate contract bytes', async () => {
  const fixture = await createCandidateFixture({ candidateVersion: '0.4.4' });
  try {
    const contract = JSON.parse(
      await readFile(fixture.contractPath, 'utf8'),
    ) as {
      schemas: { name: string; schema: { properties: { schemaVersion: { const: string } } } }[];
    };
    const projection = contract.schemas.find(
      (schema) => schema.name === 'CaptureOcrProjectionV3',
    );
    assert.ok(projection);
    projection.schema.properties.schemaVersion.const = '9';
    await rewriteCandidateContract(fixture, contract);
    await assert.rejects(
      verifyCandidate({
        ...fixture.input,
        identityMode: 'release',
        releaseVersion: '0.4.4',
      }),
      /Candidate CaptureOcrProjectionV3 schema version must be 3/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('missing consumer inventory owner fails closed before mutation', async () => {
  const fixture = await createCandidateFixture({ candidateVersion: '0.4.4' });
  const workspaceRoot = await createConsistentConsumerWorkspace();
  try {
    const packagePath = join(workspaceRoot, 'package.json');
    const packageManifest = JSON.parse(await readFile(packagePath, 'utf8')) as {
      dependencies: Record<string, unknown>;
    };
    delete packageManifest.dependencies['@gx-capture/capture-workbench-ui'];
    await writeFile(packagePath, JSON.stringify(packageManifest));
    const verified = await verifyCandidate({
      ...fixture.input,
      identityMode: 'release',
      releaseVersion: '0.4.4',
    });
    await assert.rejects(
      assertCandidateConsumerVersionContract({
        workspaceRoot,
        expectedVersion: '0.4.4',
        contractSource: verified.contractSource,
      }),
      /Capture Runtime consumer inventory blocked/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

interface CandidateFixture {
  readonly root: string;
  readonly candidateVersion: string;
  readonly probePath: string;
  readonly manifestPath: string;
  readonly corePath: string;
  readonly workerPath: string;
  readonly catalogPath: string;
  readonly contractPath: string;
  readonly contractDigestPath: string;
  readonly input: {
    readonly candidate: string;
    readonly candidateId: string;
    candidateManifestSha256: string;
    readonly sourceCommit: string;
    releaseVersion: string;
  };
}

async function createCandidateFixture(input: {
  readonly candidateVersion: string;
  readonly packageMetadata?: Record<string, unknown>;
}): Promise<CandidateFixture> {
  const root = await mkdtemp(
    join(process.env.TEMP ?? process.env.TMP ?? '.', 'cert-candidate-gate-'),
  );
  const runtimeRoot = join(root, 'runtime');
  const packageRoot = join(root, 'package');
  const contractsRoot = join(root, 'contracts');
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(packageRoot, { recursive: true });
  await mkdir(contractsRoot, { recursive: true });
  if (input.packageMetadata?.direct_url) {
    const pythonRoot = join(root, 'python');
    await mkdir(pythonRoot, { recursive: true });
    await writeFile(
      join(pythonRoot, 'direct_url.json'),
      JSON.stringify({ direct_url: input.packageMetadata.direct_url }),
    );
  }

  const corePath = join(runtimeRoot, CAPTURE_RUNTIME_FILE);
  const workerName = `capture-engine-ocr-${input.candidateVersion}-windows-x64.zip`;
  const workerPath = join(runtimeRoot, workerName);
  const coreBytes = Buffer.from('runtime core');
  const workerBytes = Buffer.from('OCR worker');
  await writeFile(corePath, coreBytes);
  await writeFile(workerPath, workerBytes);
  const schemaPath = join(runtimeRoot, CAPTURE_DOCUMENT_SCHEMA_FILE);
  await writeFile(
    schemaPath,
    await readFile(
      join(
        import.meta.dirname,
        '..',
        'apps/cert-prep-desktop/test-fixtures',
        CAPTURE_DOCUMENT_SCHEMA_FILE,
      ),
    ),
  );
  await writeFile(
    join(runtimeRoot, `${CAPTURE_RUNTIME_FILE}.sha256`),
    `${sha256(coreBytes)}  ${CAPTURE_RUNTIME_FILE}\n`,
  );
  await writeFile(
    join(runtimeRoot, 'capture-runtime-manifest.json'),
    JSON.stringify({
      manifestVersion: '1',
      runtimeVersion: input.candidateVersion,
      apiVersion: '2.0',
      captureDocumentSchemaVersion: '2',
      platform: 'windows',
      arch: 'x86_64',
      fileName: CAPTURE_RUNTIME_FILE,
      bytes: coreBytes.length,
      sha256: sha256(coreBytes),
      schemaFileName: CAPTURE_DOCUMENT_SCHEMA_FILE,
      schemaSha256: CAPTURE_DOCUMENT_SCHEMA_SHA256,
    }),
  );
  const catalogPath = join(runtimeRoot, 'capture-engine-catalog.json');
  await writeFile(
    catalogPath,
    JSON.stringify({
      runtimeVersion: input.candidateVersion,
      requirements: [
        {
          requirementId: 'windowsml-ocr',
          artifacts: [
            {
              fileName: workerName,
              bytes: workerBytes.length,
              sha256: sha256(workerBytes),
            },
          ],
        },
      ],
    }),
  );
  const contractPath = join(contractsRoot, 'contract-set.json');
  const contractBytes = Buffer.from(
    JSON.stringify({
      contractSetVersion: '2',
      schemas: [
        {
          name: 'CaptureOcrProjectionV3',
          schema: {
            properties: {
              apiVersion: { const: '2.0' },
              runtimeVersion: { const: input.candidateVersion },
              schemaVersion: { const: '3' },
            },
          },
        },
        {
          name: 'OcrComputePreflightV2',
          schema: {
            properties: {
              apiVersion: { const: '2.0' },
              contractSetVersion: { const: '2' },
              runtimeVersion: { const: input.candidateVersion },
              schemaVersion: { const: '1' },
            },
          },
        },
        {
          name: 'RuntimeReady',
          schema: {
            properties: {
              apiVersion: { const: '2.0' },
              captureDocumentSchemaVersion: { const: '2' },
              contractSetVersion: { const: '2' },
              runtimeVersion: { const: input.candidateVersion },
            },
          },
        },
      ],
      operations: [
        {
          method: 'GET',
          path: '/v2/captures/{capture_id}/ocr',
          responseSchema: 'CaptureOcrProjectionV3',
        },
      ],
    }),
  );
  await writeFile(contractPath, contractBytes);
  const contractSetSha256 = sha256(contractBytes);
  const contractDigestPath = join(contractsRoot, 'contract-set.sha256');
  await writeFile(contractDigestPath, contractSetSha256);

  const packageName = `gx-capture-capture-workbench-ui-${input.candidateVersion}.tgz`;
  await writeFile(
    join(packageRoot, packageName),
    JSON.stringify(input.packageMetadata ?? { package: 'archive' }),
  );
  const sourceCommit = 'c'.repeat(40);
  const candidateId = 'a'.repeat(64);
  const manifestPath = join(root, 'candidate-manifest.json');
  const manifest = {
    candidateId,
    sourceCommit,
    releaseVersion: input.candidateVersion,
    releaseMode: 'model-enabled',
    contractSetSha256,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(manifestPath, manifestBytes);
  const probePath = join(root, 'probe.json');
  await writeFile(
    probePath,
    JSON.stringify({
      manifestKind: 'capture-phase1-probe',
      runtimeVersion: LOCAL_PROBE_VERSION,
      apiVersion: '2.0',
      ocrProjectionSchemaVersion: '3',
      contractSetSha256,
      sourceCommit,
      artifacts: [
        {
          id: CAPTURE_RUNTIME_FILE,
          bytes: coreBytes.length,
          sha256: sha256(coreBytes),
        },
        {
          id: workerName,
          bytes: workerBytes.length,
          sha256: sha256(workerBytes),
        },
      ],
    }),
  );
  return {
    root,
    candidateVersion: input.candidateVersion,
    probePath,
    manifestPath,
    corePath,
    workerPath,
    catalogPath,
    contractPath,
    contractDigestPath,
    input: {
      candidate: root,
      candidateId,
      candidateManifestSha256: sha256(manifestBytes),
      sourceCommit,
      releaseVersion: input.candidateVersion,
    },
  };
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

interface StrictRuntimeCandidateFixture {
  readonly root: string;
  readonly runtimePath: string;
  readonly contractSetSha256: string;
  readonly artifacts: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
}

async function createStrictRuntimeCandidateFixture(): Promise<StrictRuntimeCandidateFixture> {
  const root = await mkdtemp(
    join(
      process.env.TEMP ?? process.env.TMP ?? '.',
      'cert-strict-runtime-candidate-',
    ),
  );
  for (const directory of ['runtime', 'contracts', 'python', 'crate']) {
    await mkdir(join(root, directory), { recursive: true });
  }

  const runtimeBytes = Buffer.from('strict runtime executable');
  const runtimePath = join(root, 'runtime', CAPTURE_RUNTIME_FILE);
  const schemaBytes = await readFile(
    join(
      import.meta.dirname,
      '..',
      'apps/cert-prep-desktop/test-fixtures',
      CAPTURE_DOCUMENT_SCHEMA_FILE,
    ),
  );
  const runtimeManifestBytes = Buffer.from(
    JSON.stringify({
      manifestVersion: '1',
      runtimeVersion: LOCAL_PROBE_VERSION,
      apiVersion: '2.0',
      captureDocumentSchemaVersion: '2',
      platform: 'windows',
      arch: 'x86_64',
      fileName: CAPTURE_RUNTIME_FILE,
      bytes: runtimeBytes.length,
      sha256: sha256(runtimeBytes),
      schemaFileName: CAPTURE_DOCUMENT_SCHEMA_FILE,
      schemaSha256: CAPTURE_DOCUMENT_SCHEMA_SHA256,
    }),
  );
  const contractBytes = Buffer.from(
    JSON.stringify({
      contractSetVersion: '2',
      operations: [
        {
          method: 'GET',
          path: '/v2/captures/{capture_id}/ocr',
          responseSchema: 'CaptureOcrProjectionV3',
        },
      ],
    }),
  );
  const contractSetSha256 = sha256(contractBytes);
  const profileArtifacts = [
    'detector.onnx',
    'recognizer.onnx',
    'classifier.onnx',
    'dictionary.txt',
    'metadata.json',
  ].map((path) => {
    const bytes = Buffer.from(`model:${path}`);
    return { path, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const profileBytes = Buffer.from(
    JSON.stringify({
      algorithm: 'capture-workbench-ocr-profile-v2',
      releaseVersion: LOCAL_PROBE_VERSION,
      model: 'pp-ocrv6-medium-windowsml',
      device: 'windowsml-dml',
      cpuFallback: 'provider-missing-only',
      failClosedOnDmlError: true,
      artifacts: profileArtifacts,
    }),
  );
  const profilePath = '_internal/capture_runtime/assets/ocr-profile.json';
  const ocrArchiveName =
    `capture-engine-ocr-${LOCAL_PROBE_VERSION}-windows-x64.zip`;
  const ocrArchivePath = join(root, 'runtime', ocrArchiveName);
  writeZipEntry(ocrArchivePath, profilePath, profileBytes);
  const ocrArchiveBytes = await readFile(ocrArchivePath);
  const ocrFilesManifestBytes = Buffer.from(
    JSON.stringify({
      files: [
        {
          path: 'capture-engine-ocr.exe',
          bytes: 17,
          sha256: sha256(Buffer.from('ocr executable')),
        },
        {
          path: profilePath,
          bytes: profileBytes.length,
          sha256: sha256(profileBytes),
        },
      ],
    }),
  );
  const modelFiles = [
    {
      path: 'model/pipeline.json',
      bytes: profileBytes.length,
      sha256: sha256(profileBytes),
    },
    ...profileArtifacts.map((artifact) => ({
      ...artifact,
      path: `model/${artifact.path}`,
    })),
  ];
  const catalogBytes = Buffer.from(
    JSON.stringify({
      runtimeVersion: LOCAL_PROBE_VERSION,
      requirements: [
        {
          requirementId: 'windowsml-ocr',
          artifacts: [
            {
              fileName: ocrArchiveName,
              entryPoint: 'capture-engine-ocr.exe',
              bytes: ocrArchiveBytes.length,
              sha256: sha256(ocrArchiveBytes),
              filesManifestSha256: sha256(ocrFilesManifestBytes),
            },
          ],
          modelFiles: {
            entryCount: modelFiles.length,
            files: modelFiles,
          },
        },
      ],
    }),
  );
  const whisperFilesManifestBytes = Buffer.from(JSON.stringify({ files: [] }));
  const whisperArchiveBytes = Buffer.from('strict whisper archive');
  const artifactContents = new Map<string, Buffer>([
    [`runtime/${CAPTURE_RUNTIME_FILE}`, runtimeBytes],
    [
      `runtime/${CAPTURE_RUNTIME_FILE}.sha256`,
      Buffer.from(`${sha256(runtimeBytes)}  ${CAPTURE_RUNTIME_FILE}\n`),
    ],
    ['runtime/capture-runtime-manifest.json', runtimeManifestBytes],
    [`runtime/${CAPTURE_DOCUMENT_SCHEMA_FILE}`, schemaBytes],
    ['runtime/capture-engine-catalog.json', catalogBytes],
    [
      'runtime/capture-engine-catalog.json.sha256',
      Buffer.from(sha256(catalogBytes)),
    ],
    [
      `runtime/capture-engine-ocr-${LOCAL_PROBE_VERSION}-windows-x64-files.json`,
      ocrFilesManifestBytes,
    ],
    [
      `runtime/capture-engine-ocr-${LOCAL_PROBE_VERSION}-windows-x64-files.json.sha256`,
      Buffer.from(sha256(ocrFilesManifestBytes)),
    ],
    [`runtime/${ocrArchiveName}`, ocrArchiveBytes],
    [
      `runtime/${ocrArchiveName}.sha256`,
      Buffer.from(sha256(ocrArchiveBytes)),
    ],
    [
      `runtime/capture-engine-whisper-${LOCAL_PROBE_VERSION}-windows-x64-files.json`,
      whisperFilesManifestBytes,
    ],
    [
      `runtime/capture-engine-whisper-${LOCAL_PROBE_VERSION}-windows-x64-files.json.sha256`,
      Buffer.from(sha256(whisperFilesManifestBytes)),
    ],
    [
      `runtime/capture-engine-whisper-${LOCAL_PROBE_VERSION}-windows-x64.zip`,
      whisperArchiveBytes,
    ],
    [
      `runtime/capture-engine-whisper-${LOCAL_PROBE_VERSION}-windows-x64.zip.sha256`,
      Buffer.from(sha256(whisperArchiveBytes)),
    ],
    [
      `python/capture_runtime_client-${LOCAL_PROBE_VERSION}-py3-none-any.whl`,
      Buffer.from('strict wheel'),
    ],
    [
      `python/capture_runtime_client-${LOCAL_PROBE_VERSION}.tar.gz`,
      Buffer.from('strict source archive'),
    ],
    [
      `crate/capture-sidecar-launcher-${LOCAL_PROBE_VERSION}.crate`,
      Buffer.from('strict launcher crate'),
    ],
    ['contracts/contract-set.json', contractBytes],
    ['contracts/contract-set.sha256', Buffer.from(contractSetSha256)],
    ['contracts/contract-snapshot.json', Buffer.from('{"snapshot":"strict"}')],
  ]);

  for (const [path, bytes] of artifactContents) {
    await writeFile(join(root, path), bytes);
  }
  const artifacts = [...artifactContents]
    .map(([path, bytes]) => ({
      path,
      bytes: bytes.length,
      sha256: sha256(bytes),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  return { root, runtimePath, contractSetSha256, artifacts };
}

async function writeStrictRuntimeCandidateManifest(
  fixture: StrictRuntimeCandidateFixture,
  sourceCommit: string | undefined,
): Promise<{
  readonly candidateId: string;
  readonly candidateManifestSha256: string;
}> {
  const baseManifest = {
    schemaVersion: '1',
    candidateKind: 'runtime',
    ...(sourceCommit === undefined ? {} : { sourceCommit }),
    releaseVersion: LOCAL_PROBE_VERSION,
    releaseMode: 'model-enabled',
    contractSetSha256: fixture.contractSetSha256,
    artifacts: fixture.artifacts,
  };
  const candidateId = sha256(Buffer.from(JSON.stringify(baseManifest)));
  const manifestBytes = Buffer.from(
    JSON.stringify({ ...baseManifest, candidateId }),
  );
  await writeFile(join(fixture.root, 'candidate-manifest.json'), manifestBytes);
  return {
    candidateId,
    candidateManifestSha256: sha256(manifestBytes),
  };
}

function writeZipEntry(
  archive: string,
  entry: string,
  content: Uint8Array,
): void {
  const script = [
    'import base64,sys,zipfile',
    "with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_STORED) as archive:",
    ' archive.writestr(sys.argv[2], base64.b64decode(sys.argv[3]))',
  ].join('\n');
  for (const [command, args] of [
    ['py', ['-3']],
    ['python', []],
  ] as const) {
    const result = spawnSync(
      command,
      [...args, '-c', script, archive, entry, Buffer.from(content).toString('base64')],
      { shell: false },
    );
    if (result.status === 0) return;
  }
  throw new Error('Could not create the strict runtime candidate archive.');
}

interface CombinedCandidateFixture {
  readonly root: string;
  readonly manifestPath: string;
  readonly artifactPath: string;
  readonly artifactCount: number;
  readonly input: {
    readonly candidate: string;
    readonly candidateId: string;
    readonly candidateManifestSha256: string;
    readonly sourceCommit: string;
    readonly releaseVersion: string;
    readonly releaseMode: 'core-only' | 'model-enabled';
    readonly packageCandidateId: string;
    readonly runtimeCandidateId: string;
    readonly contractSetSha256: string;
  };
}

async function createCombinedCandidateFixture(): Promise<CombinedCandidateFixture> {
  const root = await mkdtemp(
    join(process.env.TEMP ?? process.env.TMP ?? '.', 'cert-combined-candidate-'),
  );
  for (const directory of [
    'runtime',
    'package',
    'python',
    'crate',
    'desktop',
    'checksums',
    'contracts',
  ]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  const schemaBytes = await readFile(
    join(
      import.meta.dirname,
      '..',
      'apps/cert-prep-desktop/test-fixtures',
      CAPTURE_DOCUMENT_SCHEMA_FILE,
    ),
  );
  const contractBytes = Buffer.from(
    JSON.stringify({
      contractSetVersion: '2',
      schemas: [{ name: 'CaptureOcrProjectionV3', schema: {} }],
    }),
  );
  const contractSetSha256 = sha256(contractBytes);
  const sourceCommit = 'd'.repeat(40);
  const releaseVersion = '0.4.4';
  const packageCandidateId = 'e'.repeat(64);
  const runtimeCandidateId = 'f'.repeat(64);
  const artifactContents: Array<[string, Buffer]> = [
    ['runtime/capture-document-v2.schema.json', schemaBytes],
    [
      'runtime/capture-runtime-manifest.json',
      Buffer.from(
        JSON.stringify({
          runtimeVersion: releaseVersion,
          schemaFileName: CAPTURE_DOCUMENT_SCHEMA_FILE,
          schemaSha256: sha256(schemaBytes),
        }),
      ),
    ],
    ['package/gx-capture-capture-runtime-client-0.4.4.tgz', Buffer.from('runtime client archive')],
    ['package/gx-capture-capture-workbench-ui-0.4.4.tgz', Buffer.from('workbench archive')],
    ['python/capture_runtime_client-0.4.4-py3-none-any.whl', Buffer.from('python wheel')],
    ['python/capture_runtime_client-0.4.4.tar.gz', Buffer.from('python source')],
    ['crate/capture-sidecar-launcher-0.4.4.crate', Buffer.from('launcher crate')],
    ['desktop/Capture.Workbench_0.4.4_x64-setup.exe', Buffer.from('desktop installer')],
    ['contracts/contract-set.json', contractBytes],
    ['contracts/contract-set.sha256', Buffer.from(contractSetSha256)],
    ['contracts/contract-snapshot.json', Buffer.from('{"schemaVersion":"1"}')],
  ];
  for (const [path, bytes] of artifactContents) {
    await writeFile(join(root, path), bytes);
  }
  const packageEntries = artifactContents.filter(([path]) => path.startsWith('package/'));
  const pythonEntries = artifactContents.filter(([path]) => path.startsWith('python/'));
  const crateEntries = artifactContents.filter(([path]) => path.startsWith('crate/'));
  const checksumEntries = [...packageEntries, ...pythonEntries, ...crateEntries].map(
    ([path, bytes]) => {
      const name = basename(path);
      return [
        `checksums/${name}.sha256`,
        Buffer.from(`${sha256(bytes)}  ${name}\n`),
      ] as [string, Buffer];
    },
  );
  for (const [path, bytes] of checksumEntries) {
    await writeFile(join(root, path), bytes);
  }
  const allArtifactContents = [...artifactContents, ...checksumEntries];
  const artifacts = allArtifactContents
    .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const baseManifest = {
    schemaVersion: '1',
    sourceCommit,
    releaseVersion,
    releaseMode: 'model-enabled',
    runtimeApiVersion: '2.0',
    documentSchemaVersion: '2',
    contractSetSha256,
    artifacts,
    toolchains: { node: '24.0.0' },
    contractImpact: null,
    packageCandidateId,
    runtimeCandidateId,
  };
  const candidateId = sha256(Buffer.from(JSON.stringify(baseManifest)));
  const manifestPath = join(root, 'candidate-manifest.json');
  const manifestBytes = Buffer.from(
    JSON.stringify({ ...baseManifest, candidateId }),
  );
  await writeFile(manifestPath, manifestBytes);
  const candidateManifestSha256 = sha256(manifestBytes);
  await writeFile(
    join(root, 'candidate-manifest.json.sha256'),
    `${candidateManifestSha256}  candidate-manifest.json\n`,
  );
  const ledger = {
    candidateId,
    sourceCommit,
    releaseMode: 'model-enabled',
    candidateManifestSha256,
    version: releaseVersion,
    schemaSha256: sha256(schemaBytes),
    artifacts: [
      ...packageEntries.map(([path, bytes]) => ({
        registry: 'npm',
        name: basename(path),
        sha256: sha256(bytes),
      })),
      ...pythonEntries.map(([path, bytes]) => ({
        registry: 'pypi',
        name: basename(path),
        sha256: sha256(bytes),
      })),
      ...crateEntries.map(([path, bytes]) => ({
        registry: 'crates.io',
        name: basename(path),
        sha256: sha256(bytes),
      })),
    ],
    status: 'candidate-verified',
  };
  await writeFile(
    join(root, 'release-ledger.json'),
    JSON.stringify(ledger),
  );
  return {
    root,
    manifestPath,
    artifactPath: join(root, packageEntries[0][0]),
    artifactCount: artifacts.length,
    input: {
      candidate: root,
      candidateId,
      candidateManifestSha256,
      sourceCommit,
      releaseVersion,
      releaseMode: 'model-enabled',
      packageCandidateId,
      runtimeCandidateId,
      contractSetSha256,
    },
  };
}

async function refreshCombinedCandidateManifest(
  fixture: CombinedCandidateFixture,
  mutate: (manifest: Record<string, unknown>) => void,
  reuseCandidateId = false,
): Promise<CombinedCandidateFixture['input']> {
  const manifest = JSON.parse(
    await readFile(fixture.manifestPath, 'utf8'),
  ) as Record<string, unknown>;
  const originalCandidateId = manifest.candidateId;
  mutate(manifest);
  const { candidateId: _candidateId, ...baseManifest } = manifest;
  manifest.candidateId = reuseCandidateId
    ? originalCandidateId
    : sha256(Buffer.from(JSON.stringify(baseManifest)));
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(fixture.manifestPath, manifestBytes);
  const candidateManifestSha256 = sha256(manifestBytes);
  await writeFile(
    join(fixture.root, 'candidate-manifest.json.sha256'),
    `${candidateManifestSha256}  candidate-manifest.json\n`,
  );
  const ledgerPath = join(fixture.root, 'release-ledger.json');
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as Record<
    string,
    unknown
  >;
  ledger.candidateId = manifest.candidateId;
  ledger.candidateManifestSha256 = candidateManifestSha256;
  ledger.sourceCommit = manifest.sourceCommit;
  ledger.releaseMode = manifest.releaseMode;
  ledger.version = manifest.releaseVersion;
  await writeFile(ledgerPath, JSON.stringify(ledger));
  return {
    ...fixture.input,
    candidateId: String(manifest.candidateId),
    candidateManifestSha256,
    sourceCommit: String(manifest.sourceCommit),
    releaseVersion: String(manifest.releaseVersion),
    releaseMode: manifest.releaseMode as 'core-only' | 'model-enabled',
    packageCandidateId: String(manifest.packageCandidateId),
    runtimeCandidateId: String(manifest.runtimeCandidateId),
    contractSetSha256: String(manifest.contractSetSha256),
  };
}
