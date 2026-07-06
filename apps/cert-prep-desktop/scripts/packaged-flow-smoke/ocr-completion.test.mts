import assert from 'node:assert/strict';
import { test } from 'node:test';

import { recordDocumentOcrCompletionEvidence } from './streaming-capture-api.mts';
import type { SmokeRunState } from './types.mts';

test('document API OCR evidence overrides stale visible chunk text metrics', () => {
  const run = {
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
