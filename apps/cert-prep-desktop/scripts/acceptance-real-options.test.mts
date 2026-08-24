import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';

import {
  acceptanceAppDataRoot,
  removeAcceptanceAppDataDirectory,
} from './acceptance-app-data.mts';
import {
  createAcceptanceSmokeOptions,
  defaultAcceptanceImagePath,
} from './acceptance-real-options.mts';

test('real acceptance binds the installed executable and adjacent runtime identity', async () => {
  const fixture = await createFixture('explicit-image');
  try {
    const result = await createAcceptanceSmokeOptions({
      environment: fixture.environment,
      workspaceRoot: fixture.workspaceRoot,
    });
    fixture.appDataDirectories = result.appDataDirectories;

    assert.equal(result.options.exePath, fixture.exePath);
    assert.equal(result.options.llmProvider, 'fake');
    assert.equal(result.imageOptions.imagePath, fixture.imagePath);
    assert.equal(result.imageOptions.languageHint, 'en');
    assert.deepEqual(result.fixtures.image.expectedTextIncludes, ['snow man']);
    assert.equal(result.fixtures.pdf.name, 'fixture.pdf');
    assert.equal(
      result.installedArtifact.executableSha256,
      await sha256File(fixture.exePath),
    );
    assert.equal(
      result.installedArtifact.runtimeCoreSha256,
      fixture.runtimeSha256,
    );
  } finally {
    await cleanupFixture(fixture);
  }
});

test('real acceptance default image binding is hermetic while resolving the sibling path for real runs', async () => {
  const fixture = await createFixture('default-image');
  try {
    delete fixture.environment.CERT_PREP_ACCEPTANCE_IMAGE;
    delete fixture.environment.CERT_PREP_ACCEPTANCE_IMAGE_EXPECTATIONS;
    const result = await createAcceptanceSmokeOptions({
      environment: fixture.environment,
      workspaceRoot: fixture.workspaceRoot,
      defaultImagePath: fixture.imagePath,
    });
    fixture.appDataDirectories = result.appDataDirectories;

    assert.equal(result.imageOptions.imagePath, fixture.imagePath);
    assert.deepEqual(result.imageOptions.expectedTextIncludes, ['snow man']);
    assert.equal(
      defaultAcceptanceImagePath(fixture.workspaceRoot),
      resolve(
        fixture.workspaceRoot,
        '..',
        'capture-workbench',
        'test-fixtures',
        'ocr_test_image.jpeg',
      ),
    );
  } finally {
    await cleanupFixture(fixture);
  }
});

test('downloaded runtime provenance is bound to installed core and catalog worker bytes', async () => {
  const fixture = await createFixture('downloaded-runtime');
  try {
    const candidateRoot = join(fixture.root, 'downloaded-runtime');
    await mkdir(candidateRoot, { recursive: true });
    const installedResourceRoot = join(fixture.root, 'installed', 'resources');
    await writeFile(
      join(candidateRoot, 'capture-runtime-manifest.json'),
      await readFile(join(installedResourceRoot, 'capture-runtime-manifest.json')),
    );
    await writeFile(
      join(candidateRoot, 'capture-runtime-test.exe'),
      await readFile(join(installedResourceRoot, 'capture-runtime-test.exe')),
    );
    const workerName = 'capture-engine-ocr-0.4.1-windows-x64.zip';
    const worker = fakeZip(['worker/capture-engine-ocr.exe']);
    await writeFile(join(candidateRoot, workerName), worker);
    await writeFile(
      join(candidateRoot, 'capture-engine-catalog.downloaded.json'),
      JSON.stringify({
        catalogVersion: '2',
        runtimeVersion: '0.4.1',
        requirements: [
          {
            requirementId: 'windowsml-ocr',
            artifacts: [
              {
                fileName: workerName,
                bytes: worker.length,
                sha256: sha256(worker),
              },
            ],
          },
        ],
      }),
    );
    fixture.environment.CERT_PREP_CAPTURE_RUNTIME_ROOT = candidateRoot;
    fixture.environment.CERT_PREP_ACCEPTANCE_RUNTIME_PROFILE = 'downloaded_public';

    const result = await createAcceptanceSmokeOptions({
      environment: fixture.environment,
      workspaceRoot: fixture.workspaceRoot,
    });
    fixture.appDataDirectories = result.appDataDirectories;
    fixture.closeMirror = result.captureRuntimeMirror?.close;
    assert.equal(result.runtimeProvenance?.coreSha256, fixture.runtimeSha256);
    assert.equal(result.runtimeProvenance?.workerSha256, sha256(worker));
    assert.equal(
      result.runtimeProvenance?.manifestIdentitySha256,
      result.installedArtifact.runtimeManifestIdentitySha256,
    );

    await writeFile(join(candidateRoot, 'capture-runtime-test.exe'), 'drift');
    await assert.rejects(
      createAcceptanceSmokeOptions({
        environment: fixture.environment,
        workspaceRoot: fixture.workspaceRoot,
      }),
      /does not match its manifest/u,
    );
  } finally {
    await cleanupFixture(fixture);
  }
});

test('invalid provider fails before allocating acceptance app-data', async () => {
  const fixture = await createFixture('provider-preflight');
  try {
    fixture.environment.CERT_PREP_PACKAGE_SMOKE_LLM_PROVIDER = 'ollama';
    await assert.rejects(
      createAcceptanceSmokeOptions({
        environment: fixture.environment,
        workspaceRoot: fixture.workspaceRoot,
      }),
      /must be explicitly set to fake/u,
    );
    assert.equal(existsSync(acceptanceAppDataRoot(fixture.workspaceRoot)), false);
  } finally {
    await cleanupFixture(fixture);
  }
});

test('partial app-data allocation failure cleans the lease already created', async () => {
  const fixture = await createFixture('partial-allocation');
  const allocated = join(fixture.root, 'allocated-pdf-app-data');
  const removed: string[] = [];
  try {
    await assert.rejects(
      createAcceptanceSmokeOptions({
        environment: fixture.environment,
        workspaceRoot: fixture.workspaceRoot,
        createAppDataDirectory: (_workspaceRoot, _runId, purpose) => {
          if (purpose === 'pdf') return allocated;
          throw new Error('synthetic image allocation failure');
        },
        removeAppDataDirectory: (_workspaceRoot, directory) => {
          removed.push(directory);
        },
      }),
      /synthetic image allocation failure/u,
    );
    assert.deepEqual(removed, [allocated]);
  } finally {
    await cleanupFixture(fixture);
  }
});

interface Fixture {
  readonly root: string;
  readonly workspaceRoot: string;
  readonly exePath: string;
  readonly imagePath: string;
  readonly runtimeSha256: string;
  readonly environment: NodeJS.ProcessEnv;
  appDataDirectories: readonly string[];
  closeMirror?: () => Promise<void>;
}

async function createFixture(runId: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'cert-acceptance-options-'));
  const workspaceRoot = join(root, 'workspace');
  const installedRoot = join(root, 'installed');
  const resourceRoot = join(installedRoot, 'resources');
  const exePath = join(installedRoot, 'cert-prep-desktop.exe');
  const pdfPath = join(root, 'fixture.pdf');
  const imagePath = join(root, 'fixture.jpeg');
  const runtimePath = join(resourceRoot, 'capture-runtime-test.exe');
  await mkdir(resourceRoot, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(exePath, 'installed-exe');
  await writeFile(pdfPath, 'pdf');
  await writeFile(imagePath, 'jpeg');
  await writeFile(
    `${imagePath}.expected.json`,
    JSON.stringify({
      schemaVersion: 1,
      sourceFileName: basename(imagePath),
      rawTextIncludes: ['Snow man'],
    }),
  );
  await writeFile(runtimePath, 'installed-runtime');
  const runtime = await readFile(runtimePath);
  const runtimeSha256 = sha256(runtime);
  await writeFile(
    join(resourceRoot, 'capture-runtime-manifest.json'),
    JSON.stringify({
      runtimeVersion: '0.4.1',
      fileName: basename(runtimePath),
      bytes: runtime.length,
      sha256: runtimeSha256,
    }),
  );
  return {
    root,
    workspaceRoot,
    exePath,
    imagePath,
    runtimeSha256,
    environment: {
      E2E_ACCEPTANCE_RUN_ID: runId,
      E2E_RECORD_VIDEO: '0',
      CERT_PREP_ACCEPTANCE_EXE: exePath,
      CERT_PREP_ACCEPTANCE_PDF: pdfPath,
      CERT_PREP_ACCEPTANCE_IMAGE: imagePath,
      CERT_PREP_ACCEPTANCE_IMAGE_EXPECTATIONS: `${imagePath}.expected.json`,
      CERT_PREP_PACKAGE_SMOKE_LLM_PROVIDER: 'fake',
    },
    appDataDirectories: [],
  };
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await fixture.closeMirror?.();
  for (const directory of fixture.appDataDirectories) {
    removeAcceptanceAppDataDirectory(fixture.workspaceRoot, directory);
  }
  await rm(fixture.root, { recursive: true, force: true });
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}

function fakeZip(names: readonly string[]): Uint8Array {
  const entries = names.map((name) => {
    const encoded = Buffer.from(name, 'utf8');
    const entry = Buffer.alloc(46 + encoded.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(encoded.length, 28);
    encoded.copy(entry, 46);
    return entry;
  });
  const centralDirectory = Buffer.concat(entries);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(0, 16);
  return Buffer.concat([centralDirectory, end]);
}
