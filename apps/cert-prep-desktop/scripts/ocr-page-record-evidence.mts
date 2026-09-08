import { createHash } from 'node:crypto';

import type { InstalledRuntimeTupleAttestation } from './packaged-flow-smoke/types.mts';

export const OCR_PAGE_RECORD_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const OCR_PROJECTION_SOURCE = 'capture-runtime-ocr-projection' as const;
export const OCR_EXTRACTION_METHOD = 'windowsml_ocr' as const;
export const OCR_FORBIDDEN_EXTRACTION_METHODS = ['embedded', 'mixed'] as const;
export const OCR_IDENTITY_CANONICALIZATION = 'sorted-json-v1' as const;

export interface OcrDocumentRecordIdentity {
  readonly documentIdSha256: string;
  readonly projectIdSha256: string;
  readonly sourceSha256: string;
  readonly pageCount: number;
  readonly processedPageCount: number;
  readonly chunksCount: number;
  readonly hasText: true;
  readonly status: string;
  readonly extractionMethod: typeof OCR_EXTRACTION_METHOD;
  readonly sourceKind: 'document';
}

export interface OcrPageRecordIdentity {
  readonly projectionSource: typeof OCR_PROJECTION_SOURCE;
  readonly documentIdSha256: string;
  readonly recordIdSha256: string;
  readonly pageNumber: number;
  readonly chunkIndex: number;
  readonly sourceRevision: number;
  readonly locatorKind: 'page';
  readonly extractionMethod: typeof OCR_EXTRACTION_METHOD;
  /** The API record carried OCR text; the text itself never enters evidence. */
  readonly rawTextPresent: true;
  readonly recordIdentitySha256: string;
}

export interface OcrPageRecordEvidence {
  readonly schemaVersion: typeof OCR_PAGE_RECORD_EVIDENCE_SCHEMA_VERSION;
  readonly identityScope: 'fresh-installed-app-run';
  readonly runId: string;
  readonly canonicalization: typeof OCR_IDENTITY_CANONICALIZATION;
  readonly projectionSource: typeof OCR_PROJECTION_SOURCE;
  readonly expectedExtractionMethod: typeof OCR_EXTRACTION_METHOD;
  readonly forbiddenExtractionMethods: typeof OCR_FORBIDDEN_EXTRACTION_METHODS;
  readonly freshness: {
    readonly appDataEmptyAtLaunch: boolean;
    readonly uploadResponseMatchedDocument: true;
    readonly uploadDocumentIdSha256: string;
    readonly uploadProjectIdSha256: string;
  };
  readonly runtimeAttestationSha256: string | null;
  readonly expectedPageNumbers: readonly number[];
  readonly document: OcrDocumentRecordIdentity;
  readonly documentRecordSha256: string;
  readonly records: readonly OcrPageRecordIdentity[];
  readonly pageRecordsSha256: string;
}

export interface BuildOcrPageRecordEvidenceInput {
  readonly runId: string;
  readonly expectedDocumentId: string;
  readonly expectedProjectId: string;
  readonly document: Record<string, unknown>;
  readonly chunks: readonly Record<string, unknown>[];
  readonly expectedPageNumbers: readonly number[];
  readonly appDataEmptyAtLaunch: boolean;
  readonly runtimeAttestation?: InstalledRuntimeTupleAttestation;
}

/**
 * Build a privacy-safe identity ledger from the public document/chunks API.
 * IDs are one-way hashed, while page and extraction metadata remain available
 * for independent re-hashing and fail-closed acceptance checks.
 */
export function buildOcrPageRecordEvidence(
  input: BuildOcrPageRecordEvidenceInput,
): OcrPageRecordEvidence {
  const runId = requireNonEmptyString(input.runId, 'runId');
  const expectedDocumentId = requireNonEmptyString(
    input.expectedDocumentId,
    'expectedDocumentId',
  );
  const expectedProjectId = requireNonEmptyString(
    input.expectedProjectId,
    'expectedProjectId',
  );
  const documentId = requireNonEmptyString(input.document.id, 'document.id');
  const projectId = requireNonEmptyString(
    input.document.project_id,
    'document.project_id',
  );
  if (documentId !== expectedDocumentId || projectId !== expectedProjectId) {
    throw new Error(
      'OCR page-record evidence document did not match the upload response identity.',
    );
  }

  const sourceSha256 = requireSha256(input.document.sha256, 'document.sha256');
  const pageCount = requirePositiveInteger(
    input.document.page_count,
    'document.page_count',
  );
  const processedPageCount = requirePositiveInteger(
    input.document.processed_page_count,
    'document.processed_page_count',
  );
  const chunksCount = requireNonNegativeInteger(
    input.document.chunks_count,
    'document.chunks_count',
  );
  if (input.document.has_text !== true) {
    throw new Error('OCR page-record evidence document.has_text must be true.');
  }
  const status = requireNonEmptyString(
    input.document.status,
    'document.status',
  );
  if (status !== 'ready') {
    throw new Error(
      `OCR page-record evidence document.status expected ready but received ${status}.`,
    );
  }
  if (input.document.extraction_method !== OCR_EXTRACTION_METHOD) {
    throw new Error(
      `OCR page-record evidence document.extraction_method expected ${OCR_EXTRACTION_METHOD} but received ${String(input.document.extraction_method)}.`,
    );
  }
  if (input.document.source_kind !== 'document') {
    throw new Error(
      `OCR page-record evidence document.source_kind expected document but received ${String(input.document.source_kind)}.`,
    );
  }

  const expectedPageNumbers = normalizedExpectedPageNumbers(
    input.expectedPageNumbers,
  );
  const documentIdSha256 = sha256Text(documentId);
  const projectIdSha256 = sha256Text(projectId);
  const documentRecord: OcrDocumentRecordIdentity = {
    documentIdSha256,
    projectIdSha256,
    sourceSha256,
    pageCount,
    processedPageCount,
    chunksCount,
    hasText: true,
    status,
    extractionMethod: OCR_EXTRACTION_METHOD,
    sourceKind: 'document',
  };

  if (chunksCount !== input.chunks.length) {
    throw new Error(
      `OCR page-record evidence chunks_count expected ${chunksCount} API records but received ${input.chunks.length}.`,
    );
  }
  const records = input.chunks
    .map((chunk, index) => pageRecordFromChunk(chunk, index, documentId))
    .sort(comparePageRecords);
  const actualPageNumbers = uniquePageNumbers(records);
  if (!sameNumberList(actualPageNumbers, expectedPageNumbers)) {
    throw new Error(
      `OCR page-record evidence page numbers expected ${JSON.stringify(expectedPageNumbers)} but received ${JSON.stringify(actualPageNumbers)}.`,
    );
  }
  if (processedPageCount !== actualPageNumbers.length) {
    throw new Error(
      `OCR page-record evidence processed_page_count expected ${processedPageCount} pages but API records covered ${actualPageNumbers.length}.`,
    );
  }
  if (input.chunks.length === 0) {
    throw new Error(
      'OCR page-record evidence requires at least one API record.',
    );
  }

  const freshness = {
    appDataEmptyAtLaunch: input.appDataEmptyAtLaunch,
    uploadResponseMatchedDocument: true as const,
    uploadDocumentIdSha256: documentIdSha256,
    uploadProjectIdSha256: projectIdSha256,
  };
  return {
    schemaVersion: OCR_PAGE_RECORD_EVIDENCE_SCHEMA_VERSION,
    identityScope: 'fresh-installed-app-run',
    runId,
    canonicalization: OCR_IDENTITY_CANONICALIZATION,
    projectionSource: OCR_PROJECTION_SOURCE,
    expectedExtractionMethod: OCR_EXTRACTION_METHOD,
    forbiddenExtractionMethods: OCR_FORBIDDEN_EXTRACTION_METHODS,
    freshness,
    runtimeAttestationSha256: input.runtimeAttestation
      ? sha256CanonicalJson(input.runtimeAttestation)
      : null,
    expectedPageNumbers,
    document: documentRecord,
    documentRecordSha256: sha256CanonicalJson(documentRecord),
    records,
    pageRecordsSha256: sha256CanonicalJson(records),
  };
}

/** Re-hash all identity fields from a persisted evidence artifact. */
export function assertOcrPageRecordEvidenceIntegrity(
  evidence: OcrPageRecordEvidence,
): void {
  if (
    evidence.schemaVersion !== OCR_PAGE_RECORD_EVIDENCE_SCHEMA_VERSION ||
    evidence.identityScope !== 'fresh-installed-app-run' ||
    evidence.canonicalization !== OCR_IDENTITY_CANONICALIZATION ||
    evidence.projectionSource !== OCR_PROJECTION_SOURCE ||
    evidence.expectedExtractionMethod !== OCR_EXTRACTION_METHOD ||
    JSON.stringify(evidence.forbiddenExtractionMethods) !==
      JSON.stringify(OCR_FORBIDDEN_EXTRACTION_METHODS)
  ) {
    throw new Error('OCR page-record evidence contract fields were invalid.');
  }
  if (
    evidence.freshness.uploadResponseMatchedDocument !== true ||
    typeof evidence.freshness.appDataEmptyAtLaunch !== 'boolean' ||
    evidence.freshness.uploadDocumentIdSha256 !==
      evidence.document.documentIdSha256 ||
    evidence.freshness.uploadProjectIdSha256 !==
      evidence.document.projectIdSha256
  ) {
    throw new Error('OCR page-record evidence freshness identity was invalid.');
  }
  if (
    !isSha256Value(evidence.document.documentIdSha256) ||
    !isSha256Value(evidence.document.projectIdSha256) ||
    !isSha256Value(evidence.document.sourceSha256) ||
    evidence.document.pageCount < 1 ||
    !Number.isSafeInteger(evidence.document.pageCount) ||
    evidence.document.processedPageCount < 1 ||
    !Number.isSafeInteger(evidence.document.processedPageCount) ||
    evidence.document.chunksCount < 1 ||
    !Number.isSafeInteger(evidence.document.chunksCount) ||
    evidence.document.hasText !== true ||
    evidence.document.status !== 'ready' ||
    evidence.document.extractionMethod !== OCR_EXTRACTION_METHOD ||
    evidence.document.sourceKind !== 'document' ||
    evidence.records.length === 0 ||
    evidence.records.length !== evidence.document.chunksCount ||
    (evidence.runtimeAttestationSha256 !== null &&
      !isSha256Value(evidence.runtimeAttestationSha256))
  ) {
    throw new Error('OCR page-record evidence document scope was invalid.');
  }
  if (
    evidence.documentRecordSha256 !== sha256CanonicalJson(evidence.document)
  ) {
    throw new Error(
      'OCR page-record evidence document identity hash was invalid.',
    );
  }
  if (evidence.pageRecordsSha256 !== sha256CanonicalJson(evidence.records)) {
    throw new Error('OCR page-record evidence records hash was invalid.');
  }
  const recordIds = new Set<string>();
  for (const record of evidence.records) {
    if (recordIds.has(record.recordIdSha256)) {
      throw new Error('OCR page-record evidence record IDs were duplicated.');
    }
    if (
      record.projectionSource !== OCR_PROJECTION_SOURCE ||
      record.documentIdSha256 !== evidence.document.documentIdSha256 ||
      !isSha256Value(record.documentIdSha256) ||
      !isSha256Value(record.recordIdSha256) ||
      record.pageNumber < 1 ||
      !Number.isSafeInteger(record.pageNumber) ||
      record.chunkIndex < 0 ||
      !Number.isSafeInteger(record.chunkIndex) ||
      record.sourceRevision < 1 ||
      !Number.isSafeInteger(record.sourceRevision) ||
      record.locatorKind !== 'page' ||
      record.extractionMethod !== OCR_EXTRACTION_METHOD ||
      record.rawTextPresent !== true
    ) {
      throw new Error('OCR page-record evidence record metadata was invalid.');
    }
    recordIds.add(record.recordIdSha256);
    const identity = {
      projectionSource: record.projectionSource,
      documentIdSha256: record.documentIdSha256,
      recordIdSha256: record.recordIdSha256,
      pageNumber: record.pageNumber,
      chunkIndex: record.chunkIndex,
      sourceRevision: record.sourceRevision,
      locatorKind: record.locatorKind,
      extractionMethod: record.extractionMethod,
      rawTextPresent: record.rawTextPresent,
    };
    if (record.recordIdentitySha256 !== sha256CanonicalJson(identity)) {
      throw new Error(
        'OCR page-record evidence record identity hash was invalid.',
      );
    }
  }
  if (
    !sameNumberList(
      uniquePageNumbers(evidence.records),
      evidence.expectedPageNumbers,
    )
  ) {
    throw new Error(
      'OCR page-record evidence expected page numbers were invalid.',
    );
  }
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(value), 'utf8')
    .digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  );
  return `{${entries
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(',')}}`;
}

function pageRecordFromChunk(
  chunk: Record<string, unknown>,
  index: number,
  expectedDocumentId: string,
): OcrPageRecordIdentity {
  const documentId = requireNonEmptyString(
    chunk.document_id,
    `chunks[${index}].document_id`,
  );
  if (documentId !== expectedDocumentId) {
    throw new Error(
      `OCR page-record evidence chunks[${index}] belonged to a different document.`,
    );
  }
  const recordId = requireNonEmptyString(chunk.id, `chunks[${index}].id`);
  const pageNumber = requirePositiveInteger(
    chunk.page_number,
    `chunks[${index}].page_number`,
  );
  const chunkIndex = requireNonNegativeInteger(
    chunk.chunk_index,
    `chunks[${index}].chunk_index`,
  );
  const sourceRevision = requirePositiveInteger(
    chunk.source_revision,
    `chunks[${index}].source_revision`,
  );
  if (chunk.locator_kind !== 'page') {
    throw new Error(
      `OCR page-record evidence chunks[${index}].locator_kind expected page but received ${String(chunk.locator_kind)}.`,
    );
  }
  if (chunk.extraction_method !== OCR_EXTRACTION_METHOD) {
    throw new Error(
      `OCR page-record evidence chunks[${index}].extraction_method expected ${OCR_EXTRACTION_METHOD} but received ${String(chunk.extraction_method)}.`,
    );
  }
  if (
    typeof chunk.raw_text !== 'string' ||
    chunk.raw_text.trim().length === 0
  ) {
    throw new Error(
      `OCR page-record evidence chunks[${index}] did not expose non-empty raw_text.`,
    );
  }
  const identity = {
    projectionSource: OCR_PROJECTION_SOURCE,
    documentIdSha256: sha256Text(documentId),
    recordIdSha256: sha256Text(recordId),
    pageNumber,
    chunkIndex,
    sourceRevision,
    locatorKind: 'page' as const,
    extractionMethod: OCR_EXTRACTION_METHOD,
    rawTextPresent: true as const,
  };
  return {
    ...identity,
    recordIdentitySha256: sha256CanonicalJson(identity),
  };
}

function comparePageRecords(
  left: OcrPageRecordIdentity,
  right: OcrPageRecordIdentity,
): number {
  return (
    left.pageNumber - right.pageNumber || left.chunkIndex - right.chunkIndex
  );
}

function uniquePageNumbers(
  records: readonly OcrPageRecordIdentity[],
): number[] {
  return [...new Set(records.map((record) => record.pageNumber))].sort(
    (left, right) => left - right,
  );
}

function normalizedExpectedPageNumbers(value: readonly number[]): number[] {
  const numbers = [...new Set(value)];
  if (
    numbers.length === 0 ||
    numbers.some((number) => !Number.isSafeInteger(number) || number < 1)
  ) {
    throw new Error(
      'OCR page-record evidence expected page numbers were invalid.',
    );
  }
  return numbers.sort((left, right) => left - right);
}

function sameNumberList(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`OCR page-record evidence ${field} was missing.`);
  }
  return value;
}

function requireSha256(value: unknown, field: string): string {
  const normalized = requireNonEmptyString(value, field).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error(`OCR page-record evidence ${field} was not a SHA-256.`);
  }
  return normalized;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`OCR page-record evidence ${field} was invalid.`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`OCR page-record evidence ${field} was invalid.`);
  }
  return value;
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isSha256Value(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}
