import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import {
  assertDownloadedWorkerPathBudget,
  createAcceptanceAppDataDirectory,
  removeAcceptanceAppDataDirectory,
} from './acceptance-app-data.mts';
import { parsePackagedFlowSmokeArgs } from './packaged-flow-smoke/args.mts';
import {
  createAcceptanceRun,
  type AcceptanceRun,
} from './acceptance-artifacts.mts';
import { assertRasterPdfFixture } from './packaged-capture-workbench-smoke/fixture-contract.mts';
import {
  loadPhase1FinalEvidence,
  PHASE1_FINAL_IDENTITY,
  type Phase1FinalEvidence,
} from './phase1-final-identity.mts';
import {
  normalizeOcrText,
  parseOcrAnchorExpectation,
  parseOcrTruthManifest,
  type OcrTruthKind,
  type OcrTruthManifest,
} from './ocr-truth-contract.mts';
import {
  CAPTURE_RUNTIME_PYTHON_WHEEL_ENV,
  inspectCaptureRuntimePythonWheel,
  type CaptureRuntimePythonWheelProvenance,
} from './capture-runtime-python-wheel.mts';
import type {
  AcceptanceRuntimeIdentityExpectation,
  SmokeOptions,
} from './packaged-flow-smoke/types.mts';
import type { PackagedImageUploadSmokeOptions } from './packaged-image-upload-smoke/args.mts';
import {
  OCR_EXECUTION_PROOF_ARTIFACT,
  type OcrExecutionProofExpectation,
} from './ocr-execution-proof.mts';
import { validateRuntimeCandidateManifest, type ValidatedRuntimeCandidateManifest } from '../../../tools/capture-candidate-gate.mts';

export interface AcceptanceFixture {
  readonly name: string;
  readonly sha256: string;
  readonly truth: OcrTruthManifest;
  readonly expectedTextIncludes?: readonly string[];
}

export interface AcceptanceRuntimeProvenance {
  readonly distributionProfile: 'local_nonpublishable' | 'public_unsigned_alpha';
  readonly source: string;
  readonly runtimeVersion: string;
  readonly coreSha256: string;
  readonly coreBytes: number;
  readonly installedManifestSha256: string;
  readonly candidateManifestSha256: string;
  readonly manifestIdentitySha256: string;
  readonly workerSha256: string;
  readonly workerBytes: number;
  readonly workerExecutableSha256?: string;
  readonly candidateId?: string; readonly candidateSourceCommit?: string; readonly contractSetSha256?: string; readonly profileId?: string; readonly profileSpecSha256?: string;
  readonly pythonWheel?: CaptureRuntimePythonWheelProvenance;
}

export interface AcceptanceInstalledArtifactProvenance {
  readonly executableName: string;
  readonly executableSha256: string;
  readonly executableBytes: number;
  readonly runtimeVersion: string;
  readonly runtimeCoreName: string;
  readonly runtimeCoreSha256: string;
  readonly runtimeCoreBytes: number;
  readonly runtimeManifestSha256: string;
  readonly runtimeManifestIdentitySha256: string;
}

interface RuntimeIdentity {
  readonly root: string;
  readonly runtimeVersion: string;
  readonly fileName: string;
  readonly coreSha256: string;
  readonly coreBytes: number;
  readonly manifestSha256: string;
  readonly manifestIdentitySha256: string;
}

interface CandidateRuntime {
  readonly root: string;
  readonly provenance: Omit<
    AcceptanceRuntimeProvenance,
    'workerSha256' | 'workerBytes'
  >;
  readonly worker: {
    readonly fileName: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly executableSha256?: string; readonly content?: Uint8Array;
  };
  readonly localObservation?: ValidatedRuntimeCandidateManifest;
}

interface CaptureRuntimeMirror {
  readonly url: string;
  readonly workerSha256: string;
  readonly workerBytes: number;
  readonly workerArchive: Uint8Array;
  readonly close: () => Promise<void>;
}

interface AcceptanceSmokeOptionsDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly workspaceRoot?: string;
  readonly createAppDataDirectory?: typeof createAcceptanceAppDataDirectory;
  readonly removeAppDataDirectory?: typeof removeAcceptanceAppDataDirectory;
}

export async function createAcceptanceSmokeOptions(
  dependencies: AcceptanceSmokeOptionsDependencies = {},
): Promise<{
  run: AcceptanceRun;
  options: SmokeOptions;
  pdfOnly: boolean;
  imageOptions?: PackagedImageUploadSmokeOptions;
  fixtures: {
    pdf: AcceptanceFixture;
    image?: AcceptanceFixture;
  };
  appDataDirectories: readonly string[];
  installedArtifact: AcceptanceInstalledArtifactProvenance;
  runtimeProvenance?: AcceptanceRuntimeProvenance;
  phase1Final?: Phase1FinalEvidence;
  captureRuntimeMirror?: CaptureRuntimeMirror;
}> {
  const environment = dependencies.environment ?? process.env;
  const createAppDataDirectory =
    dependencies.createAppDataDirectory ?? createAcceptanceAppDataDirectory;
  const removeAppDataDirectory =
    dependencies.removeAppDataDirectory ?? removeAcceptanceAppDataDirectory;
  const workspaceRoot = resolve(
    dependencies.workspaceRoot ?? resolve(import.meta.dirname, '../..', '..'),
  );
  const run = createAcceptanceRun(environment, 'cert-prep', workspaceRoot);
  const provider = (environment['CERT_PREP_PACKAGE_SMOKE_LLM_PROVIDER'] || '')
    .trim()
    .toLowerCase();
  if (provider !== 'fake') {
    throw new Error(
      'CERT_PREP_PACKAGE_SMOKE_LLM_PROVIDER must be explicitly set to fake for host structuring acceptance.',
    );
  }
  const pdfOnlyValue = environment['CERT_PREP_ACCEPTANCE_PDF_ONLY']?.trim();
  if (pdfOnlyValue !== undefined && pdfOnlyValue !== '' && pdfOnlyValue !== '1') {
    throw new Error('CERT_PREP_ACCEPTANCE_PDF_ONLY must be 1 when supplied.');
  }
  const pdfOnly = pdfOnlyValue === '1';
  const exePath = await requiredFile(
    'CERT_PREP_ACCEPTANCE_EXE',
    'packaged executable',
    environment,
  );
  const pdfPath = await requiredFile(
    'CERT_PREP_ACCEPTANCE_PDF',
    'PDF fixture',
    environment,
  );
  const pdfBytes = await readFile(pdfPath);
  const actualPdfSha256 = await sha256File(pdfPath);
  const runtimeProfile = environment['CERT_PREP_ACCEPTANCE_RUNTIME_PROFILE']?.trim();
  const phase1Final = runtimeProfile === 'local_probe' ? undefined : await loadPhase1FinalCandidate(environment);
  assertRasterPdfFixture(pdfBytes);
  const pdfTruth = await loadOcrTruthManifest(
    'CERT_PREP_ACCEPTANCE_PDF_EXPECTATIONS',
    pdfPath,
    'pdf',
    environment,
  );
  const imagePath = pdfOnly
    ? undefined
    : await requiredFile(
        'CERT_PREP_ACCEPTANCE_IMAGE',
        'JPEG/image fixture',
        environment,
      );
  const imageTruth = imagePath
    ? await loadOcrTruthManifest(
        'CERT_PREP_ACCEPTANCE_IMAGE_EXPECTATIONS',
        imagePath,
        'image',
        environment,
      )
    : undefined;
  const expectedTextIncludes = imageTruth
    ? imageTruth.pages.flatMap((page) => page.criticalAnchors).map(normalizeOcrText)
    : undefined;
  const actualImageSha256 = imagePath ? await sha256File(imagePath) : undefined;
  if (phase1Final) {
    assertCanonicalPhase1Fixtures(
      actualPdfSha256,
      actualImageSha256,
      phase1Final,
      pdfOnly,
    );
  }
  const installedRuntime = await loadInstalledRuntimeIdentity(exePath);
  const installedExe = await stat(exePath);
  const installedArtifact: AcceptanceInstalledArtifactProvenance = {
    executableName: basename(exePath),
    executableSha256: await sha256File(exePath),
    executableBytes: installedExe.size,
    runtimeVersion: installedRuntime.runtimeVersion,
    runtimeCoreName: installedRuntime.fileName,
    runtimeCoreSha256: installedRuntime.coreSha256,
    runtimeCoreBytes: installedRuntime.coreBytes,
    runtimeManifestSha256: installedRuntime.manifestSha256,
    runtimeManifestIdentitySha256: installedRuntime.manifestIdentitySha256,
  };
  const candidateRuntime = await loadRuntimeCandidate(
    environment,
    installedRuntime,
    phase1Final,
  );
  const packagedRunRoot = join(run.artifactRoot, 'packaged-run');
  const options = parsePackagedFlowSmokeArgs(
    [
      '--exe',
      exePath,
      '--pdf',
      pdfPath,
      '--out-dir',
      packagedRunRoot,
      '--llm-provider',
      provider,
    ],
    workspaceRoot,
    environment,
  );

  let captureRuntimeMirror: CaptureRuntimeMirror | undefined;
  const appDataDirectories: string[] = [];
  try {
    captureRuntimeMirror = candidateRuntime
      ? await startCaptureRuntimeMirror(candidateRuntime)
      : undefined;
    appDataDirectories.push(
      createAppDataDirectory(workspaceRoot, run.runId, 'pdf'),
    );
    if (!pdfOnly) {
      appDataDirectories.push(
        createAppDataDirectory(workspaceRoot, run.runId, 'image'),
      );
    }
    if (captureRuntimeMirror) {
      for (const appDataDirectory of appDataDirectories) {
        assertDownloadedWorkerPathBudget(
          appDataDirectory,
          candidateRuntime?.provenance.runtimeVersion ?? installedRuntime.runtimeVersion,
          captureRuntimeMirror.workerArchive,
        );
      }
    }
    const runtimeProvenance = candidateRuntime && captureRuntimeMirror
      ? {
          ...candidateRuntime.provenance,
          workerSha256: captureRuntimeMirror.workerSha256,
          workerBytes: captureRuntimeMirror.workerBytes,
          ...(candidateRuntime.worker.executableSha256
            ? { workerExecutableSha256: candidateRuntime.worker.executableSha256 }
            : {}),
        }
      : undefined;
    const acceptanceRuntimeIdentity = candidateRuntime?.localObservation
      ? strictRuntimeIdentity(candidateRuntime.localObservation, installedArtifact)
      : phase1Final
        ? phase1RuntimeIdentity(phase1Final, installedArtifact)
        : undefined;
    const pdfOcrExecutionProofExpected = acceptanceRuntimeIdentity
      ? buildOcrExecutionProofExpectation({
          environment,
          sourceSha256: actualPdfSha256,
          identity: acceptanceRuntimeIdentity,
          candidateRuntime,
        })
      : undefined;
    const imageOcrExecutionProofExpected =
      !pdfOnly && acceptanceRuntimeIdentity && actualImageSha256
        ? buildOcrExecutionProofExpectation({
            environment,
            sourceSha256: actualImageSha256,
            identity: acceptanceRuntimeIdentity,
            candidateRuntime,
          })
        : undefined;
    const pdfOutDir = join(packagedRunRoot, 'pdf-ocr-run');
    const imageOptions: PackagedImageUploadSmokeOptions | undefined =
      !pdfOnly && imagePath && imageTruth && actualImageSha256
        ? {
            workspaceRoot,
            exePath,
            outDir: join(packagedRunRoot, 'image-ocr-run'),
            appDataDir: appDataDirectories[1]!,
            cdpPort: options.cdpPort + 3,
            timeoutMs: Math.max(options.streamingCompleteTimeoutMs, 300_000),
            acceptanceIsolation: true,
            ...(captureRuntimeMirror
              ? { captureRuntimeWorkerMirrorUrl: captureRuntimeMirror.url }
              : {}),
            acceptanceArtifactRoot: run.artifactRoot,
            imagePath,
            expectedTextIncludes,
            ocrTruth: imageTruth,
            languageHint: 'en',
            llmProvider: provider,
            ...(acceptanceRuntimeIdentity ? { acceptanceRuntimeIdentity } : {}),
            ...(imageOcrExecutionProofExpected
              ? { ocrExecutionProofExpected: imageOcrExecutionProofExpected }
              : {}),
          }
        : undefined;
    return {
      run,
      pdfOnly,
      options: {
        ...options,
        outDir: pdfOutDir,
        appDataDir: appDataDirectories[0],
        acceptanceArtifactRoot: run.artifactRoot,
        acceptanceIsolation: true,
        acceptanceRecordVideo: run.recordVideo,
        acceptanceVerifyMarkdownExport: true,
        ...(pdfOnly
          ? {
              acceptancePdfPageScope: 'page-1' as const,
              acceptanceOcrOnly: true,
            }
          : {}),
        ...(acceptanceRuntimeIdentity
          ? {
              acceptanceRuntimeIdentity,
              acceptancePdfPageScope: 'page-1' as const,
              acceptanceOcrOnly: true,
              ...(pdfOcrExecutionProofExpected
                ? { ocrExecutionProofExpected: pdfOcrExecutionProofExpected }
                : {}),
            }
          : {}),
        ...(captureRuntimeMirror
          ? { captureRuntimeWorkerMirrorUrl: captureRuntimeMirror.url }
          : {}),
        ...(runtimeProvenance
          ? { candidateDistributionProfile: runtimeProvenance.distributionProfile }
          : {}),
      },
      imageOptions,
      fixtures: {
        pdf: { name: basename(pdfPath), sha256: actualPdfSha256, truth: pdfTruth },
        ...(imagePath && imageTruth && actualImageSha256
          ? {
              image: {
                name: basename(imagePath),
                sha256: actualImageSha256,
                expectedTextIncludes,
                truth: imageTruth,
              },
            }
          : {}),
      },
      appDataDirectories,
      installedArtifact,
      runtimeProvenance,
      phase1Final,
      captureRuntimeMirror,
    };
  } catch (error) {
    for (const appDataDirectory of appDataDirectories) {
      removeAppDataDirectory(workspaceRoot, appDataDirectory);
    }
    await captureRuntimeMirror?.close();
    throw error;
  }
}

/**
 * Loads the Python bridge identity required by a Phase 1 local probe. The
 * wheel path is explicit so a stale same-version artifact cannot be selected
 * implicitly from a producer output directory.
 */
export async function loadPhase1PythonWheelProvenance(
  environment: Readonly<NodeJS.ProcessEnv>,
  phase1Final: Pick<Phase1FinalEvidence, 'identity'>,
): Promise<CaptureRuntimePythonWheelProvenance> {
  const wheelPath = environment[CAPTURE_RUNTIME_PYTHON_WHEEL_ENV]?.trim();
  if (!wheelPath) {
    throw new Error(
      `Phase 1 local-probe acceptance requires ${CAPTURE_RUNTIME_PYTHON_WHEEL_ENV}.`,
    );
  }
  return inspectCaptureRuntimePythonWheel(wheelPath, {
    runtimeVersion: phase1Final.identity.runtimeVersion,
    contractSetSha256: phase1Final.identity.contractSetSha256,
  });
}

async function loadInstalledRuntimeIdentity(
  exePath: string,
): Promise<RuntimeIdentity> {
  const resourceRoot = join(dirname(exePath), 'resources');
  return loadRuntimeIdentity(resourceRoot, 'installed Capture Runtime');
}

async function loadPhase1FinalCandidate(
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<Phase1FinalEvidence | undefined> {
  const manifestPath = environment['CERT_PREP_CAPTURE_RUNTIME_PHASE1_MANIFEST']?.trim();
  const profile = environment['CERT_PREP_ACCEPTANCE_RUNTIME_PROFILE']?.trim();
  const probeRequested =
    profile === 'local_probe' ||
    Boolean(manifestPath) ||
    (environment['CERT_PREP_CAPTURE_RUNTIME_PROBE']?.trim() === '1' &&
      environment['CERT_PREP_CAPTURE_RUNTIME_EXPECTED_VERSION']?.trim() === '0.4.2');
  if (!probeRequested) return undefined;
  if (!manifestPath) {
    throw new Error(
      'Local-probe acceptance requires CERT_PREP_CAPTURE_RUNTIME_PHASE1_MANIFEST.',
    );
  }
  const producerRoot = environment['CERT_PREP_CAPTURE_WORKBENCH_ROOT']?.trim();
  return loadPhase1FinalEvidence(manifestPath, {
    ...(producerRoot ? { producerRoot } : {}),
  });
}

function assertCanonicalPhase1Fixtures(
  pdfSha256: string,
  imageSha256: string | undefined,
  phase1Final: Phase1FinalEvidence,
  pdfOnly = false,
): void {
  if (pdfSha256 !== phase1Final.pdfPage1.sourceSha256 || pdfSha256 !== PHASE1_FINAL_IDENTITY.pdfSha256) {
    throw new Error('CERT_PREP_ACCEPTANCE_PDF is not the canonical Phase 1 private PDF fixture.');
  }
  if (!pdfOnly && (imageSha256 !== phase1Final.jpeg.sourceSha256 || imageSha256 !== PHASE1_FINAL_IDENTITY.jpegSha256)) {
    throw new Error('CERT_PREP_ACCEPTANCE_IMAGE is not the canonical Phase 1 private JPEG fixture.');
  }
}

function phase1RuntimeIdentity(
  phase1Final: Phase1FinalEvidence,
  installedArtifact: AcceptanceInstalledArtifactProvenance,
): AcceptanceRuntimeIdentityExpectation {
  return {
    runtimeArtifactSha256: phase1Final.identity.runtimeArtifactSha256,
    contractSetSha256: phase1Final.identity.contractSetSha256,
    workerArchiveSha256: phase1Final.identity.ocrWorkerArchiveSha256,
    workerExecutableSha256: phase1Final.identity.ocrWorkerExecutableSha256,
    preflightMode: 'gpu-dml',
    installedExecutableSha256: installedArtifact.executableSha256,
    installedRuntimeManifestIdentitySha256:
      installedArtifact.runtimeManifestIdentitySha256,
    installedRuntimeCoreSha256: installedArtifact.runtimeCoreSha256,
    installedRuntimeCoreBytes: installedArtifact.runtimeCoreBytes,
  };
}

const OCR_EXECUTION_PROOF_SUMMARY_KEYS = [
  'adapterClass',
  'adapterDescription',
  'artifactPath',
  'bytes',
  'contractSetSha256',
  'dmlDeviceId',
  'dmlNodeCount',
  'executionSha256',
  'identitySha256',
  'modelSha256',
  'planSha256',
  'profileId',
  'profileSpecSha256',
  'requestedPageScope',
  'runtimeSha256',
  'schemaVersion',
  'sessionCount',
  'sha256',
  'sourceSha256',
  'workerSha256',
] as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function isCompletePersistedOcrExecutionProof(
  proof: unknown,
  sourceHash: string | undefined,
  evidence: Record<string, unknown> | undefined,
  candidate: Record<string, unknown> | undefined,
  environment: Readonly<NodeJS.ProcessEnv>,
): boolean {
  if (!isRecord(proof)) return false;
  const actualKeys = Object.keys(proof).sort();
  const expectedKeys = [...OCR_EXECUTION_PROOF_SUMMARY_KEYS].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    return false;
  }
  const digestFields = [
    'sha256',
    'planSha256',
    'identitySha256',
    'executionSha256',
    'sourceSha256',
    'runtimeSha256',
    'workerSha256',
    'modelSha256',
    'profileSpecSha256',
    'contractSetSha256',
  ] as const;
  if (
    digestFields.some(
      (field) =>
        typeof proof[field] !== 'string' || !SHA256_PATTERN.test(proof[field]),
    )
  ) {
    return false;
  }
  const positiveInteger = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  const nonNegativeInteger = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const pageScopeValid =
    proof.requestedPageScope === null ||
    (Array.isArray(proof.requestedPageScope) &&
      proof.requestedPageScope.length > 0 &&
      proof.requestedPageScope.length <= 500 &&
      proof.requestedPageScope.every(
        (page, index) =>
          typeof page === 'number' &&
          Number.isSafeInteger(page) &&
          page === index + 1,
      ));
  const expectedModelSha = [
    environment['CERT_PREP_ACCEPTANCE_EXPECTED_OCR_MODEL_SHA256'],
    environment['CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_SHA256'],
  ]
    .map((value) => value?.trim())
    .find(Boolean);
  const expectedProfileSha = candidate
    ? candidate.profileSpecSha256
    : environment['CERT_PREP_ACCEPTANCE_EXPECTED_OCR_PROFILE_SHA256']?.trim();
  const expectedProfileId = candidate?.profileId ??
    environment['CERT_PREP_ACCEPTANCE_EXPECTED_OCR_PROFILE_ID']?.trim();
  const expectedAdapter =
    environment['CERT_PREP_ACCEPTANCE_EXPECTED_OCR_ADAPTER']?.trim() ||
    'RTX 4060';
  const evidenceRuntimeSha = evidence?.runtimeArtifactSha256;
  const evidenceWorkerSha = evidence?.workerExecutableSha256;
  const evidenceContractSha = evidence?.contractSetSha256;
  return (
    proof.artifactPath === OCR_EXECUTION_PROOF_ARTIFACT &&
    proof.schemaVersion === '1' &&
    positiveInteger(proof.bytes) &&
    proof.bytes <= 1024 * 1024 &&
    proof.sourceSha256 === sourceHash &&
    typeof evidenceRuntimeSha === 'string' &&
    proof.runtimeSha256 === evidenceRuntimeSha &&
    typeof evidenceWorkerSha === 'string' &&
    proof.workerSha256 === evidenceWorkerSha &&
    typeof evidenceContractSha === 'string' &&
    proof.contractSetSha256 === evidenceContractSha &&
    typeof expectedModelSha === 'string' &&
    SHA256_PATTERN.test(expectedModelSha) &&
    proof.modelSha256 === expectedModelSha &&
    typeof expectedProfileSha === 'string' &&
    SHA256_PATTERN.test(expectedProfileSha) &&
    proof.profileSpecSha256 === expectedProfileSha &&
    typeof expectedProfileId === 'string' &&
    /^[A-Za-z0-9._:-]{1,128}$/u.test(expectedProfileId) &&
    proof.profileId === expectedProfileId &&
    proof.adapterClass === 'dedicated' &&
    typeof proof.adapterDescription === 'string' &&
    /^[A-Za-z0-9 ._:-]{1,128}$/u.test(proof.adapterDescription) &&
    proof.adapterDescription.includes(expectedAdapter) &&
    nonNegativeInteger(proof.dmlDeviceId) &&
    positiveInteger(proof.dmlNodeCount) &&
    positiveInteger(proof.sessionCount) &&
    pageScopeValid
  );
}

export async function localProbeFinalizationErrors(
  sourceSuite: unknown,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<string[]> {
  const errors: string[] = [];
  const suite = isRecord(sourceSuite) ? sourceSuite : undefined;
  const pdfOnly = environment['CERT_PREP_ACCEPTANCE_PDF_ONLY']?.trim() === '1';
  if (suite?.status !== 'completed') errors.push('Local OCR source suite did not complete.');
  const runtime = suite && isRecord(suite.runtime) ? suite.runtime : undefined;
  const candidate = runtime && isRecord(runtime.candidate) ? runtime.candidate : undefined;
  const candidateFields: readonly [string, RegExp][] = [
    ['candidateId', /^[0-9a-f]{64}$/u],
    ['candidateSourceCommit', /^[0-9a-f]{40}$/u],
    ['candidateManifestSha256', /^[0-9a-f]{64}$/u],
    ['contractSetSha256', /^[0-9a-f]{64}$/u],
    ['coreSha256', /^[0-9a-f]{64}$/u],
    ['workerSha256', /^[0-9a-f]{64}$/u],
    ['workerExecutableSha256', /^[0-9a-f]{64}$/u],
    ['profileSpecSha256', /^[0-9a-f]{64}$/u],
  ];
  if (!candidate || candidate.runtimeVersion !== '0.4.2' || typeof candidate.profileId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(candidate.profileId)) errors.push('Local OCR candidate identity was missing.');
  for (const [field, pattern] of candidateFields) if (!candidate || typeof candidate[field] !== 'string' || !pattern.test(candidate[field])) errors.push(`Local OCR candidate ${field} was invalid.`);
  for (const [field, envName] of [['candidateId', 'CERT_PREP_ACCEPTANCE_EXPECTED_CANDIDATE_ID'], ['candidateSourceCommit', 'CERT_PREP_ACCEPTANCE_EXPECTED_SOURCE_COMMIT'], ['candidateManifestSha256', 'CERT_PREP_ACCEPTANCE_EXPECTED_CANDIDATE_MANIFEST_SHA256']] as const) if (environment[envName]?.trim() && candidate?.[field] !== environment[envName]?.trim()) errors.push(`Local OCR candidate ${field} did not match the expected identity.`);
  const runId = typeof suite?.runId === 'string' && suite.runId.trim() ? suite.runId : undefined;
  const truthInputs = [
    ['PDF', 'CERT_PREP_ACCEPTANCE_PDF_EXPECTATIONS', 'CERT_PREP_ACCEPTANCE_PDF_EXPECTATIONS_SHA256'] as const,
    ...(!pdfOnly
      ? ([['JPEG', 'CERT_PREP_ACCEPTANCE_IMAGE_EXPECTATIONS', 'CERT_PREP_ACCEPTANCE_IMAGE_EXPECTATIONS_SHA256']] as const)
      : []),
  ];
  for (const [label, pathName, hashName] of truthInputs) {
    const path = environment[pathName]?.trim(), expected = environment[hashName]?.trim();
    if (!path || !expected || !/^[0-9a-f]{64}$/u.test(expected)) errors.push(`Local OCR ${label} truth SHA was missing or invalid.`);
    else { const contents = await readFile(path).catch(() => undefined); if (!contents || createHash('sha256').update(contents).digest('hex') !== expected) errors.push(`Local OCR ${label} truth SHA did not match the manifest.`); }
  }
  const checkJourney = (value: unknown, label: 'PDF' | 'JPEG', sourceHash: string | undefined): void => {
    const journey = isRecord(value) ? value : undefined, truth = journey && isRecord(journey.truth) ? journey.truth : undefined, evidence = journey && isRecord(journey.evidence) ? journey.evidence : undefined;
    const cer = truth?.cer, threshold = truth?.cerThreshold, pages = Array.isArray(truth?.pages) ? truth.pages : [];
    const hashFieldsValid = ['referenceNormalizedSha256', 'outputNormalizedSha256']
      .every((field) => typeof truth?.[field] === 'string' && /^[0-9a-f]{64}$/u.test(truth[field] as string));
    const semanticPagesValid = pages.length > 0 && pages.every((page) => {
      if (!isRecord(page)) return false;
      const expected = page.expectedAnchorCount, matched = page.matchedAnchorCount, missing = page.missingAnchorCount;
      return typeof page.pageNumber === 'number' && Number.isSafeInteger(page.pageNumber) && page.pageNumber > 0 &&
        typeof page.cer === 'number' && Number.isFinite(page.cer) && page.cer >= 0 && page.cer <= (typeof threshold === 'number' ? threshold : -1) &&
        typeof expected === 'number' && Number.isSafeInteger(expected) && expected > 0 &&
        typeof matched === 'number' && Number.isSafeInteger(matched) && matched === expected &&
        typeof missing === 'number' && missing === 0 &&
        typeof page.referenceNormalizedSha256 === 'string' && /^[0-9a-f]{64}$/u.test(page.referenceNormalizedSha256) &&
        typeof page.outputNormalizedSha256 === 'string' && /^[0-9a-f]{64}$/u.test(page.outputNormalizedSha256);
    });
    if (journey?.status !== 'completed' || truth?.status !== 'passed' || typeof sourceHash !== 'string' || !/^[0-9a-f]{64}$/u.test(sourceHash) || evidence?.sourceSha256 !== sourceHash || evidence?.importedSourceSha256 !== sourceHash || typeof cer !== 'number' || !Number.isFinite(cer) || typeof threshold !== 'number' || !Number.isFinite(threshold) || cer < 0 || cer > threshold || (truth?.cerMode !== 'anchor_only' && truth?.cerMode !== 'full_reference') || truth?.normalizationVersion !== 'nfkc-whitespace-v1' || !hashFieldsValid || typeof truth?.expectedAnchorCount !== 'number' || typeof truth?.matchedAnchorCount !== 'number' || typeof truth?.missingAnchorCount !== 'number' || truth.expectedAnchorCount < 1 || truth.matchedAnchorCount !== truth.expectedAnchorCount || truth.missingAnchorCount !== 0 || !semanticPagesValid) errors.push(`Local OCR ${label} truth evidence was invalid.`);
    for (const [field, evidenceField] of [['coreSha256', 'runtimeArtifactSha256'], ['contractSetSha256', 'contractSetSha256'], ['workerSha256', 'workerArchiveSha256'], ['workerExecutableSha256', 'workerExecutableSha256']] as const) if (candidate?.[field] !== evidence?.[evidenceField]) errors.push(`Local OCR ${label} evidence was not bound to the candidate.`);
    const cleanup = evidence && isRecord(evidence.cleanup) ? evidence.cleanup : undefined;
    const observation = evidence && isRecord(evidence.cleanupObservation) ? evidence.cleanupObservation : undefined;
    const ownedPids = Array.isArray(observation?.ownedProcessPids) ? observation.ownedProcessPids : [];
    const remainingPids = Array.isArray(observation?.remainingOwnedProcessPids) ? observation.remainingOwnedProcessPids : [];
    const remainingPorts = Array.isArray(observation?.remainingOwnedListenerPorts) ? observation.remainingOwnedListenerPorts : [];
    const remainingWorkers = Array.isArray(observation?.remainingOcrModelWorkerPids) ? observation.remainingOcrModelWorkerPids : [];
    const observedArrays = ['ownedProcessPids', 'remainingOwnedProcessPids', 'ownedListenerPorts', 'remainingOwnedListenerPorts', 'ocrModelWorkerPids', 'remainingOcrModelWorkerPids']
      .map((field) => observation?.[field])
      .every((value) => Array.isArray(value) && value.every((pid) => typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0));
    if (!cleanup || ['app', 'sidecar', 'cdpPort', 'temporaryAppData'].some((field) => cleanup[field] !== true) || !observedArrays || ownedPids.length === 0 || remainingPids.length !== 0 || remainingPorts.length !== 0 || remainingWorkers.length !== 0) errors.push(`Local OCR ${label} child cleanup was not explicitly proven.`);
    if (evidence?.authenticatedRuntimePreflight !== 'gpu-dml' || evidence.uiGpuBeforeImport !== true || evidence.sourceImportEnabled !== true || (journey?.ocrDevice ?? evidence.ocrDevice) !== 'windowsml-dml') errors.push(`Local OCR ${label} did not prove persisted windowsml-dml execution.`);
    if (label === 'JPEG' || label === 'PDF') {
      const proof = evidence && isRecord(evidence.ocrExecutionProof) ? evidence.ocrExecutionProof : undefined;
      if (!isCompletePersistedOcrExecutionProof(proof, sourceHash, evidence, candidate, environment)) errors.push(`Local OCR ${label} execution proof summary was invalid.`);
    }
    const scope = evidence && isRecord(evidence.pageScope) ? evidence.pageScope : undefined;
    if (label === 'PDF' && (!scope || typeof scope.sourcePageCount !== 'number' || !Number.isSafeInteger(scope.sourcePageCount) || scope.sourcePageCount < 1 || JSON.stringify(scope.requestedPageNumbers) !== '[1]' || JSON.stringify(scope.processedPageNumbers) !== '[1]' || JSON.stringify(scope.uiRawPageNumbers) !== '[1]' || JSON.stringify(scope.uiStructuredPageNumbers) !== '[1]')) errors.push(`Local OCR ${label} page scope was not source=N, requested=[1], processed=[1].`);
    const records = evidence && isRecord(evidence.pageRecords) ? evidence.pageRecords : undefined;
    const document = records && isRecord(records.document) ? records.document : undefined;
    const persistedRecords = records && Array.isArray(records.records) ? records.records : undefined;
    const persistedPageNumbers = persistedRecords?.map((record) => isRecord(record) ? record.pageNumber : undefined);
    const persistedPageScopeValid =
      !!document &&
      (label === 'PDF'
        ? !!scope &&
          typeof document.pageCount === 'number' &&
          Number.isSafeInteger(document.pageCount) &&
          document.pageCount >= 1 &&
          document.pageCount === scope.sourcePageCount
        : document.pageCount === 1) &&
      document.processedPageCount === 1 &&
      document.chunksCount === 1 &&
      JSON.stringify(records?.expectedPageNumbers) === '[1]' &&
      persistedPageNumbers?.length === 1 &&
      persistedPageNumbers[0] === 1;
    if (!records || !document || document.extractionMethod !== 'windowsml_ocr' || !persistedPageScopeValid) errors.push(`Local OCR ${label} persisted page records were invalid.`);
    if (runId && evidence?.runId !== runId) errors.push(`Local OCR ${label} evidence run identity did not match.`);
  };
  checkJourney(suite?.pdf, 'PDF', isRecord(suite?.pdf) && isRecord(suite.pdf.fixture) && typeof suite.pdf.fixture.sha256 === 'string' ? suite.pdf.fixture.sha256 : undefined);
  if (!pdfOnly) {
    checkJourney(suite?.image, 'JPEG', isRecord(suite?.image) && isRecord(suite.image.fixture) && typeof suite.image.fixture.sha256 === 'string' ? suite.image.fixture.sha256 : undefined);
  }
  return errors;
}

function strictRuntimeIdentity(observation: ValidatedRuntimeCandidateManifest, installedArtifact: AcceptanceInstalledArtifactProvenance): AcceptanceRuntimeIdentityExpectation {
  return {
    runtimeArtifactSha256: observation.runtime.sha256,
    contractSetSha256: observation.contractSetSha256,
    workerArchiveSha256: observation.ocrArchive.sha256,
    workerExecutableSha256: observation.ocrExecutable.sha256,
    preflightMode: 'gpu-dml',
    installedExecutableSha256: installedArtifact.executableSha256,
    installedRuntimeManifestIdentitySha256: installedArtifact.runtimeManifestIdentitySha256,
    installedRuntimeCoreSha256: installedArtifact.runtimeCoreSha256,
    installedRuntimeCoreBytes: installedArtifact.runtimeCoreBytes,
  };
}

function requiredLocalIdentity(environment: Readonly<NodeJS.ProcessEnv>, names: readonly string[]): string {
  const value = names.map((name) => environment[name]?.trim()).find(Boolean);
  if (!value) throw new Error(`local_probe acceptance requires ${names[0]}.`);
  return value;
}

function buildOcrExecutionProofExpectation(input: {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly sourceSha256: string;
  readonly identity: AcceptanceRuntimeIdentityExpectation;
  readonly candidateRuntime?: CandidateRuntime;
}): OcrExecutionProofExpectation {
  const modelSha256 = requiredProofSha(input.environment, [
    'CERT_PREP_ACCEPTANCE_EXPECTED_OCR_MODEL_SHA256',
    'CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_SHA256',
  ]);
  const profileSha256 = input.candidateRuntime?.localObservation?.profile.sha256 ??
    requiredProofSha(input.environment, ['CERT_PREP_ACCEPTANCE_EXPECTED_OCR_PROFILE_SHA256']);
  const profileId = input.candidateRuntime?.localObservation?.profile.id ??
    requiredLocalIdentity(input.environment, ['CERT_PREP_ACCEPTANCE_EXPECTED_OCR_PROFILE_ID']);
  const adapterDescription = input.environment['CERT_PREP_ACCEPTANCE_EXPECTED_OCR_ADAPTER']?.trim() || 'RTX 4060';
  return {
    sourceSha256: input.sourceSha256,
    runtimeSha256: input.identity.runtimeArtifactSha256,
    workerExecutableSha256: input.identity.workerExecutableSha256,
    modelSha256,
    profileId,
    profileSpecSha256: profileSha256,
    contractSetSha256: input.identity.contractSetSha256,
    expectedAdapterClass: 'dedicated',
    expectedAdapterDescriptionIncludes: adapterDescription,
  };
}

function requiredProofSha(
  environment: Readonly<NodeJS.ProcessEnv>,
  names: readonly string[],
): string {
  const value = names.map((name) => environment[name]?.trim()).find(Boolean);
  if (!value || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`GPU OCR execution proof requires ${names[0]} as a lowercase SHA-256 digest.`);
  }
  return value;
}

async function loadStrictLocalRuntimeCandidate(
  environment: Readonly<NodeJS.ProcessEnv>,
  installedRuntime: RuntimeIdentity,
): Promise<CandidateRuntime> {
  const candidateRoot = requiredLocalIdentity(environment, ['CERT_PREP_CAPTURE_RUNTIME_ROOT']);
  const candidateId = requiredLocalIdentity(environment, ['CERT_PREP_ACCEPTANCE_EXPECTED_CANDIDATE_ID', 'CERT_PREP_CAPTURE_RUNTIME_EXPECTED_CANDIDATE_ID', 'CERT_PREP_CAPTURE_RUNTIME_CANDIDATE_ID']);
  const sourceCommit = requiredLocalIdentity(environment, ['CERT_PREP_ACCEPTANCE_EXPECTED_SOURCE_COMMIT', 'CERT_PREP_CAPTURE_RUNTIME_EXPECTED_SOURCE_COMMIT', 'CERT_PREP_CAPTURE_RUNTIME_SOURCE_COMMIT']);
  const candidateManifestSha256 = requiredLocalIdentity(environment, ['CERT_PREP_ACCEPTANCE_EXPECTED_CANDIDATE_MANIFEST_SHA256', 'CERT_PREP_CAPTURE_RUNTIME_EXPECTED_CANDIDATE_MANIFEST_SHA256', 'CERT_PREP_CAPTURE_RUNTIME_CANDIDATE_MANIFEST_SHA256']);
  const wheelPath = requiredLocalIdentity(environment, [CAPTURE_RUNTIME_PYTHON_WHEEL_ENV]);
  const observation = await validateRuntimeCandidateManifest({
    candidate: candidateRoot,
    candidateId,
    sourceCommit,
    candidateManifestSha256,
  });
  if (installedRuntime.runtimeVersion !== observation.runtimeVersion || installedRuntime.fileName !== basename(observation.runtime.path) || installedRuntime.coreSha256 !== observation.runtime.sha256 || installedRuntime.coreBytes !== observation.runtime.bytes) {
    throw new Error('The installed application Capture Runtime does not exactly match the strict local runtime candidate.');
  }
  const pythonWheel = await inspectCaptureRuntimePythonWheel(wheelPath, {
    runtimeVersion: observation.runtimeVersion,
    contractSetSha256: observation.contractSetSha256,
  });
  return {
    root: join(resolve(candidateRoot), 'runtime'),
    provenance: {
      distributionProfile: 'local_nonpublishable',
      source: `Capture Runtime strict local candidate ${observation.candidateId}`,
      runtimeVersion: observation.runtimeVersion,
      coreSha256: observation.runtime.sha256,
      coreBytes: observation.runtime.bytes,
      installedManifestSha256: installedRuntime.manifestSha256,
      candidateManifestSha256: observation.candidateManifestSha256,
      manifestIdentitySha256: installedRuntime.manifestIdentitySha256,
      candidateId: observation.candidateId,
      candidateSourceCommit: observation.sourceCommit,
      contractSetSha256: observation.contractSetSha256,
      profileId: observation.profile.id,
      profileSpecSha256: observation.profile.sha256,
      pythonWheel,
    },
    worker: {
      fileName: basename(observation.ocrArchive.path),
      sha256: observation.ocrArchive.sha256,
      bytes: observation.ocrArchive.bytes,
      executableSha256: observation.ocrExecutable.sha256, content: observation.ocrArchive.content,
    },
    localObservation: observation,
  };
}

async function loadRuntimeCandidate(
  environment: Readonly<NodeJS.ProcessEnv>,
  installedRuntime: RuntimeIdentity,
  phase1Final?: Phase1FinalEvidence,
): Promise<CandidateRuntime | undefined> {
  const runtimeProfile = environment['CERT_PREP_ACCEPTANCE_RUNTIME_PROFILE']?.trim();
  if (
    runtimeProfile &&
    runtimeProfile !== 'downloaded_public' &&
    runtimeProfile !== 'local_probe'
  ) {
    throw new Error(
      'CERT_PREP_ACCEPTANCE_RUNTIME_PROFILE must be downloaded_public or local_probe when supplied.',
    );
  }
  if (runtimeProfile === 'local_probe') {
    return loadStrictLocalRuntimeCandidate(environment, installedRuntime);
  }
  const localProbe = runtimeProfile === 'local_probe' || phase1Final !== undefined;
  const rootValue = environment['CERT_PREP_CAPTURE_RUNTIME_ROOT']?.trim();
  if (!rootValue) {
    if (localProbe) {
      throw new Error(
        'Local-probe acceptance requires CERT_PREP_CAPTURE_RUNTIME_ROOT.',
      );
    }
    return undefined;
  }

  const root = resolve(rootValue);
  const candidate = await loadRuntimeIdentity(root, 'Capture Runtime candidate');
  if (
    candidate.runtimeVersion !== installedRuntime.runtimeVersion ||
    candidate.fileName !== installedRuntime.fileName ||
    candidate.coreSha256 !== installedRuntime.coreSha256 ||
    candidate.coreBytes !== installedRuntime.coreBytes ||
    candidate.manifestIdentitySha256 !== installedRuntime.manifestIdentitySha256
  ) {
    throw new Error(
      'The installed application Capture Runtime does not exactly match CERT_PREP_CAPTURE_RUNTIME_ROOT.',
    );
  }
  if (runtimeProfile === 'downloaded_public' && phase1Final) {
    throw new Error(
      'downloaded_public acceptance cannot consume a local-probe Phase 1 aggregate.',
    );
  }
  if (localProbe && !phase1Final) {
    throw new Error(
      'local_probe acceptance requires CERT_PREP_CAPTURE_RUNTIME_PHASE1_MANIFEST.',
    );
  }
  const downloadedPublic = runtimeProfile === 'downloaded_public';
  const worker = await loadCatalogWorker(root, candidate.runtimeVersion, localProbe);
  if (phase1Final) {
    if (candidate.coreSha256 !== phase1Final.identity.runtimeArtifactSha256) {
      throw new Error(
        'Capture Runtime candidate core does not match the Phase 1 final aggregate.',
      );
    }
    if (worker.sha256 !== phase1Final.identity.ocrWorkerArchiveSha256) {
      throw new Error(
        'Capture Runtime candidate worker archive does not match the Phase 1 final aggregate.',
      );
    }
    if (worker.executableSha256 !== phase1Final.identity.ocrWorkerExecutableSha256) {
      throw new Error(
        'Capture Runtime candidate worker executable does not match the Phase 1 final aggregate.',
      );
    }
  }
  const pythonWheel = phase1Final
    ? await loadPhase1PythonWheelProvenance(environment, phase1Final)
    : undefined;
  return {
    root,
    provenance: {
      distributionProfile: downloadedPublic
        ? 'public_unsigned_alpha'
        : 'local_nonpublishable',
      source: downloadedPublic
        ? `downloaded Capture Runtime ${candidate.runtimeVersion} release package (installed core match and catalog-bound worker)`
        : localProbe
          ? 'Capture Runtime Phase 1 local-probe candidate with exact aggregate-bound core and worker'
          : 'Capture Runtime candidate with exact installed core match and catalog-bound worker',
      runtimeVersion: candidate.runtimeVersion,
      coreSha256: candidate.coreSha256,
      coreBytes: candidate.coreBytes,
      installedManifestSha256: installedRuntime.manifestSha256,
      candidateManifestSha256: candidate.manifestSha256,
      manifestIdentitySha256: candidate.manifestIdentitySha256,
      ...(pythonWheel ? { pythonWheel } : {}),
    },
    worker,
  };
}

async function loadRuntimeIdentity(
  root: string,
  label: string,
): Promise<RuntimeIdentity> {
  const manifestPath = join(root, 'capture-runtime-manifest.json');
  const manifestBytes = await readFile(manifestPath).catch(() => {
    throw new Error(
      `${label} must contain capture-runtime-manifest.json: ${manifestPath}.`,
    );
  });
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} manifest is not valid JSON: ${manifestPath}.`, {
      cause: error,
    });
  }
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest)
  ) {
    throw new Error(`${label} manifest must be a JSON object.`);
  }
  const record = manifest as Record<string, unknown>;
  const runtimeVersion = record.runtimeVersion;
  const fileName = record.fileName;
  const expectedSha256 = record.sha256;
  const expectedBytes = record.bytes;
  if (
    typeof runtimeVersion !== 'string' ||
    typeof fileName !== 'string' ||
    !/^[A-Za-z0-9._-]+$/u.test(fileName) ||
    typeof expectedSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/iu.test(expectedSha256) ||
    typeof expectedBytes !== 'number' ||
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes <= 0
  ) {
    throw new Error(`${label} manifest has invalid provenance fields.`);
  }
  const corePath = join(root, fileName);
  const core = await readFile(corePath).catch(() => {
    throw new Error(`${label} core is not readable: ${corePath}.`);
  });
  const coreSha256 = createHash('sha256').update(core).digest('hex');
  if (core.length !== expectedBytes || coreSha256 !== expectedSha256.toLowerCase()) {
    throw new Error(
      `${label} core does not match its manifest: ${corePath}.`,
    );
  }
  return {
    root,
    runtimeVersion,
    fileName,
    coreSha256,
    coreBytes: core.length,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    manifestIdentitySha256: createHash('sha256')
      .update(canonicalJson(record))
      .digest('hex'),
  };
}

async function loadCatalogWorker(
  root: string,
  runtimeVersion: string,
  localProbe = false,
): Promise<CandidateRuntime['worker']> {
  const catalogPath = join(
    root,
    localProbe
      ? 'capture-engine-catalog.json'
      : 'capture-engine-catalog.downloaded.json',
  );
  const contents = await readFile(catalogPath, 'utf8').catch(() => {
    throw new Error(
      `Capture Runtime candidate must contain the ${localProbe ? 'local-probe' : 'downloaded'} engine catalog: ${catalogPath}.`,
    );
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Capture Runtime engine catalog is not valid JSON: ${catalogPath}.`, {
      cause: error,
    });
  }
  if (!isRecord(parsed) || parsed.runtimeVersion !== runtimeVersion) {
    throw new Error('Capture Runtime engine catalog runtimeVersion is invalid.');
  }
  const requirements = Array.isArray(parsed.requirements) ? parsed.requirements : [];
  const ocrRequirement = requirements.find(
    (value) => isRecord(value) && value.requirementId === 'windowsml-ocr',
  );
  const artifacts = isRecord(ocrRequirement) && Array.isArray(ocrRequirement.artifacts)
    ? ocrRequirement.artifacts
    : [];
  const artifact = artifacts.length === 1 && isRecord(artifacts[0])
    ? artifacts[0]
    : undefined;
  const expectedName = `capture-engine-ocr-${runtimeVersion}-windows-x64.zip`;
  if (
    !artifact ||
    artifact.fileName !== expectedName ||
    typeof artifact.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/iu.test(artifact.sha256) ||
    typeof artifact.bytes !== 'number' ||
    !Number.isSafeInteger(artifact.bytes) ||
    artifact.bytes <= 0
  ) {
    throw new Error('Capture Runtime engine catalog has no valid WindowsML OCR worker.');
  }
  const workerPath = join(root, expectedName);
  const worker = await readFile(workerPath).catch(() => {
    throw new Error(`Capture Runtime OCR worker is not readable: ${workerPath}.`);
  });
  const workerSha256 = createHash('sha256').update(worker).digest('hex');
  if (worker.length !== artifact.bytes || workerSha256 !== artifact.sha256.toLowerCase()) {
    throw new Error('Capture Runtime OCR worker does not match the downloaded catalog.');
  }
  if (!localProbe) {
    return { fileName: expectedName, sha256: workerSha256, bytes: worker.length };
  }
  const filesManifestSha256 = artifact.filesManifestSha256;
  if (
    typeof filesManifestSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/iu.test(filesManifestSha256)
  ) {
    throw new Error('Capture Runtime local-probe catalog omitted the worker files manifest SHA.');
  }
  const filesManifestName = expectedName.replace(/\.zip$/u, '-files.json');
  const filesManifestPath = join(root, filesManifestName);
  const filesManifestBytes = await readFile(filesManifestPath).catch(() => {
    throw new Error(`Capture Runtime worker files manifest is not readable: ${filesManifestPath}.`);
  });
  const actualFilesManifestSha256 = createHash('sha256')
    .update(filesManifestBytes)
    .digest('hex');
  if (actualFilesManifestSha256 !== filesManifestSha256.toLowerCase()) {
    throw new Error('Capture Runtime worker files manifest does not match the catalog.');
  }
  let filesManifest: unknown;
  try {
    filesManifest = JSON.parse(filesManifestBytes.toString('utf8'));
  } catch (error) {
    throw new Error('Capture Runtime worker files manifest is not valid JSON.', {
      cause: error,
    });
  }
  const files = isRecord(filesManifest) && Array.isArray(filesManifest.files)
    ? filesManifest.files
    : [];
  const executable = files.find(
    (value) => isRecord(value) && value.path === 'capture-engine-ocr.exe',
  );
  if (
    !isRecord(executable) ||
    typeof executable.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/iu.test(executable.sha256) ||
    typeof executable.bytes !== 'number' ||
    !Number.isSafeInteger(executable.bytes) ||
    executable.bytes <= 0
  ) {
    throw new Error('Capture Runtime worker files manifest omitted capture-engine-ocr.exe.');
  }
  return {
    fileName: expectedName,
    sha256: workerSha256,
    bytes: worker.length,
    executableSha256: executable.sha256.toLowerCase(),
  };
}

async function startCaptureRuntimeMirror(
  candidate: CandidateRuntime,
): Promise<CaptureRuntimeMirror> {
  const workerName = candidate.worker.fileName;
  const workerPath = join(candidate.root, workerName);
  const worker = candidate.worker.content ?? await readFile(workerPath);
  const workerSha256 = createHash('sha256').update(worker).digest('hex');
  if (
    workerSha256 !== candidate.worker.sha256 ||
    worker.length !== candidate.worker.bytes
  ) {
    throw new Error('Capture Runtime OCR worker changed after catalog validation.');
  }
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(
      new URL(request.url ?? '/', 'http://127.0.0.1').pathname,
    );
    if (request.method !== 'GET' || pathname !== `/${workerName}`) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/zip');
    response.setHeader('Content-Length', String(worker.length));
    // Serve the immutable bytes that were catalog-validated above. Reopening
    // the path here would create a validation-to-download drift window.
    response.end(worker);
  });
  const address = await new Promise<AddressInfo>(
    (resolveAddress, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const value = server.address();
        if (!value || typeof value === 'string') {
          reject(new Error('Capture Runtime worker mirror did not expose a TCP address.'));
          return;
        }
        resolveAddress(value);
      });
    },
  );
  return {
    url: `http://127.0.0.1:${address.port}`,
    workerSha256,
    workerBytes: worker.length,
    workerArchive: worker,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      }),
  };
}

async function requiredFile(
  name: string,
  label: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<string> {
  return requiredFileValue(requiredValue(name, environment), label, name);
}

async function requiredFileValue(
  value: string,
  label: string,
  name: string,
): Promise<string> {
  const resolved = resolve(value);
  const metadata = await stat(resolved).catch(() => undefined);
  if (!metadata?.isFile() || metadata.size === 0) {
    throw new Error(`${name} must point to a non-empty ${label}: ${resolved}.`);
  }
  return resolved;
}

function requiredValue(
  name: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): string {
  const value = environment[name]?.trim();
  if (!value)
    throw new Error(`${name} must be set explicitly for real acceptance.`);
  return value;
}

async function loadOcrTruthManifest(
  environmentName: string,
  sourcePath: string,
  kind: OcrTruthKind,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<OcrTruthManifest> {
  const expectationPath = resolve(requiredValue(environmentName, environment));
  const contents = await readFile(expectationPath, 'utf8').catch(() => {
    throw new Error(
      `${environmentName} must identify a readable expectation manifest: ${expectationPath}.`,
    );
  });
  if (environment['CERT_PREP_ACCEPTANCE_RUNTIME_PROFILE'] === 'local_probe' && environment[`${environmentName}_SHA256`]?.trim() !== createHash('sha256').update(contents).digest('hex')) throw new Error(`${environmentName}_SHA256 must match the fixed local truth manifest.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `OCR truth manifest is not valid JSON: ${expectationPath}.`,
      { cause: error },
    );
  }
  if (isRecord(parsed) && 'rawTextIncludes' in parsed) {
    return parseOcrAnchorExpectation(parsed, sourcePath, kind);
  }
  return parseOcrTruthManifest(parsed, sourcePath, kind);
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
