import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertOcrPageRecordEvidenceIntegrity,
  buildOcrPageRecordEvidence,
} from '../ocr-page-record-evidence.mts';
import {
  assertPdfPageOneScope,
  recordDocumentOcrCompletionEvidence,
} from './streaming-capture-api.mts';
import type { SmokeRunState } from './types.mts';
import { PDF_PARSE_TERMINAL_TEXT_PATTERN } from './flow-steps.mts';

test('document API OCR evidence overrides stale visible chunk text metrics', () => {
  const run = {
    options: {},
    metrics: {
      ocr_completion: {
        pages_processed: 46,
        total_pages: 46,
        chunks: 0,
        expected_pages: 46,
        expected_chunks: 46,
      },
    },
  } as unknown as SmokeRunState;

  recordDocumentOcrCompletionEvidence(run, {
    processed_page_count: 46,
    page_count: 46,
    chunks_count: 46,
  });

  assert.deepEqual(run.metrics.ocr_completion, {
    pages_processed: 46,
    total_pages: 46,
    chunks: 46,
    expected_pages: 46,
    expected_chunks: 46,
  });
});

test('PDF page-one scope accepts a multi-page source with one OCR page', () => {
  assert.equal(
    assertPdfPageOneScope(
      { page_count: 46, processed_page_count: 1, chunks_count: 1 },
      [1],
    ),
    46,
  );
});

test('PDF page-one scope rejects persisted all-pages evidence', () => {
  assert.throws(
    () =>
      assertPdfPageOneScope(
        { page_count: 46, processed_page_count: 46, chunks_count: 46 },
        Array.from({ length: 46 }, (_value, index) => index + 1),
      ),
    /PDF page-one scope was not preserved/u,
  );
});

test('PDF completion accepts the current review-ready terminal label', () => {
  assert.match('Ready to review', PDF_PARSE_TERMINAL_TEXT_PATTERN);
  assert.match('Parsing complete.', PDF_PARSE_TERMINAL_TEXT_PATTERN);
  assert.doesNotMatch('Parsing started', PDF_PARSE_TERMINAL_TEXT_PATTERN);
});

test('OCR page-record evidence is private-safe and independently re-hashable', () => {
  const evidence = buildOcrPageRecordEvidence({
    runId: 'acceptance-run-1',
    expectedDocumentId: 'document-1',
    expectedProjectId: 'project-1',
    document: ocrDocumentRecord(),
    chunks: [ocrChunkRecord()],
    expectedPageNumbers: [1],
    appDataEmptyAtLaunch: true,
  });

  assertOcrPageRecordEvidenceIntegrity(evidence);
  assert.equal(evidence.records.length, 1);
  assert.equal(evidence.records[0]?.rawTextPresent, true);
  assert.doesNotMatch(JSON.stringify(evidence), /private OCR text/u);
  assert.match(evidence.pageRecordsSha256, /^[a-f0-9]{64}$/u);
  assert.match(evidence.records[0]?.recordIdentitySha256 ?? '', /^[a-f0-9]{64}$/u);
});

test('OCR page-record evidence rejects embedded or cross-document records', () => {
  assert.throws(
    () =>
      buildOcrPageRecordEvidence({
        runId: 'acceptance-run-1',
        expectedDocumentId: 'document-1',
        expectedProjectId: 'project-1',
        document: { ...ocrDocumentRecord(), extraction_method: 'embedded' },
        chunks: [ocrChunkRecord()],
        expectedPageNumbers: [1],
        appDataEmptyAtLaunch: true,
      }),
    /document\.extraction_method expected windowsml_ocr/u,
  );
  assert.throws(
    () =>
      buildOcrPageRecordEvidence({
        runId: 'acceptance-run-1',
        expectedDocumentId: 'document-1',
        expectedProjectId: 'project-1',
        document: ocrDocumentRecord(),
        chunks: [{ ...ocrChunkRecord(), document_id: 'stale-document' }],
        expectedPageNumbers: [1],
        appDataEmptyAtLaunch: true,
      }),
    /different document/u,
  );
});

function ocrDocumentRecord(): Record<string, unknown> {
  return {
    id: 'document-1',
    project_id: 'project-1',
    sha256: 'a'.repeat(64),
    page_count: 46,
    processed_page_count: 1,
    chunks_count: 1,
    has_text: true,
    status: 'ready',
    extraction_method: 'windowsml_ocr',
    source_kind: 'document',
  };
}

function ocrChunkRecord(): Record<string, unknown> {
  return {
    id: 'chunk-1',
    document_id: 'document-1',
    page_number: 1,
    chunk_index: 0,
    source_revision: 1,
    locator_kind: 'page',
    extraction_method: 'windowsml_ocr',
    raw_text: 'private OCR text',
  };
}
