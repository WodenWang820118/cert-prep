import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyStreamingDraftStatus,
  draftJobStatusCounts,
  sanitizeDraftJobSnapshot,
  sanitizeQuestionDraftSnapshot,
} from './streaming-evidence.mts';

test('streaming draft status classification separates active, ready, and blockers', () => {
  assert.equal(classifyStreamingDraftStatus('Drafting 1/3'), 'active');
  assert.equal(classifyStreamingDraftStatus('2 drafts ready'), 'ready');
  assert.equal(classifyStreamingDraftStatus('0 drafts ready so far'), 'none');
  assert.equal(classifyStreamingDraftStatus('Model missing'), 'blocked');
  assert.equal(
    classifyStreamingDraftStatus('Reasoning unavailable'),
    'blocked',
  );
  assert.equal(classifyStreamingDraftStatus('No draft jobs'), 'none');
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

test('streaming question draft snapshots count usable drafts without storing text', () => {
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

  const snapshot = sanitizeQuestionDraftSnapshot(payload, 101);

  assert.deepEqual(snapshot, {
    elapsed_ms: 101,
    source: 'question-drafts',
    item_count: 2,
    usable_count: 1,
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|hidden-token|Bearer/i);
});
