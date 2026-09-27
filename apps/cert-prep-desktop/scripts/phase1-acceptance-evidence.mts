import type { OcrTruthEvaluation, OcrTruthManifest } from './ocr-truth-contract.mts';
import type { PrivacySafeOcrSemanticEvidence } from './ocr-semantic-evidence.mts';
import type { OcrExecutionProofSummary } from './ocr-execution-proof.mts';
import type {
  AcceptanceRuntimeIdentityExpectation,
  InstalledRuntimeTupleAttestation,
  OwnedCleanupObservation,
  OcrPreflightMetrics,
} from './packaged-flow-smoke/types.mts';
import {
  assertOcrPageRecordEvidenceIntegrity,
  sha256CanonicalJson,
  type OcrPageRecordEvidence,
} from './ocr-page-record-evidence.mts';

export interface Phase1AcceptanceEvidenceInput {
  readonly identity: AcceptanceRuntimeIdentityExpectation;
  readonly fixture: {
    readonly name: string;
    readonly sha256: string;
    readonly truth: OcrTruthManifest;
  };
  readonly preflight: OcrPreflightMetrics;
  readonly runtimeAttestation?: InstalledRuntimeTupleAttestation;
  readonly pageRecords: OcrPageRecordEvidence;
  readonly ocrTruth: OcrTruthEvaluation;
  readonly ocrSemanticEvidence?: PrivacySafeOcrSemanticEvidence;
  readonly ocrExecutionProof?: OcrExecutionProofSummary;
  readonly cleanup: Record<string, boolean>;
  readonly cleanupObservation?: OwnedCleanupObservation;
  readonly pageScope?: {
    readonly sourcePageCount: number;
    readonly requestedPageNumbers: readonly [1];
    readonly processedPageNumbers: readonly [1];
    readonly uiRawPageNumbers: readonly [1];
    readonly uiStructuredPageNumbers: readonly [1];
  };
}

/**
 * Build a private-safe, hash/count-only evidence object shared by the PDF and
 * JPEG acceptance manifests. OCR source text, fixture names, and temporary
 * paths never enter this object.
 */
export function buildPhase1AcceptanceEvidence(
  input: Phase1AcceptanceEvidenceInput,
): Record<string, unknown> {
  if (input.preflight.mode !== input.identity.preflightMode) {
    throw new Error('Phase 1 acceptance preflight did not select GPU-DML.');
  }
  if (input.preflight.contract_sha256 !== input.identity.contractSetSha256) {
    throw new Error('Phase 1 acceptance preflight contract identity did not match.');
  }
  if (input.preflight.worker_sha256 !== input.identity.workerExecutableSha256) {
    throw new Error('Phase 1 acceptance preflight worker identity did not match.');
  }
  if (!input.preflight.ui_gpu_before_import || !input.preflight.source_import_enabled) {
    throw new Error('Phase 1 acceptance GPU preflight was not visible before import.');
  }
  if (!input.runtimeAttestation) {
    throw new Error('Phase 1 acceptance installed-app runtime attestation was missing.');
  }
  assertOcrPageRecordEvidenceIntegrity(input.pageRecords);
  const expectedRunId = process.env.E2E_ACCEPTANCE_RUN_ID?.trim() ?? 'unknown';
  if (input.pageRecords.runId !== expectedRunId) {
    throw new Error('Phase 1 OCR page-record evidence did not match the acceptance run.');
  }
  if (!input.pageRecords.freshness.appDataEmptyAtLaunch) {
    throw new Error('Phase 1 OCR page-record evidence did not prove fresh app data at launch.');
  }
  if (input.pageRecords.document.sourceSha256 !== input.fixture.sha256) {
    throw new Error('Phase 1 OCR page-record evidence source identity did not match the fixture.');
  }
  const expectedPageNumbers = input.fixture.truth.pages.map(
    (page) => page.pageNumber,
  );
  if (
    JSON.stringify(input.pageRecords.expectedPageNumbers) !==
    JSON.stringify(expectedPageNumbers)
  ) {
    throw new Error('Phase 1 OCR page-record evidence page scope did not match the truth manifest.');
  }
  if (
    input.pageRecords.runtimeAttestationSha256 !==
    sha256CanonicalJson(input.runtimeAttestation)
  ) {
    throw new Error('Phase 1 OCR page-record evidence was not bound to the installed runtime attestation.');
  }

  const expectedAnchorCount = input.fixture.truth.pages.reduce(
    (total, page) => total + page.criticalAnchors.length,
    0,
  );
  const matchedAnchorCount = input.ocrTruth.pages.reduce(
    (total, page) => total + page.criticalAnchorsMatched.length,
    0,
  );
  if (expectedAnchorCount < 1 || matchedAnchorCount !== expectedAnchorCount) {
    throw new Error('Phase 1 acceptance OCR anchor counts did not match.');
  }
  if (input.ocrSemanticEvidence) {
    if (
      input.ocrSemanticEvidence.expectedAnchorCount !== expectedAnchorCount ||
      input.ocrSemanticEvidence.matchedAnchorCount !== matchedAnchorCount ||
      input.ocrSemanticEvidence.missingAnchorCount !== 0
    ) {
      throw new Error('Phase 1 privacy-safe OCR semantic evidence did not match anchor counts.');
    }
  }
  if (!input.ocrExecutionProof) {
    throw new Error('Phase 1 OCR acceptance missed the OCR execution proof.');
  }
  if (
    input.ocrExecutionProof.sourceSha256 !== input.fixture.sha256 ||
    input.ocrExecutionProof.runtimeSha256 !== input.identity.runtimeArtifactSha256 ||
    input.ocrExecutionProof.workerSha256 !== input.identity.workerExecutableSha256 ||
    input.ocrExecutionProof.contractSetSha256 !== input.identity.contractSetSha256 ||
    input.ocrExecutionProof.dmlNodeCount < 1 ||
    input.ocrExecutionProof.sessionCount < 1
  ) {
    throw new Error('Phase 1 OCR execution proof was not bound to the acceptance identity.');
  }

  if (input.pageScope) {
    const pageScope = input.pageScope;
    if (
      !Number.isSafeInteger(pageScope.sourcePageCount) ||
      pageScope.sourcePageCount < 1 ||
      input.pageRecords.document.pageCount !== pageScope.sourcePageCount ||
      input.pageRecords.document.processedPageCount !== 1 ||
      input.pageRecords.document.chunksCount !== 1 ||
      JSON.stringify(pageScope.requestedPageNumbers) !== '[1]' ||
      JSON.stringify(pageScope.processedPageNumbers) !== '[1]' ||
      JSON.stringify(pageScope.uiRawPageNumbers) !== '[1]' ||
      JSON.stringify(pageScope.uiStructuredPageNumbers) !== '[1]' ||
      JSON.stringify(input.pageRecords.expectedPageNumbers) !== '[1]' ||
      input.pageRecords.records.length !== 1 ||
      input.pageRecords.records[0]?.pageNumber !== 1
    ) {
      throw new Error('Phase 1 acceptance PDF page scope must preserve source=N>=1 and page=[1].');
    }
  }

  return {
    sourceSha256: input.fixture.sha256,
    importedSourceSha256: input.fixture.sha256,
    runId: process.env.E2E_ACCEPTANCE_RUN_ID ?? 'unknown',
    runtimeArtifactSha256: input.identity.runtimeArtifactSha256,
    contractSetSha256: input.identity.contractSetSha256,
    workerArchiveSha256: input.identity.workerArchiveSha256,
    workerExecutableSha256: input.identity.workerExecutableSha256,
    runtimeAttestation: input.runtimeAttestation,
    pageRecords: input.pageRecords,
    authenticatedRuntimePreflight: input.preflight.mode,
    uiGpuBeforeImport: input.preflight.ui_gpu_before_import,
    sourceImportEnabled: input.preflight.source_import_enabled,
    expectedAnchorCount,
    matchedAnchorCount,
    ...(input.ocrSemanticEvidence
      ? { ocrSemanticEvidence: input.ocrSemanticEvidence }
      : {}),
    ...(input.ocrExecutionProof
      ? { ocrExecutionProof: input.ocrExecutionProof }
      : {}),
    cleanup: input.cleanup,
    ...(input.cleanupObservation
      ? { cleanupObservation: input.cleanupObservation }
      : {}),
    ...(input.pageScope ? { pageScope: { ...input.pageScope } } : {}),
  };
}
