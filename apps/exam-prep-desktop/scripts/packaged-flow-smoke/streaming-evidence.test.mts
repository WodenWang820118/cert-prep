import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyStreamingQuestionStatus,
  draftJobStatusCounts,
  FIRST_CHUNK_GATE_MS,
  firstChunkGateMetrics,
  parseWindowsmlNpuPrepassEvidence,
  sanitizeDraftJobSnapshot,
  sanitizeQuestionSnapshot,
  streamingJobCompletionState,
} from './streaming-evidence.mts';

test('streaming question status classification separates active, ready, and blockers', () => {
  assert.equal(classifyStreamingQuestionStatus('Generating 1/3'), 'active');
  assert.equal(classifyStreamingQuestionStatus('2 questions ready'), 'ready');
  assert.equal(
    classifyStreamingQuestionStatus('0 questions ready so far'),
    'none',
  );
  assert.equal(classifyStreamingQuestionStatus('Model missing'), 'blocked');
  assert.equal(
    classifyStreamingQuestionStatus('Reasoning unavailable'),
    'blocked',
  );
  assert.equal(classifyStreamingQuestionStatus('No question jobs'), 'none');
});

test('streaming draft job snapshots keep status evidence without response secrets', () => {
  const payload = {
    items: [
      {
        status: 'running',
        generated_count: 0,
        question: 'SECRET streamed question',
        authorization: 'Bearer hidden-token',
      },
      { status: 'skipped_missing_model', generated_count: 2 },
      { status: 'running', generated_count: 1 },
    ],
  };

  assert.deepEqual(draftJobStatusCounts(payload), {
    running: 2,
    skipped_missing_model: 1,
  });

  const snapshot = sanitizeDraftJobSnapshot(payload, 42.4);

  assert.deepEqual(snapshot, {
    elapsed_ms: 42,
    source: 'draft-jobs',
    item_count: 3,
    status_counts: {
      running: 2,
      skipped_missing_model: 1,
    },
    generated_count: 3,
    blocker: 'skipped_missing_model',
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|hidden-token|Bearer/i);
});

test('streaming question snapshots count usable questions without storing text', () => {
  const payload = {
    items: [
      {
        question: 'SECRET qwen draft',
        choices: ['SECRET A', 'B'],
        answer: 'SECRET A',
        headers: { authorization: 'Bearer hidden-token' },
      },
      {
        question: 'Incomplete draft',
        choices: ['A'],
      },
    ],
  };

  const snapshot = sanitizeQuestionSnapshot(payload, 101);

  assert.deepEqual(snapshot, {
    elapsed_ms: 101,
    source: 'question-drafts',
    item_count: 2,
    usable_question_count: 1,
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|hidden-token|Bearer/i);
});

test('streaming job completion state separates active, success, and blockers', () => {
  assert.deepEqual(
    streamingJobCompletionState({ succeeded: 3 }),
    {
      total_count: 3,
      active_count: 0,
      terminal_count: 3,
      succeeded_count: 3,
      failed_count: 0,
      skipped_count: 0,
      all_terminal: true,
      all_succeeded: true,
    },
  );

  assert.deepEqual(
    streamingJobCompletionState({
      succeeded: 1,
      running: 1,
      skipped_missing_model: 1,
      failed: 1,
    }),
    {
      total_count: 4,
      active_count: 1,
      terminal_count: 3,
      succeeded_count: 1,
      failed_count: 1,
      skipped_count: 1,
      all_terminal: false,
      all_succeeded: false,
    },
  );
});

test('first chunk gate metrics use strict under-threshold timing', () => {
  assert.equal(FIRST_CHUNK_GATE_MS, 15_000);
  assert.deepEqual(firstChunkGateMetrics(14_999), {
    first_chunk_gate_ms: 15_000,
    first_chunk_under_gate: true,
  });
  assert.deepEqual(firstChunkGateMetrics(15_000), {
    first_chunk_gate_ms: 15_000,
    first_chunk_under_gate: false,
  });
  assert.deepEqual(firstChunkGateMetrics(undefined), {
    first_chunk_gate_ms: 15_000,
    first_chunk_under_gate: false,
  });
});

test('WindowsML NPU prepass evidence requires VitisAI provider events', () => {
  assert.deepEqual(
    parseWindowsmlNpuPrepassEvidence(
      'amd_windowsml:0',
      'npu_prepass=text_density_vitisai;vitisai_events=2;cpu_events=1',
    ),
    {
      source: 'document_ocr_fallback_reason',
      available: true,
      attempted: true,
      ocr_device: 'amd_windowsml:0',
      fallback_reason:
        'npu_prepass=text_density_vitisai;vitisai_events=2;cpu_events=1',
      vitisai_events: 2,
      cpu_events: 1,
      reason: null,
    },
  );

  assert.deepEqual(
    parseWindowsmlNpuPrepassEvidence(
      'amd_windowsml:0',
      'npu_prepass_unavailable=vitisai_events_missing;vitisai_events=0;cpu_events=5',
    ),
    {
      source: 'document_ocr_fallback_reason',
      available: false,
      attempted: true,
      ocr_device: 'amd_windowsml:0',
      fallback_reason:
        'npu_prepass_unavailable=vitisai_events_missing;vitisai_events=0;cpu_events=5',
      vitisai_events: 0,
      cpu_events: 5,
      reason: 'attempted_not_scheduled',
    },
  );

  assert.equal(
    parseWindowsmlNpuPrepassEvidence('cpu', 'vitisai_events=9;cpu_events=1')
      .available,
    false,
  );
});
