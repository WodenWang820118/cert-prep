import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { basename, join } from 'node:path';

import {
  CAPTURE_DOCUMENT_SCHEMA_FILE,
  CAPTURE_DOCUMENT_SCHEMA_SHA256,
  CAPTURE_RUNTIME_FILE,
} from '../apps/cert-prep-desktop/scripts/package-qa/constants.mts';
import { CAPTURE_RUNTIME_VERSION } from './capture-runtime-version.mts';
import {
  createResult,
  parseArguments,
  validateRuntimeCandidateContent,
  validateRuntimeCandidateManifest,
  verifyCandidate,
} from './capture-candidate-gate.mts';

const candidateId = 'a'.repeat(64);
const manifestSha256 = 'b'.repeat(64);
const commit = 'c'.repeat(40);
const LOCAL_PROBE_VERSION = '0.4.2';

test('strict local runtime observation rejects an unsealed inventory', async () => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'cert-runtime-candidate-'));
  try {
    const manifest = { schemaVersion: '1', candidateKind: 'runtime', sourceCommit: commit, releaseVersion: '0.4.2', releaseMode: 'model-enabled', artifacts: [] };
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
        const changedContract = JSON.stringify({
          contractSetVersion: '2',
          operations: [
            {
              method: 'GET',
              path: '/v2/captures/{capture_id}/ocr',
              responseSchema: 'CaptureOcrProjectionV3',
            },
            {
              method: 'GET',
              path: '/v2/captures/{capture_id}/result',
              responseSchema: 'CaptureDocument',
            },
          ],
        });
        const contractBytes = Buffer.from(changedContract);
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
