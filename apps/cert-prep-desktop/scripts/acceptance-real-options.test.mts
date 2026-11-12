import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import {
  acceptanceAppDataRoot,
  removeAcceptanceAppDataDirectory,
} from './acceptance-app-data.mts';
import { createAcceptanceSmokeOptions } from './acceptance-real-options.mts';
import { buildOwnedCleanupObservation } from './packaged-flow-smoke/app-lifecycle.mts';
import {
  evaluateOcrTruth,
  normalizeOcrText,
  OcrTruthInvalidError,
  parseOcrAnchorExpectation,
  parseOcrTruthManifest,
  type OcrTruthManifest,
} from './ocr-truth-contract.mts';

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
    assert.equal(result.imageOptions!.imagePath, fixture.imagePath);
    assert.equal(result.imageOptions!.languageHint, 'en');
    assert.deepEqual(result.fixtures.image!.expectedTextIncludes, ['Snow man']);
    assert.equal(result.fixtures.pdf.truth.cerThreshold, 0.01);
    assert.equal(result.fixtures.image!.truth.cerThreshold, 0.03);
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

test('real acceptance requires explicit image and truth bindings without sibling fallback', async () => {
  const fixture = await createFixture('explicit-inputs');
  try {
    delete fixture.environment.CERT_PREP_ACCEPTANCE_IMAGE;
    await assert.rejects(
      createAcceptanceSmokeOptions({
        environment: fixture.environment,
        workspaceRoot: fixture.workspaceRoot,
      }),
      /CERT_PREP_ACCEPTANCE_IMAGE must be set explicitly/u,
    );
    fixture.environment.CERT_PREP_ACCEPTANCE_IMAGE = fixture.imagePath;
    delete fixture.environment.CERT_PREP_ACCEPTANCE_IMAGE_EXPECTATIONS;
    await assert.rejects(
      createAcceptanceSmokeOptions({
        environment: fixture.environment,
        workspaceRoot: fixture.workspaceRoot,
      }),
      /CERT_PREP_ACCEPTANCE_IMAGE_EXPECTATIONS must be set explicitly/u,
    );
  } finally {
    await cleanupFixture(fixture);
  }
});

test('OCR truth contract enforces page-level thresholds and anchors', () => {
  const manifest = parseOcrTruthManifest(
    {
      schemaVersion: 1,
      sourceFileName: 'scanned.pdf',
      kind: 'pdf',
      cerThreshold: 0.01,
      pages: [
        {
          pageNumber: 1,
          text: 'Traditional PaddleOCR anchor',
          criticalAnchors: ['Traditional', 'PaddleOCR'],
        },
      ],
    },
    'fixtures/scanned.pdf',
    'pdf',
  );
  const result = evaluateOcrTruth(manifest, [
    { pageNumber: 1, text: 'Traditional PaddleOCR anchor' },
  ]);
  assert.equal(result.status, 'passed');
  assert.equal(result.cer, 0);
  assert.deepEqual(result.criticalAnchorsMissing, []);
});

test('PDF-only acceptance does not require or allocate the JPEG journey', async () => {
  const fixture = await createFixture('pdf-only');
  try {
    fixture.environment.CERT_PREP_ACCEPTANCE_PDF_ONLY = '1';
    delete fixture.environment.CERT_PREP_ACCEPTANCE_IMAGE;
    delete fixture.environment.CERT_PREP_ACCEPTANCE_IMAGE_EXPECTATIONS;
    const result = await createAcceptanceSmokeOptions({
      environment: fixture.environment,
      workspaceRoot: fixture.workspaceRoot,
    });
    fixture.appDataDirectories = result.appDataDirectories;

    assert.equal(result.pdfOnly, true);
    assert.equal(result.imageOptions, undefined);
    assert.equal(result.fixtures.image, undefined);
    assert.equal(result.appDataDirectories.length, 1);
  } finally {
    await cleanupFixture(fixture);
  }
});

test('OCR truth normalization applies NFKC and Unicode whitespace only', () => {
  assert.equal(
    normalizeOcrText(
      '\t MiXeD\u00a0\n\u0085\u2003punctuation，。\u2028繁體\u3000简体\ufeff ',
    ),
    'MiXeD punctuation,。 繁體 简体',
  );
});

test('OCR truth CER counts Unicode code points rather than UTF-16 code units', () => {
  const reference = '1234567890123456789012345678901234567890😀';
  const manifest = parseOcrTruthManifest(
    {
      schemaVersion: 1,
      sourceFileName: 'emoji.jpeg',
      kind: 'image',
      cerThreshold: 0.03,
      pages: [{ pageNumber: 1, text: reference, criticalAnchors: ['123'] }],
    },
    'emoji.jpeg',
    'image',
  );

  const result = evaluateOcrTruth(manifest, [
    { pageNumber: 1, text: reference.replace('😀', '😃') },
  ]);

  assert.equal(result.cer, 1 / 41);
  assert.equal(result.pages[0]?.cer, 1 / 41);
});

test('OCR truth rejects an empty reference with a typed invalid error', () => {
  const manifest: OcrTruthManifest = {
    schemaVersion: 1,
    sourceFileName: 'empty.jpeg',
    kind: 'image',
    cerThreshold: 0.03,
    pages: [{ pageNumber: 1, text: '\u2003', criticalAnchors: ['anchor'] }],
  };

  assert.throws(
    () =>
      evaluateOcrTruth(manifest, [{ pageNumber: 1, text: 'arbitrary output' }]),
    (error: unknown) =>
      error instanceof OcrTruthInvalidError && error.code === 'empty_reference',
  );
  assert.throws(
    () =>
      parseOcrTruthManifest(
        {
          schemaVersion: 1,
          sourceFileName: 'empty.jpeg',
          kind: 'image',
          cerThreshold: 0.03,
          pages: [
            { pageNumber: 1, text: '\u2003', criticalAnchors: ['anchor'] },
          ],
        },
        'empty.jpeg',
        'image',
      ),
    (error: unknown) =>
      error instanceof OcrTruthInvalidError && error.code === 'empty_reference',
  );
});

test('OCR truth contract rejects high CER and missing pages', () => {
  const manifest = parseOcrTruthManifest(
    {
      schemaVersion: 1,
      sourceFileName: 'photo.jpeg',
      kind: 'image',
      cerThreshold: 0.03,
      pages: [
        { pageNumber: 1, text: 'Photo text', criticalAnchors: ['Photo'] },
      ],
    },
    'photo.jpeg',
    'image',
  );
  assert.throws(
    () => evaluateOcrTruth(manifest, [{ pageNumber: 1, text: 'Wrong' }]),
    /CER exceeded|critical anchors were missing/u,
  );
  assert.throws(
    () => evaluateOcrTruth(manifest, [{ pageNumber: 2, text: 'Photo text' }]),
    /page count\/numbers/u,
  );
});

test('Capture Runtime anchor expectations remain privacy-safe and skip invented CER', () => {
  const manifest = parseOcrAnchorExpectation(
    {
      schemaVersion: 1,
      sourceFileName: 'canonical.pdf',
      rawTextIncludes: ['N1'],
    },
    'canonical.pdf',
    'pdf',
  );
  const result = evaluateOcrTruth(manifest, [
    { pageNumber: 1, text: 'N1 plus the remaining private OCR text' },
  ]);
  assert.equal(manifest.anchorOnly, true);
  assert.equal(result.status, 'passed');
  assert.equal(result.cer, 0);
  assert.deepEqual(result.pages[0]?.criticalAnchorsMatched, ['N1']);
});

test('downloaded runtime provenance is bound to installed core and catalog worker bytes', async () => {
  const fixture = await createFixture('downloaded-runtime');
  try {
    const candidateRoot = join(fixture.root, 'downloaded-runtime');
    await mkdir(candidateRoot, { recursive: true });
    const installedResourceRoot = join(fixture.root, 'installed', 'resources');
    await writeFile(
      join(candidateRoot, 'capture-runtime-manifest.json'),
      await readFile(
        join(installedResourceRoot, 'capture-runtime-manifest.json'),
      ),
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
    fixture.environment.CERT_PREP_ACCEPTANCE_RUNTIME_PROFILE =
      'downloaded_public';

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
    assert.equal(
      existsSync(acceptanceAppDataRoot(fixture.workspaceRoot)),
      false,
    );
  } finally {
    await cleanupFixture(fixture);
  }
});

test('owned cleanup probe excludes baseline PID and listener identities', () => {
  const record = (
    pid: number,
    parentPid: number,
    name: string,
    commandLine = '',
  ) => ({
    pid,
    parentPid,
    name,
    executablePath: `C:\\scoped\\${name}`,
    commandLine,
    creationDate: `20260802010${pid}.000000+000`,
    workingSetBytes: 1,
  });
  const before = [
    record(10, 1, 'cert-prep-desktop.exe'),
    record(11, 10, 'cert-prep-backend.exe'),
    record(12, 11, 'capture-engine-ocr.exe', 'capture-engine-ocr.exe'),
    record(20, 1, 'cert-prep-backend.exe'),
  ];
  const listeners = [
    { pid: 11, address: '127.0.0.1', port: 8123 },
    { pid: 12, address: '127.0.0.1', port: 9311 },
    { pid: 20, address: '127.0.0.1', port: 9999 },
  ];
  assert.deepEqual(
    buildOwnedCleanupObservation(
      before,
      listeners,
      [before[3]],
      [listeners[2]],
      10,
    ),
    {
      ownedProcessPids: [10, 11, 12],
      remainingOwnedProcessPids: [],
      ownedListenerPorts: [8123, 9311],
      remainingOwnedListenerPorts: [],
      ocrModelWorkerPids: [12],
      remainingOcrModelWorkerPids: [],
    },
  );
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
  await writeFile(pdfPath, '%PDF-1.7\n/Type /XObject /Subtype /Image\n%%EOF\n');
  await writeFile(
    `${pdfPath}.expected.json`,
    JSON.stringify({
      schemaVersion: 1,
      sourceFileName: basename(pdfPath),
      kind: 'pdf',
      cerThreshold: 0.01,
      pages: [
        {
          pageNumber: 1,
          text: 'Scanned PDF truth',
          criticalAnchors: ['Scanned PDF'],
        },
      ],
    }),
  );
  await writeFile(imagePath, 'jpeg');
  await writeFile(
    `${imagePath}.expected.json`,
    JSON.stringify({
      schemaVersion: 1,
      sourceFileName: basename(imagePath),
      kind: 'image',
      cerThreshold: 0.03,
      pages: [
        {
          pageNumber: 1,
          text: 'Snow man',
          criticalAnchors: ['Snow man'],
        },
      ],
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
      CERT_PREP_ACCEPTANCE_PDF_EXPECTATIONS: `${pdfPath}.expected.json`,
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
