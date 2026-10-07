import { CAPTURE_RUNTIME_VERSION } from './capture-runtime-version.mts';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, basename } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAPTURE_CANDIDATE_INSTALL_RELEASE_VERSION,
  executeCandidateInstallBinding,
  prepareCandidateInstallBinding,
  resolveTrustedGitIdentity,
  type CandidateInstallGitResolver,
} from './capture-candidate-install-binding.mts';
import {
  CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS,
  type CaptureRuntimeConsumerSource,
} from './capture-runtime-consumer-source.mts';
import type { CandidateArtifactReceiptInput } from './capture-candidate-gate.mts';

const workspaceRoot = join(import.meta.dirname, '..');

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function richContract(version: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      contractSetVersion: '2',
      schemas: [
        {
          name: 'CaptureOcrProjectionV3',
          schema: {
            properties: {
              apiVersion: { const: '2.0' },
              runtimeVersion: { const: version },
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
              runtimeVersion: { const: version },
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
              runtimeVersion: { const: version },
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
}

async function createGitFixture(): Promise<{
  readonly root: string;
  readonly head: string;
}> {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'cert-binding-git-'));
  await writeFile(join(root, 'README.md'), 'candidate binding fixture\n');
  const run = (args: readonly string[]): void => {
    const result = spawnSync('git', [...args], {
      cwd: root,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed`);
  };
  run(['init', '--quiet']);
  run(['config', 'user.email', 'binding@example.test']);
  run(['config', 'user.name', 'Candidate Binding']);
  run(['add', 'README.md']);
  run(['commit', '--quiet', '-m', 'fixture']);
  const result = spawnSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(result.status, 0);
  const head = result.stdout.trim();
  assert.match(head, /^[0-9a-f]{40}$/u);
  return { root, head };
}

async function createCandidateFixture(sourceCommit = 'a'.repeat(40)): Promise<{
  readonly root: string;
  readonly contractPath: string;
  readonly input: CandidateArtifactReceiptInput;
}> {
  const root = await mkdtemp(
    join(process.env.TEMP ?? process.env.TMP ?? '.', 'cert-binding-candidate-'),
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
      workspaceRoot,
      'apps/cert-prep-desktop/test-fixtures/capture-document-v2.schema.json',
    ),
  );
  const contractBytes = richContract(CAPTURE_CANDIDATE_INSTALL_RELEASE_VERSION);
  const contractSetSha256 = sha256(contractBytes);
  const artifactContents: Array<[string, Buffer]> = [
    ['runtime/capture-document-v2.schema.json', schemaBytes],
    [
      'runtime/capture-runtime-manifest.json',
      Buffer.from(
        JSON.stringify({
          runtimeVersion: CAPTURE_CANDIDATE_INSTALL_RELEASE_VERSION,
          schemaFileName: 'capture-document-v2.schema.json',
          schemaSha256: sha256(schemaBytes),
        }),
      ),
    ],
    [`package/gx-capture-capture-runtime-client-${CAPTURE_RUNTIME_VERSION}.tgz`, Buffer.from('runtime client archive')],
    [`package/gx-capture-capture-workbench-ui-${CAPTURE_RUNTIME_VERSION}.tgz`, Buffer.from('workbench archive')],
    [`python/capture_runtime_client-${CAPTURE_RUNTIME_VERSION}-py3-none-any.whl`, Buffer.from('python wheel')],
    [`python/capture_runtime_client-${CAPTURE_RUNTIME_VERSION}.tar.gz`, Buffer.from('python source')],
    [`crate/capture-sidecar-launcher-${CAPTURE_RUNTIME_VERSION}.crate`, Buffer.from('launcher crate')],
    [`desktop/Capture.Workbench_${CAPTURE_RUNTIME_VERSION}_x64-setup.exe`, Buffer.from('desktop installer')],
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
    ([path, bytes]) => [
      `checksums/${basename(path)}.sha256`,
      Buffer.from(`${sha256(bytes)}  ${basename(path)}\n`),
    ] as [string, Buffer],
  );
  for (const [path, bytes] of checksumEntries) {
    await writeFile(join(root, path), bytes);
  }
  const allArtifactContents = [...artifactContents, ...checksumEntries];
  const artifacts = allArtifactContents
    .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const packageCandidateId = 'e'.repeat(64);
  const runtimeCandidateId = 'f'.repeat(64);
  const baseManifest = {
    schemaVersion: '1',
    sourceCommit,
    releaseVersion: CAPTURE_CANDIDATE_INSTALL_RELEASE_VERSION,
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
  const manifestBytes = Buffer.from(JSON.stringify({ ...baseManifest, candidateId }));
  await writeFile(join(root, 'candidate-manifest.json'), manifestBytes);
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
    version: CAPTURE_CANDIDATE_INSTALL_RELEASE_VERSION,
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
  await writeFile(join(root, 'release-ledger.json'), JSON.stringify(ledger));
  return {
    root,
    contractPath: join(root, 'contracts/contract-set.json'),
    input: {
      candidate: root,
      candidateId,
      candidateManifestSha256,
      sourceCommit,
      releaseVersion: CAPTURE_CANDIDATE_INSTALL_RELEASE_VERSION,
      releaseMode: 'model-enabled',
      packageCandidateId,
      runtimeCandidateId,
      contractSetSha256,
    },
  };
}

async function createConsistentSource(): Promise<{
  readonly source: CaptureRuntimeConsumerSource;
  readonly files: Map<string, Uint8Array>;
}> {
  const files = new Map<string, Uint8Array>();
  for (const path of CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS) {
    const bytes = await readFile(join(workspaceRoot, path));
    files.set(path, Uint8Array.from(Buffer.from(bytes.toString('utf8').replaceAll('0.4.1', CAPTURE_RUNTIME_VERSION))));
  }
  return {
    files,
    source: {
      readFile(path) {
        const bytes = files.get(path);
        return bytes === undefined
          ? { kind: 'missing' }
          : { kind: 'file', bytes: Uint8Array.from(bytes) };
      },
    },
  };
}

function mutableHeadResolver(root: string, head: string): {
  readonly resolver: CandidateInstallGitResolver;
  setHead(value: string): void;
} {
  let currentHead = head;
  return {
    resolver: {
      resolveTopLevel: () => root,
      resolveHead: () => currentHead,
    },
    setHead(value) {
      currentHead = value;
    },
  };
}

test('default Git resolver binds the temp fixture root and verified source HEAD', async () => {
  const fixture = await createGitFixture();
  try {
    assert.deepEqual(resolveTrustedGitIdentity(fixture.root), {
      workspaceRoot: fixture.root,
      sourceHead: fixture.head,
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('wrong Git root and malformed HEAD fail closed before preparation can write', async () => {
  const git = await createGitFixture();
  const candidate = await createCandidateFixture();
  const consistent = await createConsistentSource();
  const wrongRoot = join(git.root, 'wrong-root');
  await mkdir(wrongRoot);
  let writes = 0;
  try {
    await assert.rejects(
      prepareCandidateInstallBinding(
        {
          workspaceRoot: git.root,
          expectedReleaseVersion: CAPTURE_CANDIDATE_INSTALL_RELEASE_VERSION,
          expectedReleaseMode: 'model-enabled',
          candidate: candidate.input,
        },
        {
          source: consistent.source,
          git: {
            resolveTopLevel: () => wrongRoot,
            resolveHead: () => git.head,
          },
        },
      ),
      /workspace root/u,
    );
    await assert.rejects(
      prepareCandidateInstallBinding(
        {
          workspaceRoot: git.root,
          expectedReleaseVersion: CAPTURE_CANDIDATE_INSTALL_RELEASE_VERSION,
          expectedReleaseMode: 'model-enabled',
          candidate: candidate.input,
        },
        {
          source: consistent.source,
          git: {
            resolveTopLevel: () => git.root,
            resolveHead: () => 'malformed-head',
          },
        },
      ),
      /lowercase 40-character/u,
    );
    assert.equal(writes, 0);
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
    await rm(git.root, { recursive: true, force: true });
  }
});

test('consistent synthetic receipt prepares and writes exactly once', async () => {
  const git = await createGitFixture();
  const candidate = await createCandidateFixture();
  const consistent = await createConsistentSource();
  let writes = 0;
  try {
    assert.notEqual(candidate.input.sourceCommit, git.head);
    const preparation = await prepareCandidateInstallBinding(
      {
        workspaceRoot: git.root,
        expectedReleaseVersion: CAPTURE_CANDIDATE_INSTALL_RELEASE_VERSION,
        expectedReleaseMode: 'model-enabled',
        candidate: candidate.input,
      },
      { source: consistent.source },
    );
    assert.equal(preparation.inventory.status, 'ready');
    await assert.rejects(
      executeCandidateInstallBinding(
        { ...preparation },
        () => {
          writes += 1;
        },
        { source: consistent.source },
      ),
      /forged, consumed, or already used/u,
    );
    const executions = await Promise.allSettled([
      executeCandidateInstallBinding(
        preparation,
        async () => {
          await Promise.resolve();
          writes += 1;
        },
        { source: consistent.source },
      ),
      executeCandidateInstallBinding(
        preparation,
        () => {
          writes += 1;
        },
        { source: consistent.source },
      ),
    ]);
    assert.equal(executions.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(executions.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(writes, 1);
    await assert.rejects(
      executeCandidateInstallBinding(preparation, () => { writes += 1; }, {
        source: consistent.source,
      }),
      /forged, consumed, or already used/u,
    );
    assert.equal(writes, 1);
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
    await rm(git.root, { recursive: true, force: true });
  }
});

test('0.4.1 consumer bytes cannot prepare a candidate of the pinned release and do not write', async () => {
  const git = await createGitFixture();
  const candidate = await createCandidateFixture();
  const current = await createConsistentSource();
  // Simulate the previous published consumer pins against this candidate.
  for (const path of CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS) {
    const bytes = await readFile(join(workspaceRoot, path));
    current.files.set(
      path,
      Uint8Array.from(
        Buffer.from(bytes.toString('utf8').replaceAll(CAPTURE_RUNTIME_VERSION, '0.4.1')),
      ),
    );
  }
  let writes = 0;
  try {
    await assert.rejects(
      prepareCandidateInstallBinding(
        {
          workspaceRoot: git.root,
          expectedReleaseVersion: CAPTURE_CANDIDATE_INSTALL_RELEASE_VERSION,
          expectedReleaseMode: 'model-enabled',
          candidate: candidate.input,
        },
        { source: current.source },
      ),
      /consumer inventory blocked/u,
    );
    assert.equal(writes, 0);
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
    await rm(git.root, { recursive: true, force: true });
  }
});

test('HEAD, source-byte, candidate-byte, revalidation, and contract drift fail before the writer', async () => {
  const git = await createGitFixture();
  const candidate = await createCandidateFixture();
  const mutableGit = mutableHeadResolver(git.root, git.head);
  let writes = 0;
  try {
    const prepare = (source: CaptureRuntimeConsumerSource) =>
      prepareCandidateInstallBinding(
        {
          workspaceRoot: git.root,
          expectedReleaseVersion: CAPTURE_CANDIDATE_INSTALL_RELEASE_VERSION,
          expectedReleaseMode: 'model-enabled',
          candidate: candidate.input,
        },
        { source, git: mutableGit.resolver },
      );
    const headSource = await createConsistentSource();
    const headPreparation = await prepare(headSource.source);
    mutableGit.setHead('b'.repeat(40));
    await assert.rejects(
      executeCandidateInstallBinding(headPreparation, () => { writes += 1; }, {
        source: headSource.source,
        git: mutableGit.resolver,
      }),
      /HEAD changed/u,
    );
    assert.equal(writes, 0);

    mutableGit.setHead(git.head);
    const sourceDrift = await createConsistentSource();
    const sourcePreparation = await prepare(sourceDrift.source);
    sourceDrift.files.set('package.json', Uint8Array.from([...sourceDrift.files.get('package.json')!, 0x0a]));
    await assert.rejects(
      executeCandidateInstallBinding(sourcePreparation, () => { writes += 1; }, {
        source: sourceDrift.source,
        git: mutableGit.resolver,
      }),
      /source drifted/u,
    );
    assert.equal(writes, 0);

    const lockDrift = await createConsistentSource();
    const lockPreparation = await prepare(lockDrift.source);
    lockDrift.files.set('pnpm-lock.yaml', Uint8Array.from([...lockDrift.files.get('pnpm-lock.yaml')!, 0x0a]));
    await assert.rejects(
      executeCandidateInstallBinding(lockPreparation, () => { writes += 1; }, {
        source: lockDrift.source,
        git: mutableGit.resolver,
      }),
      /source drifted/u,
    );
    assert.equal(writes, 0);

    const candidateSource = await createConsistentSource();
    const candidatePreparation = await prepare(candidateSource.source);
    const artifact = candidatePreparation.candidate.artifacts.find((entry) => entry.path.startsWith('package/'));
    assert.ok(artifact);
    const originalArtifactBytes = await readFile(join(candidate.root, artifact.path));
    await writeFile(join(candidate.root, artifact.path), 'mutated candidate bytes');
    await assert.rejects(
      executeCandidateInstallBinding(candidatePreparation, () => { writes += 1; }, {
        source: candidateSource.source,
        git: mutableGit.resolver,
      }),
      /changed or mismatched|no longer matches/u,
    );
    assert.equal(writes, 0);

    await writeFile(join(candidate.root, artifact.path), originalArtifactBytes);
    const revalidationSource = await createConsistentSource();
    const revalidationPreparation = await prepare(revalidationSource.source);
    await assert.rejects(
      executeCandidateInstallBinding(revalidationPreparation, () => { writes += 1; }, {
        source: revalidationSource.source,
        git: mutableGit.resolver,
        reverifyReceipt: async () => {
          throw new Error('receipt revalidation failed');
        },
      }),
      /receipt revalidation failed/u,
    );
    assert.equal(writes, 0);

    const contractSource = await createConsistentSource();
    const contractPreparation = await prepare(contractSource.source);
    await assert.rejects(
      executeCandidateInstallBinding(contractPreparation, () => { writes += 1; }, {
        source: contractSource.source,
        git: mutableGit.resolver,
        readFile: async () => Uint8Array.from(Buffer.from('independently valid but different contract source')),
      }),
      /contract-set SHA-256/u,
    );
    assert.equal(writes, 0);
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
    await rm(git.root, { recursive: true, force: true });
  }
});

test('async receipt and contract reads cannot bypass the final consumer snapshot boundary', async () => {
  const git = await createGitFixture();
  const candidate = await createCandidateFixture();
  const firstSource = await createConsistentSource();
  const mutableGit = mutableHeadResolver(git.root, git.head);
  let writes = 0;
  try {
    const firstPreparation = await prepareCandidateInstallBinding(
      {
        workspaceRoot: git.root,
        expectedReleaseVersion: CAPTURE_CANDIDATE_INSTALL_RELEASE_VERSION,
        expectedReleaseMode: 'model-enabled',
        candidate: candidate.input,
      },
      { source: firstSource.source, git: mutableGit.resolver },
    );
    await assert.rejects(
      executeCandidateInstallBinding(firstPreparation, () => { writes += 1; }, {
        source: firstSource.source,
        git: mutableGit.resolver,
        reverifyReceipt: async () => {
          firstSource.files.set(
            'pnpm-lock.yaml',
            Uint8Array.from([...firstSource.files.get('pnpm-lock.yaml')!, 0x0a]),
          );
          mutableGit.setHead('c'.repeat(40));
          await Promise.resolve();
        },
      }),
      /consumer identity changed|HEAD changed|source drifted/u,
    );
    assert.equal(writes, 0);

    mutableGit.setHead(git.head);
    const secondSource = await createConsistentSource();
    const secondPreparation = await prepareCandidateInstallBinding(
      {
        workspaceRoot: git.root,
        expectedReleaseVersion: CAPTURE_CANDIDATE_INSTALL_RELEASE_VERSION,
        expectedReleaseMode: 'model-enabled',
        candidate: candidate.input,
      },
      { source: secondSource.source, git: mutableGit.resolver },
    );
    await assert.rejects(
      executeCandidateInstallBinding(secondPreparation, () => { writes += 1; }, {
        source: secondSource.source,
        git: mutableGit.resolver,
        readFile: async (path) => {
          secondSource.files.set(
            'pnpm-lock.yaml',
            Uint8Array.from([...secondSource.files.get('pnpm-lock.yaml')!, 0x0a]),
          );
          return Uint8Array.from(await readFile(path));
        },
      }),
      /source drifted/u,
    );
    assert.equal(writes, 0);
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
    await rm(git.root, { recursive: true, force: true });
  }
});

test('mutable snapshot, contract, and inventory views are rejected at the final boundary', async () => {
  const git = await createGitFixture();
  const candidate = await createCandidateFixture();
  let writes = 0;
  try {
    const snapshotSource = await createConsistentSource();
    const snapshotPreparation = await prepareCandidateInstallBinding(
      {
        workspaceRoot: git.root,
        expectedReleaseVersion: CAPTURE_CANDIDATE_INSTALL_RELEASE_VERSION,
        expectedReleaseMode: 'model-enabled',
        candidate: candidate.input,
      },
      { source: snapshotSource.source },
    );
    snapshotPreparation.sourceSnapshot.files[0].bytes[0] ^= 1;
    await assert.rejects(
      executeCandidateInstallBinding(snapshotPreparation, () => { writes += 1; }, {
        source: snapshotSource.source,
      }),
      /snapshot|SHA-256/u,
    );
    assert.equal(writes, 0);

    const contractSource = await createConsistentSource();
    const contractPreparation = await prepareCandidateInstallBinding(
      {
        workspaceRoot: git.root,
        expectedReleaseVersion: CAPTURE_CANDIDATE_INSTALL_RELEASE_VERSION,
        expectedReleaseMode: 'model-enabled',
        candidate: candidate.input,
      },
      { source: contractSource.source },
    );
    contractPreparation.contractSource.bytes[0] ^= 1;
    await assert.rejects(
      executeCandidateInstallBinding(contractPreparation, () => { writes += 1; }, {
        source: contractSource.source,
      }),
      /contract source bytes were mutated/u,
    );
    assert.equal(writes, 0);

    const inventorySource = await createConsistentSource();
    const inventoryPreparation = await prepareCandidateInstallBinding(
      {
        workspaceRoot: git.root,
        expectedReleaseVersion: CAPTURE_CANDIDATE_INSTALL_RELEASE_VERSION,
        expectedReleaseMode: 'model-enabled',
        candidate: candidate.input,
      },
      { source: inventorySource.source },
    );
    (inventoryPreparation.inventory as { status: 'ready' | 'blocked' }).status = 'blocked';
    await assert.rejects(
      executeCandidateInstallBinding(inventoryPreparation, () => { writes += 1; }, {
        source: inventorySource.source,
      }),
      /inventory was mutated/u,
    );
    assert.equal(writes, 0);
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
    await rm(git.root, { recursive: true, force: true });
  }
});

test('writer failure propagates once without retry or rollback claim', async () => {
  const git = await createGitFixture();
  const candidate = await createCandidateFixture();
  const consistent = await createConsistentSource();
  let writes = 0;
  try {
    const preparation = await prepareCandidateInstallBinding(
      {
        workspaceRoot: git.root,
        expectedReleaseVersion: CAPTURE_CANDIDATE_INSTALL_RELEASE_VERSION,
        expectedReleaseMode: 'model-enabled',
        candidate: candidate.input,
      },
      { source: consistent.source },
    );
    await assert.rejects(
      executeCandidateInstallBinding(
        preparation,
        () => {
          writes += 1;
          throw new Error('writer failed');
        },
        { source: consistent.source },
      ),
      /writer failed/u,
    );
    assert.equal(writes, 1);
    await assert.rejects(
      executeCandidateInstallBinding(preparation, () => { writes += 1; }, {
        source: consistent.source,
      }),
      /forged, consumed, or already used/u,
    );
    assert.equal(writes, 1);
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
    await rm(git.root, { recursive: true, force: true });
  }
});
