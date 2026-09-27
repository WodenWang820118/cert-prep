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
import {
  loadPhase1PythonWheelProvenance,
  createAcceptanceSmokeOptions,
  localProbeFinalizationErrors,
} from './acceptance-real-options.mts';
import { buildOwnedCleanupObservation } from './packaged-flow-smoke/app-lifecycle.mts';
import { PHASE1_FINAL_IDENTITY } from './phase1-final-identity.mts';
import {
  evaluateOcrTruth,
  normalizeOcrText,
  OcrTruthInvalidError,
  parseOcrAnchorExpectation,
  parseOcrTruthManifest,
  type OcrTruthManifest,
} from './ocr-truth-contract.mts';
import { mixedTextAndImagePdf } from './packaged-capture-workbench-smoke/negative-data-contract.mts';

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
    () => evaluateOcrTruth(manifest, [{ pageNumber: 1, text: 'arbitrary output' }]),
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
          pages: [{ pageNumber: 1, text: '\u2003', criticalAnchors: ['anchor'] }],
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

test('Phase 1 local-probe requires an explicit Python wheel provenance input', async () => {
  await assert.rejects(
    loadPhase1PythonWheelProvenance(
      {},
      {
        identity: {
          runtimeVersion: PHASE1_FINAL_IDENTITY.runtimeVersion,
          runtimeArtifactSha256: PHASE1_FINAL_IDENTITY.runtimeArtifactSha256,
          ocrWorkerArchiveSha256: PHASE1_FINAL_IDENTITY.ocrWorkerArchiveSha256,
          ocrWorkerExecutableSha256:
            PHASE1_FINAL_IDENTITY.ocrWorkerExecutableSha256,
          contractSetSha256: PHASE1_FINAL_IDENTITY.contractSetSha256,
        },
      },
    ),
    /CERT_PREP_CAPTURE_RUNTIME_PYTHON_WHEEL/u,
  );
});

test('strict local_probe accepts embedded-text PDF input before candidate checks', async () => {
  const fixture = await createFixture('strict-local-preflight');
  try { fixture.environment.CERT_PREP_ACCEPTANCE_RUNTIME_PROFILE = 'local_probe'; fixture.environment.CERT_PREP_CAPTURE_RUNTIME_ROOT = join(fixture.root, 'candidate');
    await writeFile(join(fixture.root, 'fixture.pdf'), mixedTextAndImagePdf());
    fixture.environment.CERT_PREP_ACCEPTANCE_PDF_EXPECTATIONS_SHA256 = await sha256File(join(fixture.root, 'fixture.pdf.expected.json')); fixture.environment.CERT_PREP_ACCEPTANCE_IMAGE_EXPECTATIONS_SHA256 = await sha256File(join(fixture.root, 'fixture.jpeg.expected.json'));
    await assert.rejects(createAcceptanceSmokeOptions({ environment: fixture.environment, workspaceRoot: fixture.workspaceRoot }), /CERT_PREP_ACCEPTANCE_EXPECTED_CANDIDATE_ID/u);
  } finally { await cleanupFixture(fixture); }
});

test('local_probe finalizer requires complete OCR proof and rejects tampering without starting the app', async () => {
  const fixture = await createFixture('local-finalizer'); const h = 'a'.repeat(64); const commit = 'b'.repeat(40); const pdfPath = join(fixture.root, 'fixture.pdf'); const pdf = await sha256File(pdfPath); const image = await sha256File(fixture.imagePath);
  fixture.environment.CERT_PREP_ACCEPTANCE_PDF_EXPECTATIONS_SHA256 = await sha256File(`${pdfPath}.expected.json`); fixture.environment.CERT_PREP_ACCEPTANCE_IMAGE_EXPECTATIONS_SHA256 = await sha256File(`${fixture.imagePath}.expected.json`); fixture.environment.CERT_PREP_ACCEPTANCE_EXPECTED_CANDIDATE_ID = h; fixture.environment.CERT_PREP_ACCEPTANCE_EXPECTED_SOURCE_COMMIT = commit; fixture.environment.CERT_PREP_ACCEPTANCE_EXPECTED_CANDIDATE_MANIFEST_SHA256 = h; fixture.environment.CERT_PREP_ACCEPTANCE_EXPECTED_OCR_MODEL_SHA256 = h;
  const candidate = { runtimeVersion: '0.4.2', profileId: 'capture-workbench-ocr-profile', profileSpecSha256: h, candidateId: h, candidateSourceCommit: commit, candidateManifestSha256: h, contractSetSha256: h, coreSha256: h, workerSha256: h, workerExecutableSha256: h }; const journey = (sourceHash: string, threshold: 0.01 | 0.03) => ({ status: 'completed', fixture: { sha256: sourceHash }, ocrDevice: 'windowsml-dml', truth: { status: 'passed', cer: 0, cerThreshold: threshold, cerMode: 'anchor_only', normalizationVersion: 'nfkc-whitespace-v1', referenceNormalizedSha256: 'c'.repeat(64), outputNormalizedSha256: 'd'.repeat(64), expectedAnchorCount: 1, matchedAnchorCount: 1, missingAnchorCount: 0, pages: [{ pageNumber: 1, cer: 0, referenceNormalizedSha256: 'c'.repeat(64), outputNormalizedSha256: 'd'.repeat(64), expectedAnchorCount: 1, matchedAnchorCount: 1, missingAnchorCount: 0 }] }, evidence: { runId: 'local-finalizer', sourceSha256: sourceHash, importedSourceSha256: sourceHash, runtimeArtifactSha256: h, contractSetSha256: h, workerArchiveSha256: h, workerExecutableSha256: h, ocrExecutionProof: { artifactPath: 'ocr-device-proof-v1.json', bytes: 1024, sha256: h, schemaVersion: '1', planSha256: h, identitySha256: h, adapterClass: 'dedicated', adapterDescription: 'NVIDIA RTX 4060', dmlDeviceId: 0, dmlNodeCount: 1, sessionCount: 1, executionSha256: h, sourceSha256: sourceHash, runtimeSha256: h, workerSha256: h, modelSha256: h, profileId: 'capture-workbench-ocr-profile', profileSpecSha256: h, contractSetSha256: h, requestedPageScope: [1] }, authenticatedRuntimePreflight: 'gpu-dml', uiGpuBeforeImport: true, sourceImportEnabled: true, cleanup: { app: true, sidecar: true, cdpPort: true, temporaryAppData: true }, cleanupObservation: { ownedProcessPids: [1, 2], remainingOwnedProcessPids: [], ownedListenerPorts: [], remainingOwnedListenerPorts: [], ocrModelWorkerPids: [2], remainingOcrModelWorkerPids: [] }, pageScope: { sourcePageCount: 1, requestedPageNumbers: [1], processedPageNumbers: [1], uiRawPageNumbers: [1], uiStructuredPageNumbers: [1] }, pageRecords: { expectedPageNumbers: [1], document: { pageCount: 1, processedPageCount: 1, chunksCount: 1, extractionMethod: 'windowsml_ocr' }, records: [{ pageNumber: 1 }] } } });
  try {
    const suite = { status: 'completed', runId: 'local-finalizer', runtime: { candidate }, pdf: journey(pdf, 0.01), image: journey(image, 0.03) };
    assert.deepEqual(await localProbeFinalizationErrors(suite, fixture.environment), []);
    const proof = suite.image.evidence.ocrExecutionProof as Record<string, unknown>;
    delete proof.executionSha256;
    assert.deepEqual(
      await localProbeFinalizationErrors(suite, fixture.environment),
      ['Local OCR JPEG execution proof summary was invalid.'],
    );
    proof.executionSha256 = h;
    const pdfProof = suite.pdf.evidence.ocrExecutionProof;
    Reflect.deleteProperty(suite.pdf.evidence as Record<string, unknown>, 'ocrExecutionProof');
    assert.deepEqual(
      await localProbeFinalizationErrors(suite, fixture.environment),
      ['Local OCR PDF execution proof summary was invalid.'],
    );
    suite.pdf.evidence.ocrExecutionProof = pdfProof;
    suite.pdf.evidence.pageScope.uiRawPageNumbers = [2];
    assert.deepEqual(
      await localProbeFinalizationErrors(suite, fixture.environment),
      ['Local OCR PDF page scope was not source=N, requested=[1], processed=[1].'],
    );
    suite.pdf.evidence.pageScope.uiRawPageNumbers = [1];
    suite.pdf.evidence.pageScope.uiStructuredPageNumbers = [2];
    assert.deepEqual(
      await localProbeFinalizationErrors(suite, fixture.environment),
      ['Local OCR PDF page scope was not source=N, requested=[1], processed=[1].'],
    );
    suite.pdf.evidence.pageScope.uiStructuredPageNumbers = [1];
    suite.image.evidence.pageRecords.document.pageCount = 2;
    assert.deepEqual(
      await localProbeFinalizationErrors(suite, fixture.environment),
      ['Local OCR JPEG persisted page records were invalid.'],
    );
    suite.image.evidence.pageRecords.document.pageCount = 1;
    suite.image.evidence.pageRecords.expectedPageNumbers = [2];
    assert.deepEqual(
      await localProbeFinalizationErrors(suite, fixture.environment),
      ['Local OCR JPEG persisted page records were invalid.'],
    );
    suite.image.evidence.pageRecords.expectedPageNumbers = [1];
    suite.image.evidence.pageRecords.document.processedPageCount = 2;
    assert.deepEqual(
      await localProbeFinalizationErrors(suite, fixture.environment),
      ['Local OCR JPEG persisted page records were invalid.'],
    );
    suite.image.evidence.pageRecords.document.processedPageCount = 1;
    suite.image.evidence.pageRecords.records = [{ pageNumber: 2 }];
    assert.deepEqual(
      await localProbeFinalizationErrors(suite, fixture.environment),
      ['Local OCR JPEG persisted page records were invalid.'],
    );
    suite.image.evidence.pageRecords.records = [{ pageNumber: 1 }, { pageNumber: 2 }];
    assert.deepEqual(
      await localProbeFinalizationErrors(suite, fixture.environment),
      ['Local OCR JPEG persisted page records were invalid.'],
    );
    suite.image.evidence.pageRecords.records = [{ pageNumber: 1 }];
    suite.pdf.evidence.cleanupObservation = {
      evidenceUnavailable: {
        source: 'windows_listener_snapshot',
        stage: 'before_close',
      },
    } as unknown as typeof suite.pdf.evidence.cleanupObservation;
    assert.deepEqual(
      await localProbeFinalizationErrors(suite, fixture.environment),
      ['Local OCR PDF child cleanup was not explicitly proven.'],
    );
  } finally { await cleanupFixture(fixture); }
});

test('owned cleanup probe excludes baseline PID and listener identities', () => {
  const record = (pid: number, parentPid: number, name: string, commandLine = '') => ({ pid, parentPid, name, executablePath: `C:\\scoped\\${name}`, commandLine, creationDate: `20260802010${pid}.000000+000`, workingSetBytes: 1 });
  const before = [record(10, 1, 'cert-prep-desktop.exe'), record(11, 10, 'cert-prep-backend.exe'), record(12, 11, 'capture-engine-ocr.exe', 'capture-engine-ocr.exe'), record(20, 1, 'cert-prep-backend.exe')];
  const listeners = [{ pid: 11, address: '127.0.0.1', port: 8123 }, { pid: 12, address: '127.0.0.1', port: 9311 }, { pid: 20, address: '127.0.0.1', port: 9999 }];
  assert.deepEqual(buildOwnedCleanupObservation(before, listeners, [before[3]], [listeners[2]], 10), { ownedProcessPids: [10, 11, 12], remainingOwnedProcessPids: [], ownedListenerPorts: [8123, 9311], remainingOwnedListenerPorts: [], ocrModelWorkerPids: [12], remainingOcrModelWorkerPids: [] });
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
  await writeFile(
    pdfPath,
    '%PDF-1.7\n/Type /XObject /Subtype /Image\n%%EOF\n',
  );
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
