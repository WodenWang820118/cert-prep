import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { runCaptureFreshProjection } from './capture-fresh-projection.mts';

const execFileAsync = promisify(execFile);

const SHA = {
  runtimeCandidate:
    '21430d577fc765be01036b27999b224544d1065b703e514d05ddfc1f40a69447',
  runtimeManifest:
    '9ae8c68cbd02d529367d320a98611b8291fcc6d19e74019b75ab0a46cbd6cbae',
  packageCandidate:
    'eefe5627e68b8b0342d5a44c3dbbc249f0a85ad1da5b07d67cb8bb938817ef78',
  packageCandidateManifest:
    '7b67cc4ff22b6c3f32a1a6c157f0d3657df03e397da08b3bc39baa9d90338197',
  packageManifest:
    'f8df0ef98e8489bbc7c2658f00c5b3a702095d1642fabc8468a9333706e1b96f',
  contract:
    'd293a3de26114f1b4fd65ea6d6d3f157fa2f93109b31e1e30d5d15ef0dfdeb40',
  wheel:
    '147120b12185e1d69200e168552d0bf70706f3bf7ea09fefe07d56053e85bae3',
  sdist:
    '7c1d1c84a4f7a039c32ed2238dd22f0a595b316d4609e2f6341678376a639954',
  crate:
    '9e6543b243c24f5c6cf6e1af2b6862ac4e5c6d80fafb2d269530e0e205625104',
  npmClient:
    'f5e315eca861dc1123660de841769341f91fc8bfd644a25096fa355f1370bc05',
  npmUi:
    '4b0f4ffa0a098a8326ee57c25ee29bfc3bc991a55c5edec7c0e9902074adfaf5',
  tree: '1'.repeat(64),
  status: '2'.repeat(64),
  audit: '3'.repeat(64),
  lockA: '4'.repeat(64),
  lockB: '5'.repeat(64),
  lockC: '6'.repeat(64),
} as const;

function canonicalRuntimeContent() {
  return {
    candidateKind: 'runtime' as const,
    candidateId: SHA.runtimeCandidate,
    candidateManifestSha256: SHA.runtimeManifest,
    manifestSha256: SHA.runtimeManifest,
    sourceCommit: '66ae26fe45e8903df6f86fac33d1f59b73e2cdaa',
    runtimeVersion: '0.4.2' as const,
    contractSetSha256: SHA.contract,
    modelEntryCount: 10,
    profilePath:
      '_internal/capture_runtime/assets/ocr-profile.json' as const,
    workerEntryPoint: 'capture-engine-ocr.exe' as const,
    inventory: [],
    runtime: { path: 'runtime/capture-runtime.exe', bytes: 10, sha256: '7'.repeat(64) },
    ocrArchive: { path: 'runtime/capture-engine-ocr.zip', bytes: 11, sha256: '8'.repeat(64) },
    ocrExecutable: { path: 'capture-engine-ocr.exe', bytes: 12, sha256: '9'.repeat(64) },
    catalog: { path: 'runtime/capture-engine-catalog.json', bytes: 13, sha256: 'a'.repeat(64) },
    profile: {
      path: '_internal/capture_runtime/assets/ocr-profile.json',
      bytes: 14,
      sha256: 'b'.repeat(64),
      id: 'capture-workbench-ocr-729f2dc6dada6516',
      device: 'windowsml-dml' as const,
      model: 'pp-ocrv6-medium-windowsml' as const,
    },
  };
}

function canonicalAuthorities() {
  return {
    runtime: {
      schemaVersion: '1' as const,
      candidateKind: 'runtime' as const,
      candidateId: SHA.runtimeCandidate,
      manifestSha256: SHA.runtimeManifest,
      sourceCommit: '66ae26fe45e8903df6f86fac33d1f59b73e2cdaa',
      runtimeVersion: '0.4.2' as const,
      packageCandidateId: SHA.packageCandidate,
      contractSetSha256: SHA.contract,
      wheel: {
        fileName: 'capture_runtime_client-0.4.2-py3-none-any.whl',
        bytes: 85_227,
        sha256: SHA.wheel,
      },
      sdist: {
        fileName: 'capture_runtime_client-0.4.2.tar.gz',
        bytes: 83_353,
        sha256: SHA.sdist,
      },
      crate: {
        fileName: 'capture-sidecar-launcher-0.4.2.crate',
        bytes: 22_008,
        sha256: SHA.crate,
      },
    },
    packages: {
      schemaVersion: '1' as const,
      candidateKind: 'npm-package-set' as const,
      candidateId: SHA.packageCandidate,
      manifestSha256: SHA.packageCandidateManifest,
      packageManifestSha256: SHA.packageManifest,
      sourceCommit: 'b7c0e9776b3845f132d2f6eb9c4476041ae13099',
      runtimeVersion: '0.4.2' as const,
      contractSetSha256: SHA.contract,
      npmPackages: [
        {
          name: '@gx-capture/capture-runtime-client' as const,
          version: '0.4.2' as const,
          archive: 'package/gx-capture-capture-runtime-client-0.4.2.tgz',
          fileName: 'gx-capture-capture-runtime-client-0.4.2.tgz',
          bytes: 63_541,
          sha256: SHA.npmClient,
          integrity:
            'sha512-JvNbGqEZIiZ0Fe+cqJmJQQIIeZbTNrlncOqcYBFNK+ZZWgrwgYe/Zru5WlUEKUybANbX7VnjvhPmUj/Mq12Imw==',
          packageManifest: {
            name: '@gx-capture/capture-runtime-client',
            version: '0.4.2',
            contractSetSha256: SHA.contract,
          },
        },
        {
          name: '@gx-capture/capture-workbench-ui' as const,
          version: '0.4.2' as const,
          archive: 'package/gx-capture-capture-workbench-ui-0.4.2.tgz',
          fileName: 'gx-capture-capture-workbench-ui-0.4.2.tgz',
          bytes: 86_893,
          sha256: SHA.npmUi,
          integrity:
            'sha512-P4hM4Y59te8HN2p0XTcowYWkSSsYhX9hlvtM1sKr/TqHcvwoL4xzL8IVS+HrydlwI6fdzANa1ihFFOSFoO0XBA==',
          packageManifest: {
            name: '@gx-capture/capture-workbench-ui',
            version: '0.4.2',
            dependencies: {
              '@gx-capture/capture-runtime-client': '0.4.2',
            },
          },
        },
      ],
    },
  };
}

async function syntheticEdgeDependencies(tempRoot: string) {
  const snapshot = {
    trackedTreeSha256: SHA.tree,
    trackedFileCount: 42,
    head: 'd'.repeat(40),
    dirty: false,
    statusSha256: SHA.status,
  };
  return {
    createTempRoot: async () => tempRoot,
    snapshotSource: async () => snapshot,
    snapshotCandidate: async () => ({ treeSha256: SHA.tree, fileCount: 20 }),
    copyTrackedSource: async (_sourceRoot: string, destination: string) => {
      await mkdir(join(destination, 'apps/cert-prep-backend'), { recursive: true });
      await mkdir(join(destination, 'apps/cert-prep-desktop/src-tauri'), { recursive: true });
      return 42;
    },
    applyOverlays: async () => undefined,
    startRegistries: async () => ({
      endpoints: {
        npm: 'http://127.0.0.1:42001',
        python: 'http://127.0.0.1:42002',
        cargo: 'sparse+http://127.0.0.1:42003/index/',
      },
      ports: [42001, 42002, 42003],
      preflight: async () => undefined,
      audit: () => ({
        requestCount: 10,
        acceptedCount: 10,
        rejectedCount: 0,
        requiredRouteCount: 10,
        coveredRouteCount: 10,
        auditSha256: SHA.audit,
      }),
      close: async () => 3,
    }),
    runCommand: async (command: { phase: string; ecosystem: string }) => {
      if (command.phase === 'A' && command.ecosystem === 'cargo') {
        await writeFile(join(tempRoot, 'projection-a', 'pnpm-lock.yaml'), 'pnpm-lock\n');
        await writeFile(join(tempRoot, 'projection-a', 'apps/cert-prep-backend/uv.lock'), 'uv-lock\n');
        await writeFile(join(tempRoot, 'projection-a', 'apps/cert-prep-desktop/src-tauri/Cargo.lock'), 'cargo-lock\n');
      }
    },
    collectResolutions: async () => [
      {
        ecosystem: 'npm' as const,
        packageName: '@gx-capture/capture-runtime-client',
        version: '0.4.2',
        sourceKind: 'registry' as const,
        sha256: SHA.npmClient,
      },
      {
        ecosystem: 'npm' as const,
        packageName: '@gx-capture/capture-workbench-ui',
        version: '0.4.2',
        sourceKind: 'registry' as const,
        sha256: SHA.npmUi,
      },
      {
        ecosystem: 'python' as const,
        packageName: 'capture-runtime-client',
        version: '0.4.2',
        sourceKind: 'registry' as const,
        sha256: SHA.wheel,
      },
      {
        ecosystem: 'cargo' as const,
        packageName: 'capture-sidecar-launcher',
        version: '0.4.2',
        sourceKind: 'registry' as const,
        sha256: SHA.crate,
      },
    ],
    closeOwnedChildren: async () => 0,
    assertListenersClosed: async () => 0,
    removeTempRoot: async () => {
      await import('node:fs/promises').then(({ rm }) =>
        rm(tempRoot, { recursive: true, force: true }),
      );
    },
  };
}

test('fresh projection proves exact candidate identities and byte-equal frozen/offline replay', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'capture-fresh-test-'));
  const commands: Array<{ phase: string; ecosystem: string; args: readonly string[] }> = [];
  let sourceSnapshots = 0;
  let runtimeSnapshots = 0;
  let packageSnapshots = 0;
  let closedServers = 0;
  let removed = false;

  const manifest = await runCaptureFreshProjection(
    {
      sourceRoot: 'C:\\fixture\\cert-prep',
      runtimeCandidateRoot: 'C:\\fixture\\j30',
      packageCandidateRoot: 'C:\\fixture\\j16',
    },
    {
      validateRuntimeContent: async () => canonicalRuntimeContent(),
      loadAuthorities: async () => canonicalAuthorities(),
      createTempRoot: async () => tempRoot,
      snapshotSource: async () => {
        sourceSnapshots += 1;
        return {
          trackedTreeSha256: SHA.tree,
          trackedFileCount: 42,
          head: null,
          dirty: true,
          statusSha256: SHA.status,
        };
      },
      snapshotCandidate: async (root: string) => {
        if (root.endsWith('j30')) runtimeSnapshots += 1;
        else packageSnapshots += 1;
        return { treeSha256: SHA.tree, fileCount: 20 };
      },
      copyTrackedSource: async (_sourceRoot: string, destination: string) => {
        await mkdir(join(destination, 'apps/cert-prep-backend'), { recursive: true });
        await mkdir(join(destination, 'apps/cert-prep-desktop/src-tauri'), { recursive: true });
        return 42;
      },
      applyOverlays: async () => undefined,
      startRegistries: async () => ({
        endpoints: {
          npm: 'http://127.0.0.1:41001',
          python: 'http://127.0.0.1:41002',
          cargo: 'sparse+http://127.0.0.1:41003/index/',
        },
        ports: [41001, 41002, 41003],
        preflight: async () => undefined,
        audit: () => ({
          requestCount: 9,
          acceptedCount: 9,
          rejectedCount: 0,
          requiredRouteCount: 9,
          coveredRouteCount: 9,
          auditSha256: SHA.audit,
        }),
        close: async () => {
          closedServers += 3;
          return 3;
        },
      }),
      runCommand: async (command) => {
        commands.push(command);
        if (command.phase === 'A' && command.ecosystem === 'cargo') {
          await writeFile(join(tempRoot, 'projection-a', 'pnpm-lock.yaml'), 'pnpm-lock\n');
          await writeFile(join(tempRoot, 'projection-a', 'apps/cert-prep-backend/uv.lock'), 'uv-lock\n');
          await writeFile(join(tempRoot, 'projection-a', 'apps/cert-prep-desktop/src-tauri/Cargo.lock'), 'cargo-lock\n');
        }
      },
      collectResolutions: async () => [
        {
          ecosystem: 'npm' as const,
          packageName: '@gx-capture/capture-runtime-client',
          version: '0.4.2',
          sourceKind: 'registry' as const,
          sha256: SHA.npmClient,
        },
        {
          ecosystem: 'npm' as const,
          packageName: '@gx-capture/capture-workbench-ui',
          version: '0.4.2',
          sourceKind: 'registry' as const,
          sha256: SHA.npmUi,
        },
        {
          ecosystem: 'python' as const,
          packageName: 'capture-runtime-client',
          version: '0.4.2',
          sourceKind: 'registry' as const,
          sha256: SHA.wheel,
        },
        {
          ecosystem: 'cargo' as const,
          packageName: 'capture-sidecar-launcher',
          version: '0.4.2',
          sourceKind: 'registry' as const,
          sha256: SHA.crate,
        },
      ],
      closeOwnedChildren: async () => 0,
      assertListenersClosed: async () => 0,
      removeTempRoot: async () => {
        removed = true;
        await import('node:fs/promises').then(({ rm }) =>
          rm(tempRoot, { recursive: true, force: true }),
        );
      },
    },
  );

  assert.equal(manifest.schemaVersion, '1');
  assert.equal(manifest.scope, 'local-candidate-projection');
  assert.equal(manifest.runtime.candidateId, SHA.runtimeCandidate);
  assert.equal(manifest.runtime.packageCandidateId, SHA.packageCandidate);
  assert.equal(manifest.runtime.wheelSha256, SHA.wheel);
  assert.equal(manifest.runtime.crateSha256, SHA.crate);
  assert.equal(manifest.projections.locksByteEqual, true);
  assert.equal(manifest.projections.replayRegistryRequestCount, 0);
  assert.deepEqual(manifest.artifactExport, {
    freshArtifactExported: false,
    installedAcceptanceProven: false,
  });
  const serializedManifest = JSON.stringify(manifest);
  assert.doesNotMatch(serializedManifest, /C:\\\\fixture|capture-fresh-test-/iu);
  assert.doesNotMatch(serializedManifest, /bearer|authorization|token|raw[_-]?ocr|published/iu);
  const replayCommands = commands.filter(({ phase }) => phase === 'B');
  assert.deepEqual(
    replayCommands.map(({ ecosystem }) => ecosystem),
    ['pnpm', 'python', 'cargo'],
  );
  for (const [ecosystem, required] of [
    ['pnpm', ['install', '--frozen-lockfile', '--offline']],
    ['python', ['sync', '--frozen', '--offline']],
    ['cargo', ['check', '--locked', '--offline']],
  ] as const) {
    const command = replayCommands.find((candidate) => candidate.ecosystem === ecosystem);
    assert.ok(command);
    for (const argument of required) assert.ok(command.args.includes(argument));
  }
  assert.deepEqual(manifest.cleanup, {
    ownedServerCount: 3,
    ownedChildCount: 0,
    remainingListenerCount: 0,
    tempRemoved: true,
    sourceUnchanged: true,
    runtimeCandidateUnchanged: true,
    packageCandidateUnchanged: true,
  });
  assert.equal(sourceSnapshots, 2);
  assert.equal(runtimeSnapshots, 2);
  assert.equal(packageSnapshots, 2);
  assert.equal(closedServers, 3);
  assert.equal(removed, true);
});

test('fresh projection derives the linked J16 npm authority from immutable manifests and archives', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'capture-fresh-authority-'));
  const edges = await syntheticEdgeDependencies(tempRoot);
  const manifest = await runCaptureFreshProjection(
    {
      sourceRoot: 'C:\\fixture\\cert-prep',
      runtimeCandidateRoot:
        'C:\\software-dev\\capture-workbench-phase1-j30-runtime-candidate-0.4.2-luna-20260831-01',
      packageCandidateRoot:
        'C:\\software-dev\\capture-workbench-phase1-j16-package-candidate-b7c0e9',
    },
    {
      ...edges,
      validateRuntimeContent: async () => canonicalRuntimeContent(),
    },
  );

  assert.equal(manifest.runtime.packageManifestSha256, SHA.packageManifest);
  assert.equal(
    manifest.runtime.packageCandidateManifestSha256,
    SHA.packageCandidateManifest,
  );
  assert.deepEqual(manifest.runtime.npmPackageSha256, [SHA.npmClient, SHA.npmUi]);
  assert.equal(manifest.runtime.wheelSha256, SHA.wheel);
  assert.equal(manifest.runtime.crateSha256, SHA.crate);
});

test('fresh projection rejects J30 authority, J30/J16 linkage, and execution artifact drift', async (context) => {
  const cases = [
    {
      name: 'J30 manifest authority',
      mutate(authorities: ReturnType<typeof canonicalAuthorities>) {
        (authorities.runtime as { manifestSha256: string }).manifestSha256 = '0'.repeat(64);
      },
      error: /J30 runtime candidate authority drifted/u,
    },
    {
      name: 'J30 to J16 package linkage',
      mutate(authorities: ReturnType<typeof canonicalAuthorities>) {
        (authorities.packages as { candidateId: string }).candidateId = '0'.repeat(64);
      },
      error: /package candidate linkage drifted/u,
    },
    {
      name: 'hard-pinned execution wheel',
      mutate(authorities: ReturnType<typeof canonicalAuthorities>) {
        (authorities.runtime.wheel as { sha256: string }).sha256 = '0'.repeat(64);
      },
      error: /Python execution wheel drifted/u,
    },
  ];

  for (const testCase of cases) {
    await context.test(testCase.name, async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), 'capture-fresh-drift-'));
      const authorities = structuredClone(canonicalAuthorities());
      testCase.mutate(authorities);
      await assert.rejects(
        runCaptureFreshProjection(
          {
            sourceRoot: 'C:\\fixture\\cert-prep',
            runtimeCandidateRoot: 'C:\\fixture\\j30',
            packageCandidateRoot: 'C:\\fixture\\j16',
          },
          {
            ...(await syntheticEdgeDependencies(tempRoot)),
            validateRuntimeContent: async () => canonicalRuntimeContent(),
            loadAuthorities: async () => authorities,
          },
        ),
        testCase.error,
      );
    });
  }
});

test('owned loopback registries preflight every npm, PEP503, and Cargo route', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'capture-fresh-routes-'));
  const {
    startRegistries: _syntheticRegistry,
    applyOverlays: _syntheticOverlay,
    runCommand: _syntheticCommand,
    ...edges
  } = await syntheticEdgeDependencies(tempRoot);
  void _syntheticRegistry;
  void _syntheticOverlay;
  void _syntheticCommand;
  let endpoints:
    | { readonly npm: string; readonly python: string; readonly cargo: string }
    | undefined;

  const manifest = await runCaptureFreshProjection(
    {
      sourceRoot: 'C:\\fixture\\cert-prep',
      runtimeCandidateRoot:
        'C:\\software-dev\\capture-workbench-phase1-j30-runtime-candidate-0.4.2-luna-20260831-01',
      packageCandidateRoot:
        'C:\\software-dev\\capture-workbench-phase1-j16-package-candidate-b7c0e9',
    },
    {
      ...edges,
      validateRuntimeContent: async () => canonicalRuntimeContent(),
      applyOverlays: async (input) => {
        endpoints = input.endpoints;
      },
      runCommand: async (command) => {
        assert.ok(endpoints);
        if (command.phase === 'A' && command.ecosystem === 'cargo') {
          const cargoIndexResponse = await fetch(
            `${endpoints.cargo.replace(/^sparse\+/u, '')}ca/pt/capture-sidecar-launcher`,
          );
          const cargoIndex = JSON.parse(await cargoIndexResponse.text()) as {
            readonly deps: readonly { readonly name: string; readonly registry: string | null }[];
          };
          assert.equal(cargoIndexResponse.headers.get('content-type'), 'application/json');
          assert.equal(
            cargoIndex.deps.find(({ name }) => name === 'rand')?.registry,
            'https://github.com/rust-lang/crates.io-index',
          );
          const wheelResponse = await fetch(
            `${endpoints.python}/packages/capture_runtime_client-0.4.2-py3-none-any.whl`,
          );
          assert.equal(wheelResponse.headers.get('cache-control'), 'public, max-age=31536000, immutable');
          await writeFile(join(tempRoot, 'projection-a', 'pnpm-lock.yaml'), 'pnpm-lock\n');
          await writeFile(join(tempRoot, 'projection-a', 'apps/cert-prep-backend/uv.lock'), 'uv-lock\n');
          await writeFile(join(tempRoot, 'projection-a', 'apps/cert-prep-desktop/src-tauri/Cargo.lock'), 'cargo-lock\n');
        }
      },
    },
  );

  assert.equal(manifest.registries.ownedServerCount, 3);
  assert.equal(manifest.registries.requiredRouteCount, 10);
  assert.equal(manifest.registries.coveredRouteCount, 10);
  assert.equal(manifest.registries.rejectedRequestCount, 0);
});

test('owned registries reject unknown routes and detect any projection B request', async (context) => {
  for (const testCase of [
    {
      name: 'unknown route',
      expected: /unknown request/u,
      shouldRequest: (phase: string, ecosystem: string) => phase === 'A' && ecosystem === 'pnpm',
      path: '/not-a-registry-route',
      status: 404,
    },
    {
      name: 'projection B network request',
      expected: /registry request despite frozen offline replay/u,
      shouldRequest: (phase: string, ecosystem: string) => phase === 'B' && ecosystem === 'pnpm',
      path: `/@gx-capture%2Fcapture-runtime-client`,
      status: 200,
    },
  ]) {
    await context.test(testCase.name, async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), 'capture-fresh-network-'));
      const {
        startRegistries: _syntheticRegistry,
        applyOverlays: _syntheticOverlay,
        runCommand: _syntheticCommand,
        ...edges
      } = await syntheticEdgeDependencies(tempRoot);
      void _syntheticRegistry;
      void _syntheticOverlay;
      void _syntheticCommand;
      let npmEndpoint: string | undefined;
      let requested = false;
      await assert.rejects(
        runCaptureFreshProjection(
          {
            sourceRoot: 'C:\\fixture\\cert-prep',
            runtimeCandidateRoot:
              'C:\\software-dev\\capture-workbench-phase1-j30-runtime-candidate-0.4.2-luna-20260831-01',
            packageCandidateRoot:
              'C:\\software-dev\\capture-workbench-phase1-j16-package-candidate-b7c0e9',
          },
          {
            ...edges,
            validateRuntimeContent: async () => canonicalRuntimeContent(),
            applyOverlays: async ({ endpoints }) => {
              npmEndpoint = endpoints.npm;
            },
            runCommand: async (command) => {
              if (!requested && testCase.shouldRequest(command.phase, command.ecosystem)) {
                assert.ok(npmEndpoint);
                const response = await fetch(`${npmEndpoint}${testCase.path}`);
                assert.equal(response.status, testCase.status);
                requested = true;
              }
              if (command.phase === 'A' && command.ecosystem === 'cargo') {
                await writeFile(join(tempRoot, 'projection-a', 'pnpm-lock.yaml'), 'pnpm-lock\n');
                await writeFile(join(tempRoot, 'projection-a', 'apps/cert-prep-backend/uv.lock'), 'uv-lock\n');
                await writeFile(join(tempRoot, 'projection-a', 'apps/cert-prep-desktop/src-tauri/Cargo.lock'), 'cargo-lock\n');
              }
            },
          },
        ),
        testCase.expected,
      );
      assert.equal(requested, true);
    });
  }
});

test('production source adapter copies dirty tracked bytes and excludes arbitrary untracked files', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'capture-fresh-source-'));
  const tempRoot = await mkdtemp(join(tmpdir(), 'capture-fresh-projection-'));
  try {
    await execFileAsync('git', ['init', '--quiet'], { cwd: sourceRoot });
    await execFileAsync('git', ['config', 'user.email', 'capture-fresh@example.invalid'], { cwd: sourceRoot });
    await execFileAsync('git', ['config', 'user.name', 'Capture Fresh Test'], { cwd: sourceRoot });
    await writeFile(join(sourceRoot, 'tracked.txt'), 'committed\n');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: sourceRoot });
    await execFileAsync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: sourceRoot });
    await writeFile(join(sourceRoot, 'tracked.txt'), 'dirty tracked bytes\n');
    await writeFile(join(sourceRoot, 'untracked-secret.txt'), 'must not copy\n');

    const {
      snapshotSource: _syntheticSnapshot,
      copyTrackedSource: _syntheticCopy,
      ...edges
    } = await syntheticEdgeDependencies(tempRoot);
    void _syntheticSnapshot;
    void _syntheticCopy;
    let trackedCopy = '';
    let untrackedWasCopied = false;
    const manifest = await runCaptureFreshProjection(
      {
        sourceRoot,
        runtimeCandidateRoot: 'C:\\fixture\\j30',
        packageCandidateRoot: 'C:\\fixture\\j16',
      },
      {
        ...edges,
        validateRuntimeContent: async () => canonicalRuntimeContent(),
        loadAuthorities: async () => canonicalAuthorities(),
        runCommand: async (command) => {
          if (command.phase === 'A' && command.ecosystem === 'pnpm') {
            trackedCopy = await import('node:fs/promises').then(({ readFile }) =>
              readFile(join(tempRoot, 'projection-a', 'tracked.txt'), 'utf8'),
            );
            untrackedWasCopied = await import('node:fs/promises').then(({ access }) =>
              access(join(tempRoot, 'projection-a', 'untracked-secret.txt')).then(
                () => true,
                () => false,
              ),
            );
          }
          if (command.phase === 'A' && command.ecosystem === 'cargo') {
            await writeFile(join(tempRoot, 'projection-a', 'pnpm-lock.yaml'), 'pnpm-lock\n');
            await mkdir(join(tempRoot, 'projection-a', 'apps/cert-prep-backend'), { recursive: true });
            await mkdir(join(tempRoot, 'projection-a', 'apps/cert-prep-desktop/src-tauri'), { recursive: true });
            await writeFile(join(tempRoot, 'projection-a', 'apps/cert-prep-backend/uv.lock'), 'uv-lock\n');
            await writeFile(join(tempRoot, 'projection-a', 'apps/cert-prep-desktop/src-tauri/Cargo.lock'), 'cargo-lock\n');
          }
        },
      },
    );

    assert.equal(trackedCopy, 'dirty tracked bytes\n');
    assert.equal(untrackedWasCopied, false);
    assert.equal(manifest.checkout.trackedFileCount, 1);
    assert.equal(manifest.checkout.dirtyBefore, true);
  } finally {
    await import('node:fs/promises').then(({ rm }) =>
      rm(sourceRoot, { recursive: true, force: true }),
    );
  }
});

test('temporary overlays are 0.4.2-only, tolerate unavailable HEAD, and leave branch files untouched', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'capture-fresh-overlay-source-'));
  const tempRoot = await mkdtemp(join(tmpdir(), 'capture-fresh-overlay-projection-'));
  const packageJson = `${JSON.stringify(
    { dependencies: { '@gx-capture/capture-workbench-ui': '0.4.1' } },
    null,
    2,
  )}\n`;
  const workspace = "packages:\n  - apps/*\nminimumReleaseAgeExclude:\n  - '@gx-capture/capture-workbench-ui@0.4.1'\n  - '@gx-capture/capture-runtime-client@0.4.1'\n";
  const pyproject = '[project]\nname = "fixture"\ndependencies = ["capture-runtime-client==0.4.1"]\n';
  const cargoToml = '[package]\nname = "fixture"\nversion = "0.1.0"\n[dependencies]\ncapture-sidecar-launcher = "0.4.1"\n';
  try {
    await execFileAsync('git', ['init', '--quiet'], { cwd: sourceRoot });
    await mkdir(join(sourceRoot, 'apps/cert-prep-backend'), { recursive: true });
    await mkdir(join(sourceRoot, 'apps/cert-prep-desktop/src-tauri/src'), { recursive: true });
    await mkdir(join(sourceRoot, 'tools'), { recursive: true });
    await writeFile(join(sourceRoot, 'package.json'), packageJson);
    await writeFile(join(sourceRoot, 'pnpm-workspace.yaml'), workspace);
    await writeFile(join(sourceRoot, 'pnpm-lock.yaml'), 'branch pnpm lock\n');
    await writeFile(join(sourceRoot, 'apps/cert-prep-backend/pyproject.toml'), pyproject);
    await writeFile(join(sourceRoot, 'apps/cert-prep-backend/uv.lock'), 'branch uv lock\n');
    await writeFile(join(sourceRoot, 'apps/cert-prep-desktop/src-tauri/Cargo.toml'), cargoToml);
    await writeFile(join(sourceRoot, 'apps/cert-prep-desktop/src-tauri/Cargo.lock'), 'branch cargo lock\n');
    const runtimeVersionSource = [
      "export const CAPTURE_RUNTIME_VERSION = '0.4.1' as const;",
      'export const CAPTURE_RUNTIME_MODEL =',
      '  `capture-runtime@${CAPTURE_RUNTIME_VERSION}` as const;',
      "export const CAPTURE_SIDECAR_LAUNCHER_VERSION = '0.4.1' as const;",
      '',
    ].join('\n');
    const nativeConstantsSource = [
      'pub(crate) const CAPTURE_RUNTIME_VERSION: &str = "0.4.1";',
      'pub(crate) const CAPTURE_RUNTIME_MODEL: &str = "capture-runtime@0.4.1";',
      '',
    ].join('\n');
    await writeFile(join(sourceRoot, 'tools/capture-runtime-version.mts'), runtimeVersionSource);
    await writeFile(
      join(sourceRoot, 'apps/cert-prep-desktop/src-tauri/src/constants.rs'),
      nativeConstantsSource,
    );
    await execFileAsync('git', ['add', '.'], { cwd: sourceRoot });

    const {
      snapshotSource: _syntheticSnapshot,
      copyTrackedSource: _syntheticCopy,
      applyOverlays: _syntheticOverlay,
      ...edges
    } = await syntheticEdgeDependencies(tempRoot);
    void _syntheticSnapshot;
    void _syntheticCopy;
    void _syntheticOverlay;
    let overlayChecked = false;
    let projectionBOverlayChecked = false;
    const manifest = await runCaptureFreshProjection(
      {
        sourceRoot,
        runtimeCandidateRoot: 'C:\\fixture\\j30',
        packageCandidateRoot: 'C:\\fixture\\j16',
      },
      {
        ...edges,
        validateRuntimeContent: async () => canonicalRuntimeContent(),
        loadAuthorities: async () => canonicalAuthorities(),
        runCommand: async (command) => {
          if (command.phase === 'A' && command.ecosystem === 'pnpm') {
            const projectionRoot = join(tempRoot, 'projection-a');
            const projectedPackage = await import('node:fs/promises').then(({ readFile }) =>
              readFile(join(projectionRoot, 'package.json'), 'utf8'),
            );
            const projectedWorkspace = await import('node:fs/promises').then(({ readFile }) =>
              readFile(join(projectionRoot, 'pnpm-workspace.yaml'), 'utf8'),
            );
            const projectedNpmrc = await import('node:fs/promises').then(({ readFile }) =>
              readFile(join(projectionRoot, '.npmrc'), 'utf8'),
            );
            const projectedLock = await lstat(join(projectionRoot, 'pnpm-lock.yaml')).catch(
              (error: unknown) => {
                assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT');
                return undefined;
              },
            );
            const projectedPython = await import('node:fs/promises').then(({ readFile }) =>
              readFile(join(projectionRoot, 'apps/cert-prep-backend/pyproject.toml'), 'utf8'),
            );
            const projectedCargo = await import('node:fs/promises').then(({ readFile }) =>
              readFile(join(projectionRoot, 'apps/cert-prep-desktop/src-tauri/Cargo.toml'), 'utf8'),
            );
            const projectedCargoConfig = await import('node:fs/promises').then(({ readFile }) =>
              readFile(join(projectionRoot, '.cargo/config.toml'), 'utf8'),
            );
            const projectedRuntimeVersion = await readFile(
              join(projectionRoot, 'tools/capture-runtime-version.mts'),
              'utf8',
            );
            const projectedNativeConstants = await readFile(
              join(projectionRoot, 'apps/cert-prep-desktop/src-tauri/src/constants.rs'),
              'utf8',
            );
            assert.match(projectedPackage, /"@gx-capture\/capture-workbench-ui": "0\.4\.2"/u);
            assert.match(projectedPackage, /"@gx-capture\/capture-runtime-client": "0\.4\.2"/u);
            assert.doesNotMatch(projectedPackage, /"pnpm"\s*:/u);
            assert.equal(projectedLock, undefined);
            assert.doesNotMatch(projectedWorkspace, /@gx-capture\/[^']+@0\.4\.1/u);
            assert.match(
              projectedWorkspace,
              /^overrides:\r?\n(?:[^\r\n]*\r?\n)*[ ]{2}['"]?@gx-capture\/capture-runtime-client['"]?: ['"]?0\.4\.2['"]?\s*$/mu,
            );
            assert.match(
              projectedWorkspace,
              /^overrides:\r?\n(?:[^\r\n]*\r?\n)*[ ]{2}['"]?@gx-capture\/capture-workbench-ui['"]?: ['"]?0\.4\.2['"]?\s*$/mu,
            );
            assert.match(projectedNpmrc, /^@gx-capture:registry=http:\/\/127\.0\.0\.1:/u);
            assert.match(projectedPython, /capture-runtime-client==0\.4\.2/u);
            assert.match(projectedPython, /explicit = true/u);
            assert.match(projectedCargo, /version = "=0\.4\.2", registry = "capture-fresh"/u);
            assert.match(projectedCargoConfig, /sparse\+http:\/\/127\.0\.0\.1:/u);
            assert.match(
              projectedRuntimeVersion,
              /^export const CAPTURE_RUNTIME_VERSION = '0\.4\.2' as const;$/mu,
            );
            assert.match(
              projectedRuntimeVersion,
              /^export const CAPTURE_SIDECAR_LAUNCHER_VERSION = '0\.4\.2' as const;$/mu,
            );
            assert.match(
              projectedNativeConstants,
              /^pub\(crate\) const CAPTURE_RUNTIME_VERSION: &str = "0\.4\.2";$/mu,
            );
            assert.match(
              projectedNativeConstants,
              /^pub\(crate\) const CAPTURE_RUNTIME_MODEL: &str = "capture-runtime@0\.4\.2";$/mu,
            );
            overlayChecked = true;
          }
          if (command.phase === 'B' && command.ecosystem === 'pnpm') {
            const projectionRoot = join(tempRoot, 'projection-b');
            const projectedPackage = await readFile(join(projectionRoot, 'package.json'), 'utf8');
            const projectedWorkspace = await readFile(join(projectionRoot, 'pnpm-workspace.yaml'), 'utf8');
            const projectedNpmrc = await readFile(join(projectionRoot, '.npmrc'), 'utf8');
            const projectedPython = await readFile(
              join(projectionRoot, 'apps/cert-prep-backend/pyproject.toml'),
              'utf8',
            );
            const projectedCargo = await readFile(
              join(projectionRoot, 'apps/cert-prep-desktop/src-tauri/Cargo.toml'),
              'utf8',
            );
            const projectedCargoConfig = await readFile(
              join(projectionRoot, '.cargo/config.toml'),
              'utf8',
            );
            const projectedRuntimeVersion = await readFile(
              join(projectionRoot, 'tools/capture-runtime-version.mts'),
              'utf8',
            );
            const projectedNativeConstants = await readFile(
              join(projectionRoot, 'apps/cert-prep-desktop/src-tauri/src/constants.rs'),
              'utf8',
            );
            assert.match(projectedPackage, /"@gx-capture\/capture-workbench-ui": "0\.4\.2"/u);
            assert.match(projectedPackage, /"@gx-capture\/capture-runtime-client": "0\.4\.2"/u);
            assert.doesNotMatch(projectedWorkspace, /@gx-capture\/[^']+@0\.4\.1/u);
            assert.match(
              projectedWorkspace,
              /^overrides:\r?\n(?:[^\r\n]*\r?\n)*[ ]{2}['"]?@gx-capture\/capture-runtime-client['"]?: ['"]?0\.4\.2['"]?\s*$/mu,
            );
            assert.match(
              projectedWorkspace,
              /^overrides:\r?\n(?:[^\r\n]*\r?\n)*[ ]{2}['"]?@gx-capture\/capture-workbench-ui['"]?: ['"]?0\.4\.2['"]?\s*$/mu,
            );
            assert.match(projectedNpmrc, /^@gx-capture:registry=http:\/\/127\.0\.0\.1:/u);
            assert.match(projectedPython, /capture-runtime-client==0\.4\.2/u);
            assert.match(projectedCargo, /version = "=0\.4\.2", registry = "capture-fresh"/u);
            assert.match(projectedCargoConfig, /sparse\+http:\/\/127\.0\.0\.1:/u);
            assert.equal(
              [...projectedRuntimeVersion.matchAll(/^export const CAPTURE_RUNTIME_VERSION = '([^']+)' as const;$/gmu)].length,
              1,
            );
            assert.match(
              projectedRuntimeVersion,
              /^export const CAPTURE_RUNTIME_VERSION = '0\.4\.2' as const;$/mu,
            );
            assert.match(
              projectedRuntimeVersion,
              /^export const CAPTURE_RUNTIME_MODEL =\r?\n\s+`capture-runtime@\$\{CAPTURE_RUNTIME_VERSION\}` as const;$/mu,
            );
            assert.match(
              projectedRuntimeVersion,
              /^export const CAPTURE_SIDECAR_LAUNCHER_VERSION = '0\.4\.2' as const;$/mu,
            );
            assert.equal(
              [...projectedNativeConstants.matchAll(/^pub\(crate\) const CAPTURE_RUNTIME_VERSION: &str = "([^"]+)";$/gmu)].length,
              1,
            );
            assert.match(
              projectedNativeConstants,
              /^pub\(crate\) const CAPTURE_RUNTIME_VERSION: &str = "0\.4\.2";$/mu,
            );
            assert.match(
              projectedNativeConstants,
              /^pub\(crate\) const CAPTURE_RUNTIME_MODEL: &str = "capture-runtime@0\.4\.2";$/mu,
            );
            projectionBOverlayChecked = true;
          }
          if (command.phase === 'A' && command.ecosystem === 'cargo') {
            await writeFile(join(tempRoot, 'projection-a', 'pnpm-lock.yaml'), 'generated pnpm lock\n');
            await writeFile(join(tempRoot, 'projection-a', 'apps/cert-prep-backend/uv.lock'), 'generated uv lock\n');
            await writeFile(join(tempRoot, 'projection-a', 'apps/cert-prep-desktop/src-tauri/Cargo.lock'), 'generated cargo lock\n');
          }
        },
      },
    );

    assert.equal(overlayChecked, true);
    assert.equal(projectionBOverlayChecked, true);
    assert.equal(manifest.checkout.headBefore, null);
    assert.equal(manifest.checkout.headAfter, null);
    assert.equal(manifest.cleanup.sourceUnchanged, true);
    assert.equal(await import('node:fs/promises').then(({ readFile }) => readFile(join(sourceRoot, 'package.json'), 'utf8')), packageJson);
    assert.equal(await import('node:fs/promises').then(({ readFile }) => readFile(join(sourceRoot, 'pnpm-lock.yaml'), 'utf8')), 'branch pnpm lock\n');
    assert.equal(await import('node:fs/promises').then(({ readFile }) => readFile(join(sourceRoot, 'apps/cert-prep-backend/uv.lock'), 'utf8')), 'branch uv lock\n');
    assert.equal(await import('node:fs/promises').then(({ readFile }) => readFile(join(sourceRoot, 'apps/cert-prep-desktop/src-tauri/Cargo.lock'), 'utf8')), 'branch cargo lock\n');
    assert.equal(await readFile(join(sourceRoot, 'tools/capture-runtime-version.mts'), 'utf8'), runtimeVersionSource);
    assert.equal(
      await readFile(join(sourceRoot, 'apps/cert-prep-desktop/src-tauri/src/constants.rs'), 'utf8'),
      nativeConstantsSource,
    );
  } finally {
    await import('node:fs/promises').then(({ rm }) =>
      rm(sourceRoot, { recursive: true, force: true }),
    );
  }
});

test('Capture Runtime packages reject local sources, direct_url metadata, and sibling realpaths', async (context) => {
  for (const testCase of [
    {
      name: 'file source',
      mutate(resolutions: Array<Record<string, unknown>>) {
        resolutions[0].sourceKind = 'file';
        resolutions[0].source = 'file:../capture-workbench';
      },
    },
    {
      name: 'Python direct_url metadata',
      mutate(resolutions: Array<Record<string, unknown>>) {
        resolutions[2].directUrl = true;
      },
    },
    {
      name: 'sibling checkout realpath',
      mutate(resolutions: Array<Record<string, unknown>>) {
        resolutions[1].realPath =
          'C:\\software-dev\\capture-workbench\\packages\\capture-workbench-ui';
      },
    },
  ]) {
    await context.test(testCase.name, async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), 'capture-fresh-resolution-'));
      const edges = await syntheticEdgeDependencies(tempRoot);
      const resolutions = (await edges.collectResolutions()) as Array<Record<string, unknown>>;
      testCase.mutate(resolutions);
      await assert.rejects(
        runCaptureFreshProjection(
          {
            sourceRoot: 'C:\\fixture\\cert-prep',
            runtimeCandidateRoot: 'C:\\fixture\\j30',
            packageCandidateRoot: 'C:\\fixture\\j16',
          },
          {
            ...edges,
            validateRuntimeContent: async () => canonicalRuntimeContent(),
            loadAuthorities: async () => canonicalAuthorities(),
            collectResolutions: async () => resolutions as never,
          },
        ),
        /did not resolve from the exact registry bytes|forbidden candidate or source tree/u,
      );
    });
  }
});

test('source commits, HEAD availability, and dirty metadata are informational only', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'capture-fresh-informational-'));
  const edges = await syntheticEdgeDependencies(tempRoot);
  let observation = 0;
  const manifest = await runCaptureFreshProjection(
    {
      sourceRoot: 'C:\\fixture\\cert-prep',
      runtimeCandidateRoot: 'C:\\fixture\\j30',
      packageCandidateRoot: 'C:\\fixture\\j16',
    },
    {
      ...edges,
      validateRuntimeContent: async () => canonicalRuntimeContent(),
      loadAuthorities: async () => {
        const authorities = canonicalAuthorities();
        authorities.runtime.sourceCommit = 'not-a-git-sha';
        authorities.packages.sourceCommit = 'also-informational';
        return authorities;
      },
      snapshotSource: async () => {
        observation += 1;
        return {
          trackedTreeSha256: SHA.tree,
          trackedFileCount: 42,
          head: observation === 1 ? null : 'e'.repeat(40),
          dirty: observation === 1,
          statusSha256: observation === 1 ? SHA.status : null,
        };
      },
    },
  );

  assert.equal(manifest.checkout.sourceCommit, null);
  assert.equal(manifest.checkout.packageSourceCommit, null);
  assert.equal(manifest.checkout.headBefore, null);
  assert.equal(manifest.checkout.headAfter, 'e'.repeat(40));
  assert.equal(manifest.checkout.dirtyBefore, true);
  assert.equal(manifest.checkout.dirtyAfter, false);
  assert.equal(manifest.cleanup.sourceUnchanged, true);
});

test('injected command failure still closes owned servers and children, proves listeners, and removes temp', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'capture-fresh-cleanup-'));
  const edges = await syntheticEdgeDependencies(tempRoot);
  let serverCloseCount = 0;
  let childCleanupCount = 0;
  let listenerProofCount = 0;
  let tempRemovalCount = 0;
  let sourceSnapshotCount = 0;
  let candidateSnapshotCount = 0;

  await assert.rejects(
    runCaptureFreshProjection(
      {
        sourceRoot: 'C:\\fixture\\cert-prep',
        runtimeCandidateRoot: 'C:\\fixture\\j30',
        packageCandidateRoot: 'C:\\fixture\\j16',
      },
      {
        ...edges,
        validateRuntimeContent: async () => canonicalRuntimeContent(),
        loadAuthorities: async () => canonicalAuthorities(),
        snapshotSource: async () => {
          sourceSnapshotCount += 1;
          return {
            trackedTreeSha256: SHA.tree,
            trackedFileCount: 42,
            head: null,
            dirty: null,
            statusSha256: null,
          };
        },
        snapshotCandidate: async () => {
          candidateSnapshotCount += 1;
          return { treeSha256: SHA.tree, fileCount: 20 };
        },
        startRegistries: async () => ({
          endpoints: {
            npm: 'http://127.0.0.1:43001',
            python: 'http://127.0.0.1:43002',
            cargo: 'sparse+http://127.0.0.1:43003/index/',
          },
          ports: [43001, 43002, 43003],
          preflight: async () => undefined,
          audit: () => ({
            requestCount: 10,
            acceptedCount: 10,
            rejectedCount: 0,
            requiredRouteCount: 10,
            coveredRouteCount: 10,
            auditSha256: SHA.audit,
          }),
          close: async () => {
            serverCloseCount += 3;
            return 3;
          },
        }),
        runCommand: async (command) => {
          if (command.phase === 'A' && command.ecosystem === 'python') {
            throw new Error('injected command failure');
          }
        },
        closeOwnedChildren: async () => {
          childCleanupCount += 1;
          return 2;
        },
        assertListenersClosed: async () => {
          listenerProofCount += 1;
          return 0;
        },
        removeTempRoot: async () => {
          tempRemovalCount += 1;
          await import('node:fs/promises').then(({ rm }) =>
            rm(tempRoot, { recursive: true, force: true }),
          );
        },
      },
    ),
    /injected command failure/u,
  );

  assert.equal(serverCloseCount, 3);
  assert.equal(childCleanupCount, 1);
  assert.equal(listenerProofCount, 1);
  assert.equal(tempRemovalCount, 1);
  assert.equal(sourceSnapshotCount, 2);
  assert.equal(candidateSnapshotCount, 4);
});

test('production resolution inspection seals registry locks and installed realpaths for all Capture packages', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'capture-fresh-inspection-'));
  const { collectResolutions: _syntheticInspection, ...edges } =
    await syntheticEdgeDependencies(tempRoot);
  void _syntheticInspection;
  const npmEndpoint = 'http://127.0.0.1:42001';
  const pythonEndpoint = 'http://127.0.0.1:42002';
  const cargoEndpoint = 'sparse+http://127.0.0.1:42003/index/';

  const manifest = await runCaptureFreshProjection(
    {
      sourceRoot: 'C:\\fixture\\cert-prep',
      runtimeCandidateRoot: 'C:\\fixture\\j30',
      packageCandidateRoot: 'C:\\fixture\\j16',
    },
    {
      ...edges,
      validateRuntimeContent: async () => canonicalRuntimeContent(),
      loadAuthorities: async () => canonicalAuthorities(),
      runCommand: async (command) => {
        if (command.phase === 'A' && command.ecosystem === 'cargo') {
          const pnpmLock = [
            "lockfileVersion: '9.0'",
            'packages:',
            "  '@gx-capture/capture-runtime-client@0.4.2':",
            `    resolution: {integrity: sha512-JvNbGqEZIiZ0Fe+cqJmJQQIIeZbTNrlncOqcYBFNK+ZZWgrwgYe/Zru5WlUEKUybANbX7VnjvhPmUj/Mq12Imw==, tarball: ${npmEndpoint}/tarballs/gx-capture-capture-runtime-client-0.4.2.tgz}`,
            "  '@gx-capture/capture-workbench-ui@0.4.2':",
            `    resolution: {integrity: sha512-P4hM4Y59te8HN2p0XTcowYWkSSsYhX9hlvtM1sKr/TqHcvwoL4xzL8IVS+HrydlwI6fdzANa1ihFFOSFoO0XBA==, tarball: ${npmEndpoint}/tarballs/gx-capture-capture-workbench-ui-0.4.2.tgz}`,
            '',
          ].join('\n');
          const uvLock = [
            '[[package]]',
            'name = "capture-runtime-client"',
            'version = "0.4.2"',
            `source = { registry = "${pythonEndpoint}/simple/" }`,
            `wheels = [{ url = "${pythonEndpoint}/packages/capture_runtime_client-0.4.2-py3-none-any.whl", hash = "sha256:${SHA.wheel}", size = 85227 }]`,
            '',
          ].join('\n');
          const cargoLock = [
            '[[package]]',
            'name = "capture-sidecar-launcher"',
            'version = "0.4.2"',
            `source = "${cargoEndpoint}"`,
            `checksum = "${SHA.crate}"`,
            '',
          ].join('\n');
          await writeFile(join(tempRoot, 'projection-a', 'pnpm-lock.yaml'), pnpmLock);
          await writeFile(join(tempRoot, 'projection-a', 'apps/cert-prep-backend/uv.lock'), uvLock);
          await writeFile(join(tempRoot, 'projection-a', 'apps/cert-prep-desktop/src-tauri/Cargo.lock'), cargoLock);
        }
        if (command.phase === 'B' && command.ecosystem === 'cargo') {
          for (const [name, packageManifest] of [
            [
              '@gx-capture/capture-runtime-client',
              { name: '@gx-capture/capture-runtime-client', version: '0.4.2' },
            ],
            [
              '@gx-capture/capture-workbench-ui',
              { name: '@gx-capture/capture-workbench-ui', version: '0.4.2' },
            ],
          ] as const) {
            const directory = join(tempRoot, 'projection-b', 'node_modules', ...name.split('/'));
            await mkdir(directory, { recursive: true });
            await writeFile(join(directory, 'package.json'), JSON.stringify(packageManifest));
          }
          const distInfo = join(
            tempRoot,
            'projection-b/apps/cert-prep-backend/.venv/Lib/site-packages/capture_runtime_client-0.4.2.dist-info',
          );
          await mkdir(distInfo, { recursive: true });
          await writeFile(join(distInfo, 'METADATA'), 'Name: capture-runtime-client\nVersion: 0.4.2\n');
          const crateSource = join(
            tempRoot,
            'cache/cargo/registry/src/capture-fresh/capture-sidecar-launcher-0.4.2',
          );
          await mkdir(crateSource, { recursive: true });
          await writeFile(
            join(crateSource, 'Cargo.toml'),
            '[package]\nname = "capture-sidecar-launcher"\nversion = "0.4.2"\n',
          );
        }
      },
    },
  );

  assert.equal(manifest.projections.captureResolutionCount, 4);
});

test('fresh artifact export stays fail-closed without sealed projection B build evidence', async (context) => {
  await context.test('no artifact produced', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'capture-fresh-no-artifact-'));
    const outputRoot = await mkdtemp(join(tmpdir(), 'capture-fresh-output-'));
    try {
      const manifest = await runCaptureFreshProjection(
        {
          sourceRoot: 'C:\\fixture\\cert-prep',
          runtimeCandidateRoot: 'C:\\fixture\\j30',
          packageCandidateRoot: 'C:\\fixture\\j16',
          outputRoot,
        },
        {
          ...(await syntheticEdgeDependencies(tempRoot)),
          validateRuntimeContent: async () => canonicalRuntimeContent(),
          loadAuthorities: async () => canonicalAuthorities(),
          validateOutputRoot: async () => undefined,
          exportFreshArtifact: async () => null,
        },
      );
      assert.deepEqual(manifest.artifactExport, {
        freshArtifactExported: false,
        installedAcceptanceProven: false,
      });
    } finally {
      await import('node:fs/promises').then(({ rm }) =>
        rm(outputRoot, { recursive: true, force: true }),
      );
    }
  });

  await context.test('synthetic or stale receipt cannot claim a fresh installer', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'capture-fresh-stale-artifact-'));
    const outputRoot = await mkdtemp(join(tmpdir(), 'capture-fresh-stale-output-'));
    try {
      await assert.rejects(
        runCaptureFreshProjection(
          {
            sourceRoot: 'C:\\fixture\\cert-prep',
            runtimeCandidateRoot: 'C:\\fixture\\j30',
            packageCandidateRoot: 'C:\\fixture\\j16',
            outputRoot,
          },
          {
            ...(await syntheticEdgeDependencies(tempRoot)),
            validateRuntimeContent: async () => canonicalRuntimeContent(),
            loadAuthorities: async () => canonicalAuthorities(),
            validateOutputRoot: async () => undefined,
            exportFreshArtifact: async (request) =>
              ({
                evidenceKind: 'fresh-build-output',
                artifactKind: 'cert-installer',
                fileName: 'cert-prep-installer.exe',
                bytes: 123,
                sha256: 'f'.repeat(64),
                freshBuild: false,
                sourceTrackedTreeSha256: request.sourceTrackedTreeSha256,
                runtimeCandidateId: request.runtimeCandidateId,
                packageCandidateId: request.packageCandidateId,
                lockSetSha256: request.lockSetSha256,
              }) as never,
          },
        ),
        /receipt is not sealed to projection B/u,
      );
    } finally {
      await import('node:fs/promises').then(({ rm }) =>
        rm(outputRoot, { recursive: true, force: true }),
      );
    }
  });
});

test('fresh projection fails closed when source, J30, or J16 snapshots change', async (context) => {
  for (const testCase of [
    { name: 'tracked source', expected: /Tracked source content changed/u },
    { name: 'J30', expected: /J30 runtime candidate changed/u },
    { name: 'J16', expected: /J16 package candidate changed/u },
  ]) {
    await context.test(testCase.name, async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), 'capture-fresh-unchanged-'));
      const edges = await syntheticEdgeDependencies(tempRoot);
      let sourceObservations = 0;
      const candidateObservations = new Map<string, number>();
      await assert.rejects(
        runCaptureFreshProjection(
          {
            sourceRoot: 'C:\\fixture\\cert-prep',
            runtimeCandidateRoot: 'C:\\fixture\\j30',
            packageCandidateRoot: 'C:\\fixture\\j16',
          },
          {
            ...edges,
            validateRuntimeContent: async () => canonicalRuntimeContent(),
            loadAuthorities: async () => canonicalAuthorities(),
            snapshotSource: async () => {
              sourceObservations += 1;
              return {
                trackedTreeSha256:
                  testCase.name === 'tracked source' && sourceObservations === 2
                    ? '0'.repeat(64)
                    : SHA.tree,
                trackedFileCount: 42,
                head: null,
                dirty: null,
                statusSha256: null,
              };
            },
            snapshotCandidate: async (root) => {
              const count = (candidateObservations.get(root) ?? 0) + 1;
              candidateObservations.set(root, count);
              const shouldDrift =
                count === 2 &&
                ((testCase.name === 'J30' && root.endsWith('j30')) ||
                  (testCase.name === 'J16' && root.endsWith('j16')));
              return {
                treeSha256: shouldDrift ? '0'.repeat(64) : SHA.tree,
                fileCount: 20,
              };
            },
          },
        ),
        testCase.expected,
      );
    });
  }
});
