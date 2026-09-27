import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  collectAcceptanceArtifactInputs,
  createAcceptanceRun,
  writeAcceptanceManifest,
} from './acceptance-artifacts.mts';
import {
  assertOcrPageRecordEvidenceIntegrity,
  OCR_EXTRACTION_METHOD,
  OCR_FORBIDDEN_EXTRACTION_METHODS,
  OCR_PROJECTION_SOURCE,
  sha256CanonicalJson,
  type OcrPageRecordEvidence,
} from './ocr-page-record-evidence.mts';
import { PHASE1_FINAL_IDENTITY } from './phase1-final-identity.mts';
import {
  isCompletePersistedOcrExecutionProof,
  localProbeFinalizationErrors,
} from './acceptance-real-options.mts';

const workspaceRoot = resolve(import.meta.dirname, '../..', '..');
const recorded = process.argv.includes('--recorded');
const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
process.env.E2E_ACCEPTANCE_RUN_ID ||= `local-${timestamp}-${process.pid}`;
process.env.E2E_RECORD_VIDEO = recorded
  ? '1'
  : process.env.E2E_RECORD_VIDEO || '0';

const run = createAcceptanceRun(process.env, 'cert-prep', workspaceRoot);
const corepackPath = resolve(
  dirname(process.execPath),
  'node_modules/corepack/dist/corepack.js',
);
if (!existsSync(corepackPath)) {
  throw new Error(`Corepack entry point is missing: ${corepackPath}`);
}
const result = spawnSync(
  process.execPath,
  [
    corepackPath,
    'pnpm',
    'exec',
    'playwright',
    'test',
    '--config',
    'apps/cert-prep-desktop/playwright.acceptance.config.ts',
    'apps/cert-prep-desktop/scripts/acceptance-real.spec.mts',
    '--project=chromium',
  ],
  {
    cwd: workspaceRoot,
    env: process.env,
    stdio: 'inherit',
    shell: false,
    windowsHide: false,
  },
);
if (result.error) throw result.error;
const manifestPath = join(run.artifactRoot, 'acceptance-manifest.json');
await mkdir(run.artifactRoot, { recursive: true });
const existing = existsSync(manifestPath)
  ? (JSON.parse(await readFile(manifestPath, 'utf8')) as {
      status?: 'completed' | 'failed';
      errors?: string[];
      consoleErrors?: string[];
      pageErrors?: string[];
      cleanup?: Record<string, boolean>;
      fixture?: { name: string; sha256: string };
      fixtures?: Record<string, unknown>;
      runtime?: Record<string, unknown>;
    })
  : undefined;
const sourceSuitePath = join(run.artifactRoot, 'acceptance-sources.json');
const sourceSuite = existsSync(sourceSuitePath)
  ? (JSON.parse(await readFile(sourceSuitePath, 'utf8')) as {
      runId?: string;
      status?: 'completed' | 'failed';
      pdf?: {
        fixture?: Record<string, unknown>;
        status?: string;
        truth?: { status?: string };
        evidence?: Record<string, unknown>;
        errors?: string[];
        restartVerified?: boolean;
      };
      image?: {
        fixture?: Record<string, unknown>;
        status?: string;
        truth?: { status?: string };
        cleanup?: Record<string, boolean>;
        cleanupVerified?: boolean;
        error?: string;
        evidence?: Record<string, unknown>;
      };
      runtime?: Record<string, unknown>;
      fixtures?: Record<string, unknown>;
    })
  : undefined;
const exitCode = result.status ?? 1;
const localProbe = process.env.CERT_PREP_ACCEPTANCE_RUNTIME_PROFILE?.trim() === 'local_probe';
const pdfOnly = process.env.CERT_PREP_ACCEPTANCE_PDF_ONLY?.trim() === '1';
const sourceSuiteErrors = localProbe
  ? await localProbeFinalizationErrors(sourceSuite, process.env)
  : phase1SourceSuiteErrors(sourceSuite);
const imageCleanup = pdfOnly
  ? { app: true, sidecar: true, cdpPort: true, temporaryAppData: true }
  : sourceSuite?.image?.cleanup ?? {
      app: sourceSuite?.image?.cleanupVerified === true,
      sidecar: sourceSuite?.image?.cleanupVerified === true,
      cdpPort: sourceSuite?.image?.cleanupVerified === true,
      temporaryAppData: sourceSuite?.image?.cleanupVerified === true,
    };
const cleanup = {
  ...(existing?.cleanup ?? {
    app: false,
    sidecar: false,
    cdpPort: false,
    temporaryAppData: false,
  }),
  imageApp: imageCleanup.app === true,
  imageSidecar: imageCleanup.sidecar === true,
  imageCdpPort: imageCleanup.cdpPort === true,
  imageTemporaryAppData: imageCleanup.temporaryAppData === true,
};
const cleanupComplete = Object.values(cleanup).every(Boolean);
const errors = [
  ...(existing?.errors ?? []),
  ...(exitCode === 0
    ? []
    : [`Cert Prep acceptance Playwright exited with ${exitCode}.`]),
  ...(sourceSuite?.status === 'completed'
    ? []
    : [pdfOnly ? 'PDF acceptance source suite did not complete.' : 'PDF and JPEG acceptance source suite did not complete.']),
  ...(sourceSuite?.image?.error ? [sourceSuite.image.error] : []),
  ...(sourceSuite?.pdf?.status === 'failed'
    ? (sourceSuite.pdf.errors ?? ['PDF acceptance journey failed.'])
    : []),
  ...sourceSuiteErrors,
];
const acceptancePassed =
  exitCode === 0 &&
  existing?.status === 'completed' &&
  sourceSuite?.status === 'completed' &&
  (pdfOnly || sourceSuite.image?.status === 'completed') &&
  sourceSuite.pdf?.truth?.status === 'passed' &&
  (pdfOnly || sourceSuite.image?.truth?.status === 'passed') &&
  cleanupComplete &&
  errors.length === 0 &&
  (existing?.consoleErrors?.length ?? 0) === 0 &&
  (existing?.pageErrors?.length ?? 0) === 0;
await writeAcceptanceManifest(run.artifactRoot, {
  project: run.project,
  runId: run.runId,
  status: acceptancePassed ? 'completed' : 'failed',
  recordVideo: run.recordVideo,
    artifacts: await collectAcceptanceArtifactInputs(run.artifactRoot),
    errors,
    consoleErrors: existing?.consoleErrors ?? [],
    pageErrors: existing?.pageErrors ?? [],
    cleanup,
    fixture: existing?.fixture,
    fixtures: sourceSuite
      ? {
          pdf: sourceSuite.pdf?.fixture,
          image: sourceSuite.image?.fixture,
          pdfTruth: sourceSuite.pdf?.truth,
          imageTruth: sourceSuite.image?.truth,
          runtime: sourceSuite.runtime,
        }
      : undefined,
    evidence:
      sourceSuite &&
      (sourceSuite.runtime?.phase1Final ||
        sourceSuite.image?.evidence ||
        sourceSuite.pdf?.evidence)
        ? {
            ...(sourceSuite.runtime?.phase1Final
              ? { aggregate: sourceSuite.runtime.phase1Final }
              : {}),
            ...(sourceSuite.image?.evidence
              ? { jpeg: sourceSuite.image.evidence }
              : {}),
            ...(sourceSuite.pdf?.evidence
              ? { pdfPage1: sourceSuite.pdf.evidence }
              : {}),
          }
        : undefined,
  });
if (!acceptancePassed) {
  throw new Error(
    `Cert Prep acceptance did not complete truthfully (Playwright=${exitCode}, manifest=${existing?.status ?? 'failed'}).`,
  );
}

function phase1SourceSuiteErrors(
  sourceSuite: {
    runId?: string;
    runtime?: Record<string, unknown>;
    pdf?: {
      fixture?: Record<string, unknown>;
      evidence?: Record<string, unknown>;
    };
    image?: {
      fixture?: Record<string, unknown>;
      evidence?: Record<string, unknown>;
    };
  } | undefined,
): string[] {
  const strict =
    process.env.CERT_PREP_ACCEPTANCE_RUNTIME_PROFILE?.trim() === 'local_probe' ||
    Boolean(process.env.CERT_PREP_CAPTURE_RUNTIME_PHASE1_MANIFEST?.trim());
  const pdfOnly = process.env.CERT_PREP_ACCEPTANCE_PDF_ONLY?.trim() === '1';
  if (!strict) return [];
  const errors: string[] = [];
  const phase = sourceSuite?.runtime?.phase1Final;
  if (!isRecord(phase)) {
    errors.push('Phase 1 acceptance aggregate summary was missing.');
    return errors;
  }
  if (!isSha256(phase.manifestSha256)) {
    errors.push('Phase 1 aggregate manifest hash was invalid.');
  }
  if (typeof phase.sourceHead !== 'string' || !/^[a-f0-9]{40}$/u.test(phase.sourceHead)) {
    errors.push('Phase 1 aggregate source head was invalid.');
  }
  const identity = isRecord(phase.identity) ? phase.identity : undefined;
  if (!identity) {
    errors.push('Phase 1 aggregate identity was missing.');
  } else {
    checkExact(identity, 'runtimeArtifactSha256', PHASE1_FINAL_IDENTITY.runtimeArtifactSha256, errors);
    checkExact(identity, 'contractSetSha256', PHASE1_FINAL_IDENTITY.contractSetSha256, errors);
    checkExact(identity, 'ocrWorkerArchiveSha256', PHASE1_FINAL_IDENTITY.ocrWorkerArchiveSha256, errors);
    checkExact(identity, 'ocrWorkerExecutableSha256', PHASE1_FINAL_IDENTITY.ocrWorkerExecutableSha256, errors);
  }
  const candidate = sourceSuite?.runtime?.candidate;
  checkPythonWheel(isRecord(candidate) ? candidate : undefined, errors);
  checkInstalledRuntimeTuple(sourceSuite, errors, pdfOnly);
  if (!pdfOnly) {
    checkFixture(sourceSuite?.image?.fixture, PHASE1_FINAL_IDENTITY.jpegSha256, 'JPEG', errors);
  }
  checkFixture(sourceSuite?.pdf?.fixture, PHASE1_FINAL_IDENTITY.pdfSha256, 'PDF', errors);
  if (!pdfOnly) {
    checkJourneyEvidence(
      sourceSuite?.image?.evidence,
      PHASE1_FINAL_IDENTITY.jpegSha256,
      false,
      sourceSuite?.runId,
      errors,
    );
  }
  checkJourneyEvidence(
    sourceSuite?.pdf?.evidence,
    PHASE1_FINAL_IDENTITY.pdfSha256,
    true,
    sourceSuite?.runId,
    errors,
  );
  const pdfEvidence = sourceSuite?.pdf?.evidence;
  const pdfProof = pdfEvidence && isRecord(pdfEvidence.ocrExecutionProof)
    ? pdfEvidence.ocrExecutionProof
    : undefined;
  if (
    !isCompletePersistedOcrExecutionProof(
      pdfProof,
      PHASE1_FINAL_IDENTITY.pdfSha256,
      pdfEvidence,
      isRecord(candidate) ? candidate : undefined,
      process.env,
    )
  ) {
    errors.push('Phase 1 PDF OCR execution proof summary was invalid.');
  }
  return errors;
}

function checkPythonWheel(
  candidate: Record<string, unknown> | undefined,
  errors: string[],
): void {
  const candidateWheel = candidate?.pythonWheel;
  const wheel = isRecord(candidateWheel)
    ? candidateWheel
    : undefined;
  if (!wheel) {
    errors.push('Phase 1 candidate Python wheel provenance was missing.');
    return;
  }
  if (
    typeof wheel.fileName !== 'string' ||
    !/^capture[_-]runtime[_-]client-0\.4\.2-[A-Za-z0-9._-]+\.whl$/u.test(wheel.fileName)
  ) {
    errors.push('Phase 1 candidate Python wheel filename was invalid.');
  }
  if (!isSha256(wheel.sha256)) {
    errors.push('Phase 1 candidate Python wheel hash was invalid.');
  }
  if (
    typeof wheel.bytes !== 'number' ||
    !Number.isSafeInteger(wheel.bytes) ||
    wheel.bytes < 1
  ) {
    errors.push('Phase 1 candidate Python wheel byte count was invalid.');
  }
  if (wheel.packageName !== 'capture-runtime-client' || wheel.packageVersion !== '0.4.2') {
    errors.push('Phase 1 candidate Python wheel package identity was invalid.');
  }
  if (wheel.contractSetSha256 !== PHASE1_FINAL_IDENTITY.contractSetSha256) {
    errors.push('Phase 1 candidate Python wheel contract identity was invalid.');
  }
  const generatedModels = isRecord(wheel.generatedModels)
    ? wheel.generatedModels
    : undefined;
  if (generatedModels?.workerSha256 !== true || generatedModels.pdfPageNumbers !== true) {
    errors.push('Phase 1 candidate Python wheel generated-model capabilities were incomplete.');
  }
}

function checkInstalledRuntimeTuple(
  sourceSuite: {
    runId?: string;
    runtime?: Record<string, unknown>;
    pdf?: { evidence?: Record<string, unknown> };
    image?: { evidence?: Record<string, unknown> };
  } | undefined,
  errors: string[],
  pdfOnly = false,
): void {
  const runtime = sourceSuite?.runtime;
  const installed = isRecord(runtime?.installed) ? runtime.installed : undefined;
  if (!installed) {
    errors.push('Phase 1 installed-app provenance was missing.');
    return;
  }
  if (
    installed.runtimeVersion !== PHASE1_FINAL_IDENTITY.runtimeVersion ||
    !isSha256(installed.executableSha256) ||
    !isPositiveInteger(installed.executableBytes) ||
    !isSha256(installed.runtimeCoreSha256) ||
    installed.runtimeCoreSha256 !== PHASE1_FINAL_IDENTITY.runtimeArtifactSha256 ||
    !isPositiveInteger(installed.runtimeCoreBytes) ||
    !isSha256(installed.runtimeManifestSha256) ||
    !isSha256(installed.runtimeManifestIdentitySha256)
  ) {
    errors.push('Phase 1 installed executable/resource provenance was invalid.');
    return;
  }
  const expectedRunId = sourceSuite?.runId;
  if (typeof expectedRunId !== 'string' || !expectedRunId.trim()) {
    errors.push('Phase 1 source suite run identity was missing.');
  }
  const candidate = isRecord(runtime?.candidate) ? runtime.candidate : undefined;
  const candidateWheel = candidate && isRecord(candidate.pythonWheel)
    ? candidate.pythonWheel
    : undefined;
  const evidenceEntries = [
    ...(!pdfOnly ? ([['JPEG', sourceSuite?.image?.evidence]] as const) : []),
    ['PDF', sourceSuite?.pdf?.evidence],
  ] as const;
  for (const [label, evidence] of evidenceEntries) {
    const attestation = evidence && isRecord(evidence.runtimeAttestation)
      ? evidence.runtimeAttestation
      : undefined;
    const tuple = attestation && isRecord(attestation.candidate)
      ? attestation.candidate
      : undefined;
    const observed = attestation && isRecord(attestation.observed)
      ? attestation.observed
      : undefined;
    if (!attestation || attestation.schema_version !== 1 || !tuple || !observed) {
      errors.push(`Phase 1 ${label} installed-app runtime attestation was missing.`);
      continue;
    }
    const evidenceRunId = evidence?.runId;
    if (
      (expectedRunId !== undefined && evidenceRunId !== expectedRunId) ||
      tuple.runtime_version !== PHASE1_FINAL_IDENTITY.runtimeVersion ||
      tuple.runtime_core_sha256 !== installed.runtimeCoreSha256 ||
      tuple.runtime_core_bytes !== installed.runtimeCoreBytes ||
      tuple.runtime_manifest_identity_sha256 !== installed.runtimeManifestIdentitySha256 ||
      tuple.worker_archive_sha256 !== PHASE1_FINAL_IDENTITY.ocrWorkerArchiveSha256 ||
      tuple.worker_executable_sha256 !== PHASE1_FINAL_IDENTITY.ocrWorkerExecutableSha256 ||
      tuple.contract_set_sha256 !== PHASE1_FINAL_IDENTITY.contractSetSha256 ||
      observed.ready !== true ||
      observed.runtime_version !== tuple.runtime_version ||
      observed.api_version !== '2.0' ||
      observed.capture_document_schema_version !== '2' ||
      observed.mode !== PHASE1_FINAL_IDENTITY.authenticatedRuntimePreflight ||
      observed.contract_set_sha256 !== tuple.contract_set_sha256 ||
      observed.worker_executable_sha256 !== tuple.worker_executable_sha256
    ) {
      errors.push(`Phase 1 ${label} installed-app runtime tuple was not same-run exact.`);
    }
    checkAttestedWheel(tuple.python_wheel, candidateWheel, errors, label);
  }
}

function checkAttestedWheel(
  value: unknown,
  candidateWheel: Record<string, unknown> | undefined,
  errors: string[],
  label: string,
): void {
  if (!isRecord(value)) {
    errors.push(`Phase 1 ${label} installed-app Python wheel attestation was missing.`);
    return;
  }
  if (
    typeof value.file_name !== 'string' ||
    !/^capture[_-]runtime[_-]client-0\.4\.2-[A-Za-z0-9._-]+\.whl$/u.test(value.file_name) ||
    !isSha256(value.sha256) ||
    !isPositiveInteger(value.bytes) ||
    value.package_name !== 'capture-runtime-client' ||
    value.package_version !== '0.4.2' ||
    value.contract_set_sha256 !== PHASE1_FINAL_IDENTITY.contractSetSha256 ||
    !isRecord(value.generated_models) ||
    value.generated_models.worker_sha256 !== true ||
    value.generated_models.pdf_page_numbers !== true
  ) {
    errors.push(`Phase 1 ${label} installed-app Python wheel attestation was invalid.`);
    return;
  }
  if (
    candidateWheel &&
    (candidateWheel.fileName !== value.file_name ||
      candidateWheel.sha256 !== value.sha256 ||
      candidateWheel.bytes !== value.bytes ||
      candidateWheel.contractSetSha256 !== value.contract_set_sha256)
  ) {
    errors.push(`Phase 1 ${label} installed-app wheel did not match the candidate observation.`);
  }
}

function checkFixture(
  fixture: Record<string, unknown> | undefined,
  expectedSha256: string,
  label: string,
  errors: string[],
): void {
  if (!fixture || fixture.sha256 !== expectedSha256) {
    errors.push(`Phase 1 ${label} fixture hash did not match the canonical fixture.`);
  }
}

function checkJourneyEvidence(
  evidence: Record<string, unknown> | undefined,
  sourceSha256: string,
  pdf: boolean,
  expectedRunId: string | undefined,
  errors: string[],
): void {
  if (!evidence) {
    errors.push(`Phase 1 ${pdf ? 'PDF' : 'JPEG'} evidence was missing.`);
    return;
  }
  for (const [field, expected] of [
    ['sourceSha256', sourceSha256],
    ['importedSourceSha256', sourceSha256],
    ['runtimeArtifactSha256', PHASE1_FINAL_IDENTITY.runtimeArtifactSha256],
    ['contractSetSha256', PHASE1_FINAL_IDENTITY.contractSetSha256],
    ['workerArchiveSha256', PHASE1_FINAL_IDENTITY.ocrWorkerArchiveSha256],
    ['workerExecutableSha256', PHASE1_FINAL_IDENTITY.ocrWorkerExecutableSha256],
    ['authenticatedRuntimePreflight', 'gpu-dml'],
    ['uiGpuBeforeImport', true],
    ['sourceImportEnabled', true],
    ['expectedAnchorCount', 1],
    ['matchedAnchorCount', 1],
  ] as const) {
    if (evidence[field] !== expected) {
      errors.push(`Phase 1 ${pdf ? 'PDF' : 'JPEG'} evidence ${field} was invalid.`);
    }
  }
  checkPageRecordEvidence(
    evidence.pageRecords,
    sourceSha256,
    pdf,
    expectedRunId,
    evidence.runtimeAttestation,
    errors,
  );
  if (!pdf) return;
  const pageScope = evidence.pageScope;
  if (
    !isRecord(pageScope) ||
    pageScope.sourcePageCount !== 46 ||
    !samePageList(pageScope.requestedPageNumbers) ||
    !samePageList(pageScope.processedPageNumbers) ||
    !samePageList(pageScope.uiRawPageNumbers) ||
    !samePageList(pageScope.uiStructuredPageNumbers)
  ) {
    errors.push('Phase 1 PDF evidence page scope was not exactly source=46 and page=[1].');
  }
}

function checkPageRecordEvidence(
  value: unknown,
  sourceSha256: string,
  pdf: boolean,
  expectedRunId: string | undefined,
  runtimeAttestation: unknown,
  errors: string[],
): void {
  const label = pdf ? 'PDF' : 'JPEG';
  if (!isRecord(value)) {
    errors.push(`Phase 1 ${label} page-record evidence was missing.`);
    return;
  }
  const evidence = value as unknown as OcrPageRecordEvidence;
  try {
    assertOcrPageRecordEvidenceIntegrity(evidence);
  } catch (error) {
    errors.push(
      `Phase 1 ${label} page-record evidence integrity failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }
  const expectedPageNumbers = [1];
  const document = isRecord(value.document) ? value.document : undefined;
  const freshness = isRecord(value.freshness) ? value.freshness : undefined;
  const records = Array.isArray(value.records) ? value.records : undefined;
  if (
    expectedRunId === undefined ||
    value.runId !== expectedRunId ||
    value.identityScope !== 'fresh-installed-app-run' ||
    value.projectionSource !== OCR_PROJECTION_SOURCE ||
    value.expectedExtractionMethod !== OCR_EXTRACTION_METHOD ||
    JSON.stringify(value.forbiddenExtractionMethods) !==
      JSON.stringify(OCR_FORBIDDEN_EXTRACTION_METHODS) ||
    JSON.stringify(value.expectedPageNumbers) !==
      JSON.stringify(expectedPageNumbers) ||
    !freshness ||
    freshness.appDataEmptyAtLaunch !== true ||
    freshness.uploadResponseMatchedDocument !== true ||
    !document ||
    !isSha256(document.documentIdSha256) ||
    !isSha256(document.projectIdSha256) ||
    document.sourceSha256 !== sourceSha256 ||
    document.pageCount !== (pdf ? 46 : 1) ||
    document.processedPageCount !== 1 ||
    document.chunksCount !== 1 ||
    document.hasText !== true ||
    document.status !== 'ready' ||
    document.extractionMethod !== OCR_EXTRACTION_METHOD ||
    document.sourceKind !== 'document' ||
    !records ||
    records.length !== 1
  ) {
    errors.push(`Phase 1 ${label} page-record identity scope was invalid.`);
    return;
  }
  if (
    runtimeAttestation === undefined ||
    value.runtimeAttestationSha256 !== sha256CanonicalJson(runtimeAttestation)
  ) {
    errors.push(`Phase 1 ${label} page-record evidence was not bound to runtime attestation.`);
  }
  if (document.chunksCount !== records.length) {
    errors.push(`Phase 1 ${label} page-record count did not match document chunks_count.`);
  }
  for (const record of records) {
    if (
      !isRecord(record) ||
      record.projectionSource !== OCR_PROJECTION_SOURCE ||
      record.documentIdSha256 !== document.documentIdSha256 ||
      record.extractionMethod !== OCR_EXTRACTION_METHOD ||
      record.locatorKind !== 'page' ||
      record.rawTextPresent !== true ||
      record.pageNumber !== 1 ||
      typeof record.chunkIndex !== 'number' ||
      !Number.isSafeInteger(record.chunkIndex) ||
      record.chunkIndex < 0 ||
      typeof record.sourceRevision !== 'number' ||
      !Number.isSafeInteger(record.sourceRevision) ||
      record.sourceRevision < 1 ||
      !isSha256(record.recordIdSha256) ||
      !isSha256(record.recordIdentitySha256)
    ) {
      errors.push(`Phase 1 ${label} page-record metadata was invalid.`);
      break;
    }
  }
}

function checkExact(
  value: Record<string, unknown>,
  field: string,
  expected: string,
  errors: string[],
): void {
  if (value[field] !== expected) errors.push(`Phase 1 aggregate identity ${field} was invalid.`);
}

function samePageList(value: unknown): boolean {
  return Array.isArray(value) && value.length === 1 && value[0] === 1;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
