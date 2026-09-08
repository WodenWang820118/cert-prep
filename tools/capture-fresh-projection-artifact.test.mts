import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createFreshProjectionArtifactExporter,
  type FreshArtifactArchiveExtractor,
  type FreshArtifactCommand,
  type FreshArtifactCommandResult,
} from './capture-fresh-projection-artifact.mts';
import type {
  FreshProjectionArtifactExportRequest,
} from './capture-fresh-projection.mts';

const EXTRACTOR_SHA256 = '4cd7d776c686427226a151789d2d61f0b2ed2c392148cc4e69c0238362fafecf';
const PROFILE_PATH = '_internal/capture_runtime/assets/ocr-profile.json';
const RUNTIME_FILE = 'capture-runtime-x86_64-pc-windows-msvc.exe';
const SCHEMA_FILE = 'capture-document-v2.schema.json';
const OCR_FILE = 'capture-engine-ocr-0.4.2-windows-x64.zip';
const OCR_MANIFEST_FILE = 'capture-engine-ocr-0.4.2-windows-x64-files.json';
const WHEEL_FILE = 'capture_runtime_client-0.4.2-py3-none-any.whl';
const BACKEND_ZIP = 'cert-prep-backend-runtime-0.1.0-alpha.1-x86_64-pc-windows-msvc.zip';
const BACKEND_FILE = 'cert-prep-backend.exe';
const INSTALLER = 'Cert Prep_0.1.0-alpha.1_x64-setup.exe';

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function json(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function descriptor(path: string, content: Uint8Array) {
  return { path, bytes: content.length, sha256: sha256(content) };
}

function createAuthorityManifest(
  candidateKind: 'runtime' | 'npm-package-set',
  fields: Record<string, unknown>,
  artifacts: readonly ReturnType<typeof descriptor>[],
): { readonly bytes: Buffer; readonly candidateId: string } {
  const base = {
    schemaVersion: '1',
    candidateKind,
    releaseVersion: '0.4.2',
    ...fields,
    artifacts,
  };
  const candidateId = sha256(JSON.stringify(base));
  return { bytes: json({ ...base, candidateId }), candidateId };
}

interface Fixture {
  readonly root: string;
  readonly projectionRoot: string;
  readonly runtimeRoot: string;
  readonly packageRoot: string;
  readonly outputRoot: string;
  readonly request: FreshProjectionArtifactExportRequest;
  readonly runtime: Record<string, Buffer>;
  readonly backend: Buffer;
  readonly provenance: Buffer;
  readonly installer: Buffer;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'cert-fresh-artifact-test-'));
  const projectionRoot = join(root, 'projection-b');
  const runtimeRoot = join(root, 'j30');
  const packageRoot = join(root, 'j16');
  const outputRoot = join(root, 'output');
  await Promise.all([
    mkdir(projectionRoot, { recursive: true }),
    mkdir(join(runtimeRoot, 'runtime'), { recursive: true }),
    mkdir(join(runtimeRoot, 'contracts'), { recursive: true }),
    mkdir(join(runtimeRoot, 'python'), { recursive: true }),
    mkdir(join(packageRoot, 'contracts'), { recursive: true }),
    mkdir(packageRoot, { recursive: true }),
    mkdir(outputRoot, { recursive: true }),
  ]);
  const runtime: Record<string, Buffer> = {
    [RUNTIME_FILE]: Buffer.from('runtime-bytes'),
    [SCHEMA_FILE]: Buffer.from('schema-bytes'),
    'capture-runtime-manifest.json': Buffer.alloc(0),
    'capture-engine-catalog.json': Buffer.alloc(0),
    [OCR_FILE]: Buffer.from('ocr-archive-bytes'),
    [OCR_MANIFEST_FILE]: Buffer.alloc(0),
    'contract-set.json': Buffer.from('{"contract":"v3"}\n'),
    [WHEEL_FILE]: Buffer.from('wheel-bytes'),
  };
  runtime['capture-runtime-manifest.json'] = json({
    manifestVersion: '1',
    runtimeVersion: '0.4.2',
    apiVersion: '2.0',
    captureDocumentSchemaVersion: '2',
    platform: 'windows',
    arch: 'x86_64',
    fileName: RUNTIME_FILE,
    bytes: runtime[RUNTIME_FILE].length,
    sha256: sha256(runtime[RUNTIME_FILE]),
    schemaFileName: SCHEMA_FILE,
    schemaSha256: sha256(runtime[SCHEMA_FILE]),
    contractSetSha256: sha256(runtime['contract-set.json']),
  });
  const profile = Buffer.from('{"profileId":"fixture-profile","model":"fixture"}\n');
  runtime[OCR_MANIFEST_FILE] = json({
    files: [{ path: PROFILE_PATH, bytes: profile.length, sha256: sha256(profile) }],
  });
  runtime['capture-engine-catalog.json'] = json({
    runtimeVersion: '0.4.2',
    requirements: [{
      requirementId: 'windowsml-ocr',
      artifacts: [{
        fileName: OCR_FILE,
        entryPoint: 'capture-engine-ocr.exe',
        bytes: runtime[OCR_FILE].length,
        sha256: sha256(runtime[OCR_FILE]),
        filesManifestSha256: sha256(runtime[OCR_MANIFEST_FILE]),
      }],
    }],
  });
  const runtimeArtifacts = [
    descriptor(`runtime/${RUNTIME_FILE}`, runtime[RUNTIME_FILE]),
    descriptor(`runtime/${SCHEMA_FILE}`, runtime[SCHEMA_FILE]),
    descriptor('runtime/capture-runtime-manifest.json', runtime['capture-runtime-manifest.json']),
    descriptor('runtime/capture-engine-catalog.json', runtime['capture-engine-catalog.json']),
    descriptor(`runtime/${OCR_FILE}`, runtime[OCR_FILE]),
    descriptor(`runtime/${OCR_MANIFEST_FILE}`, runtime[OCR_MANIFEST_FILE]),
    descriptor('contracts/contract-set.json', runtime['contract-set.json']),
    descriptor(`python/${WHEEL_FILE}`, runtime[WHEEL_FILE]),
  ];
  const runtimeManifest = createAuthorityManifest('runtime', {
    sourceCommit: '1'.repeat(40),
    packageCandidateId: 'pending',
    contractSetSha256: sha256(runtime['contract-set.json']),
    releaseMode: 'model-enabled',
  }, runtimeArtifacts);
  for (const [path, content] of [
    [`runtime/${RUNTIME_FILE}`, runtime[RUNTIME_FILE]],
    [`runtime/${SCHEMA_FILE}`, runtime[SCHEMA_FILE]],
    ['runtime/capture-runtime-manifest.json', runtime['capture-runtime-manifest.json']],
    ['runtime/capture-engine-catalog.json', runtime['capture-engine-catalog.json']],
    [`runtime/${OCR_FILE}`, runtime[OCR_FILE]],
    [`runtime/${OCR_MANIFEST_FILE}`, runtime[OCR_MANIFEST_FILE]],
    ['contracts/contract-set.json', runtime['contract-set.json']],
    [`python/${WHEEL_FILE}`, runtime[WHEEL_FILE]],
  ] as const) {
    await mkdir(join(runtimeRoot, path, '..'), { recursive: true });
    await writeFile(join(runtimeRoot, path), content);
  }
  await writeFile(join(runtimeRoot, 'candidate-manifest.json'), runtimeManifest.bytes);

  const packageManifest = json({ schemaVersion: '1', candidateKind: 'npm-package-set', releaseVersion: '0.4.2', packages: [] });
  const packageArtifacts = [
    descriptor('package-manifest.json', packageManifest),
    descriptor('contracts/contract-set.json', runtime['contract-set.json']),
  ];
  const packageAuthority = createAuthorityManifest('npm-package-set', {
    sourceCommit: '2'.repeat(40),
    packageManifestSha256: sha256(packageManifest),
    contractSetSha256: sha256(runtime['contract-set.json']),
  }, packageArtifacts);
  await writeFile(join(packageRoot, 'package-manifest.json'), packageManifest);
  await writeFile(join(packageRoot, 'contracts/contract-set.json'), runtime['contract-set.json']);
  await writeFile(join(packageRoot, 'candidate-manifest.json'), packageAuthority.bytes);
  const backend = Buffer.from('backend-executable');
  const provenance = json({ schema_version: 1, status: 'bound', runtime_version: '0.4.2', runtime_core_sha256: sha256(runtime[RUNTIME_FILE]) });
  const installer = Buffer.from('fresh-installer');
  const request = {
    projectionRoot,
    outputRoot,
    runtimeCandidateRoot: runtimeRoot,
    packageCandidateRoot: packageRoot,
    sourceTrackedTreeSha256: 'a'.repeat(64),
    runtimeCandidateId: runtimeManifest.candidateId,
    packageCandidateId: packageAuthority.candidateId,
    lockSetSha256: 'b'.repeat(64),
  };
  // The runtime manifest links to the J16 candidate ID; rewrite and re-seal it once known.
  const runtimeManifestWithPackage = createAuthorityManifest('runtime', {
    sourceCommit: '1'.repeat(40),
    packageCandidateId: packageAuthority.candidateId,
    contractSetSha256: sha256(runtime['contract-set.json']),
    releaseMode: 'model-enabled',
  }, runtimeArtifacts);
  await writeFile(join(runtimeRoot, 'candidate-manifest.json'), runtimeManifestWithPackage.bytes);
  return { root, projectionRoot, runtimeRoot, packageRoot, outputRoot, request: { ...request, runtimeCandidateId: runtimeManifestWithPackage.candidateId }, runtime, backend, provenance, installer };
}

function fakeAdapters(
  fixture: Fixture,
  options: {
    readonly multipleInstallers?: boolean;
    readonly noInstaller?: boolean;
    readonly failExtraction?: boolean;
    readonly driftRuntime?: boolean;
    readonly lowercaseArchiveType?: boolean;
  } = {},
) {
  const commands: FreshArtifactCommand[] = [];
  const extractor: FreshArtifactArchiveExtractor = {
    authorityClass: 'local-pinned-hash',
    version: '25.01',
    sha256: EXTRACTOR_SHA256,
    inspectArchive: async (path) => {
      const type = path.endsWith(INSTALLER) ? 'Nsis' : 'Zip';
      return options.lowercaseArchiveType ? type.toLocaleLowerCase() : type;
    },
    extractArchive: async (archivePath, members, outputRoot) => {
      await mkdir(outputRoot, { recursive: true });
      for (const member of members) {
        if (options.failExtraction && member.startsWith('resources/')) {
          throw new Error('static extraction failure');
        }
        let content: Buffer;
        if (member === PROFILE_PATH) content = Buffer.from('{"profileId":"fixture-profile","model":"fixture"}\n');
        else if (member === `resources/${RUNTIME_FILE}`) content = options.driftRuntime ? Buffer.from('drifted') : fixture.runtime[RUNTIME_FILE];
        else if (member === `resources/${SCHEMA_FILE}`) content = fixture.runtime[SCHEMA_FILE];
        else if (member === 'resources/capture-runtime-manifest.json') content = fixture.runtime['capture-runtime-manifest.json'];
        else if (member === 'resources/backend-runtime-manifest.json') content = json({
          kind: 'python_backend', version: '0.1.0-alpha.1', target: 'x86_64-pc-windows-msvc', entrypoint: BACKEND_FILE,
          artifact: { file_name: BACKEND_ZIP, bytes: 11, sha256: sha256('backend-zip'), url: null },
        });
        else if (member === `resources/${BACKEND_ZIP}`) content = Buffer.from('backend-zip');
        else if (member === BACKEND_FILE) content = fixture.backend;
        else throw new Error(`Unexpected fake extraction member: ${member}`);
        await mkdir(join(outputRoot, member, '..'), { recursive: true });
        await writeFile(join(outputRoot, member), content);
      }
    },
  };
  const runCommand = async (command: FreshArtifactCommand): Promise<FreshArtifactCommandResult> => {
    commands.push(command);
    if (command.label === 'Fresh backend runtime build') {
      await mkdir(join(fixture.projectionRoot, 'apps/cert-prep-backend/dist/backend-runtime'), { recursive: true });
      await mkdir(join(fixture.projectionRoot, 'apps/cert-prep-backend/dist'), { recursive: true });
      await writeFile(join(fixture.projectionRoot, 'apps/cert-prep-backend/dist/capture-runtime-provenance.json'), fixture.provenance);
      await writeFile(join(fixture.projectionRoot, 'apps/cert-prep-backend/dist/backend-runtime', BACKEND_ZIP), Buffer.from('backend-zip'));
      await writeFile(join(fixture.projectionRoot, 'apps/cert-prep-backend/dist/backend-runtime/backend-runtime-manifest.json'), json({
        kind: 'python_backend', version: '0.1.0-alpha.1', target: 'x86_64-pc-windows-msvc', entrypoint: BACKEND_FILE,
        artifact: { file_name: BACKEND_ZIP, bytes: 11, sha256: sha256('backend-zip'), url: null },
      }));
    } else if (command.label === 'Fresh Cert Prep NSIS build') {
      const nsisRoot = join(fixture.projectionRoot, 'apps/cert-prep-desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis');
      await mkdir(nsisRoot, { recursive: true });
      if (!options.noInstaller) await writeFile(join(nsisRoot, INSTALLER), fixture.installer);
      if (options.multipleInstallers) await writeFile(join(nsisRoot, 'Cert Prep_extra_x64-setup.exe'), fixture.installer);
    } else if (command.label === 'Embedded backend provenance extraction') {
      return { status: 0, stdout: fixture.provenance, stderr: Buffer.alloc(0) };
    }
    return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  return { commands, extractor, runCommand };
}

async function cleanup(fixture: Fixture): Promise<void> {
  await rm(fixture.root, { recursive: true, force: true });
}

test('production exporter builds, statically verifies, and exports exactly installer plus content-addressed receipt', async () => {
  const fixture = await createFixture();
  const adapters = fakeAdapters(fixture);
  try {
    const receipt = await createFreshProjectionArtifactExporter({
      extractor: adapters.extractor,
      runCommand: adapters.runCommand,
      readEmbeddedProvenance: async () => fixture.provenance,
    })(fixture.request);
    assert.equal(receipt.freshBuild, true);
    assert.equal(receipt.installedAcceptanceProven, false);
    assert.equal(receipt.extractor.authorityClass, 'local-pinned-hash');
    assert.equal(receipt.extractor.version, '25.01');
    assert.equal(receipt.installer.fileName, INSTALLER);
    const outputNames = await readdir(fixture.outputRoot);
    assert.deepEqual(outputNames.length, 2);
    const receiptName = outputNames.find((name) => name.startsWith('cert-prep-installer-receipt-')) ?? '';
    assert.match(receiptName, /^cert-prep-installer-receipt-[a-f0-9]{64}\.json$/u);
    const receiptContent = await readFile(join(fixture.outputRoot, receiptName), 'utf8');
    assert.equal(receiptContent.endsWith('\n'), true);
    assert.equal(JSON.parse(receiptContent).sha256, receipt.sha256);
    assert.doesNotMatch(JSON.stringify(receipt), /https?:\/\/|token|registry|raw[_-]?ocr/iu);
    assert.equal((await readdir(join(fixture.projectionRoot))).includes('.fresh-artifact-stage'), false);
    const backend = adapters.commands.find(({ label }) => label === 'Fresh backend runtime build');
    assert.ok(backend);
    assert.ok(backend.args.includes('--capture-runtime-root'));
    assert.ok(backend.args.includes('--capture-runtime-python-wheel'));
    assert.ok(backend.args.includes('--frozen'));
    assert.ok(backend.args.includes('--offline'));
    assert.ok(backend.args.includes('--link-mode'));
    assert.deepEqual(
      backend.args.slice(backend.args.indexOf('--cache-dir'), backend.args.indexOf('--cache-dir') + 2),
      ['--cache-dir', join(fixture.root, 'cache', 'uv')],
    );
    const tauri = adapters.commands.find(({ label }) => label === 'Fresh Cert Prep NSIS build');
    assert.ok(tauri);
    assert.ok(tauri.args.includes('--locked'));
    assert.ok(tauri.args.includes('--offline'));
    assert.equal(tauri.env.CARGO_HOME, join(fixture.root, 'cache', 'cargo'));
    assert.equal(adapters.commands.some(({ args }) => args.includes('install-capture-runtime')), false);
    assert.equal(adapters.commands.some(({ args }) => args.includes('package-qa')), false);
  } finally {
    await cleanup(fixture);
  }
});

test('production exporter accepts archive types emitted by 7-Zip with lowercase names', async () => {
  const fixture = await createFixture();
  const adapters = fakeAdapters(fixture, { lowercaseArchiveType: true });
  try {
    const receipt = await createFreshProjectionArtifactExporter({
      extractor: adapters.extractor,
      runCommand: adapters.runCommand,
      readEmbeddedProvenance: async () => fixture.provenance,
    })(fixture.request);
    assert.equal(receipt.freshBuild, true);
  } finally {
    await cleanup(fixture);
  }
});

test('embedded backend provenance lookup normalizes Windows archive member separators', async () => {
  const fixture = await createFixture();
  const adapters = fakeAdapters(fixture);
  try {
    await createFreshProjectionArtifactExporter({
      extractor: adapters.extractor,
      runCommand: adapters.runCommand,
    })(fixture.request);
    const command = adapters.commands.find(({ label }) => label === 'Embedded backend provenance extraction');
    assert.ok(command);
    const scriptIndex = command.args.indexOf('-c');
    assert.ok(scriptIndex >= 0);
    assert.equal(command.args[scriptIndex + 1]?.includes('replace(chr(92), "/")'), true);
  } finally {
    await cleanup(fixture);
  }
});

test('exporter fails closed for wrong candidate bytes, failed build, unavailable extractor, multiple installers, drift, and nonempty output', async (context) => {
  await context.test('wrong candidate bytes', async () => {
    const fixture = await createFixture();
    try {
      await writeFile(join(fixture.runtimeRoot, 'runtime', RUNTIME_FILE), 'wrong');
      const adapters = fakeAdapters(fixture);
      await assert.rejects(
        createFreshProjectionArtifactExporter({ extractor: adapters.extractor, runCommand: adapters.runCommand })(fixture.request),
        /bytes do not match/iu,
      );
    } finally { await cleanup(fixture); }
  });
  await context.test('wrong J16 candidate bytes', async () => {
    const fixture = await createFixture();
    try {
      await writeFile(join(fixture.packageRoot, 'package-manifest.json'), 'wrong');
      const adapters = fakeAdapters(fixture);
      await assert.rejects(
        createFreshProjectionArtifactExporter({ extractor: adapters.extractor, runCommand: adapters.runCommand })(fixture.request),
        /bytes do not match/iu,
      );
    } finally { await cleanup(fixture); }
  });
  await context.test('build command failure', async () => {
    const fixture = await createFixture();
    try {
      const adapters = fakeAdapters(fixture);
      await assert.rejects(
        createFreshProjectionArtifactExporter({
          extractor: adapters.extractor,
          runCommand: async (command) => {
            if (command.label === 'Fresh backend runtime build') throw new Error('backend build failed');
            return adapters.runCommand(command);
          },
        })(fixture.request),
        /backend build failed/iu,
      );
    } finally { await cleanup(fixture); }
  });
  await context.test('verification failure cleans owned outputs but preserves caller files', async () => {
    const fixture = await createFixture();
    const adapters = fakeAdapters(fixture);
    try {
      await assert.rejects(
        createFreshProjectionArtifactExporter({
          extractor: adapters.extractor,
          runCommand: adapters.runCommand,
          readEmbeddedProvenance: async () => fixture.provenance,
          verifyOutputFiles: async ({ outputRoot, artifactFileName, receiptFileName }) => {
            const names = (await readdir(outputRoot)).sort();
            assert.deepEqual(names, [artifactFileName, receiptFileName].sort());
            await writeFile(join(outputRoot, 'caller-file.txt'), 'caller');
            throw new Error('verification failure after receipt write');
          },
        })(fixture.request),
        /verification failure after receipt write/iu,
      );
      assert.deepEqual(await readdir(fixture.outputRoot), ['caller-file.txt']);
      assert.equal(await readFile(join(fixture.outputRoot, 'caller-file.txt'), 'utf8'), 'caller');
    } finally { await cleanup(fixture); }
  });
  await context.test('extractor unavailable', async () => {
    const fixture = await createFixture();
    try {
      await assert.rejects(
        createFreshProjectionArtifactExporter({ extractorPath: join(fixture.root, 'missing-7z.exe') })(fixture.request),
        /extractor is unavailable/iu,
      );
    } finally { await cleanup(fixture); }
  });
  await context.test('extractor identity drift', async () => {
    const fixture = await createFixture();
    try {
      const adapters = fakeAdapters(fixture);
      await assert.rejects(
        createFreshProjectionArtifactExporter({
          extractor: { ...adapters.extractor, version: '25.00' as '25.01' },
          runCommand: adapters.runCommand,
        })(fixture.request),
        /extractor authority drifted/iu,
      );
    } finally { await cleanup(fixture); }
  });
  await context.test('extractor failure', async () => {
    const fixture = await createFixture();
    try {
      const adapters = fakeAdapters(fixture, { failExtraction: true });
      await assert.rejects(
        createFreshProjectionArtifactExporter({ extractor: adapters.extractor, runCommand: adapters.runCommand })(fixture.request),
        /static extraction failure/iu,
      );
    } finally { await cleanup(fixture); }
  });
  await context.test('multiple installers', async () => {
    const fixture = await createFixture();
    try {
      const adapters = fakeAdapters(fixture, { multipleInstallers: true });
      await assert.rejects(
        createFreshProjectionArtifactExporter({ extractor: adapters.extractor, runCommand: adapters.runCommand })(fixture.request),
        /exactly one installer/iu,
      );
    } finally { await cleanup(fixture); }
  });
  await context.test('no installer', async () => {
    const fixture = await createFixture();
    try {
      const adapters = fakeAdapters(fixture, { noInstaller: true });
      await assert.rejects(
        createFreshProjectionArtifactExporter({ extractor: adapters.extractor, runCommand: adapters.runCommand })(fixture.request),
        /exactly one installer/iu,
      );
    } finally { await cleanup(fixture); }
  });
  await context.test('extracted drift', async () => {
    const fixture = await createFixture();
    try {
      const adapters = fakeAdapters(fixture, { driftRuntime: true });
      await assert.rejects(
        createFreshProjectionArtifactExporter({ extractor: adapters.extractor, runCommand: adapters.runCommand })(fixture.request),
        /resources drifted/iu,
      );
    } finally { await cleanup(fixture); }
  });
  await context.test('nonempty output', async () => {
    const fixture = await createFixture();
    try {
      await writeFile(join(fixture.outputRoot, 'caller-file.txt'), 'caller');
      const adapters = fakeAdapters(fixture);
      await assert.rejects(
        createFreshProjectionArtifactExporter({ extractor: adapters.extractor, runCommand: adapters.runCommand })(fixture.request),
        /output root must be empty/iu,
      );
      assert.equal(await readFile(join(fixture.outputRoot, 'caller-file.txt'), 'utf8'), 'caller');
    } finally { await cleanup(fixture); }
  });
});
