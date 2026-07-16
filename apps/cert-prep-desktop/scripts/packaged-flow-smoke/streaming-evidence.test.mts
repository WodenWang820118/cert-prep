import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyStreamingQuestionStatus,
  draftJobStatusCounts,
  FIRST_CHUNK_GATE_MS,
  firstChunkGateMetrics,
  fullExamQuestionCountFromSession,
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
        id: 'job-running',
        status: 'running',
        generated_count: 0,
        provider: 'ollama',
        model: 'qwen3.5:4b',
        effective_provider: null,
        effective_model: null,
        fallback_reason: null,
        question: 'SECRET streamed question',
        authorization: 'Bearer hidden-token',
      },
      {
        id: 'job-skipped',
        status: 'skipped_missing_model',
        generated_count: 2,
        provider: 'ollama',
        model: 'qwen3.5:4b',
        effective_provider: null,
        effective_model: null,
        fallback_reason: null,
      },
      {
        id: 'job-succeeded',
        status: 'succeeded',
        generated_count: 1,
        provider: 'ollama',
        model: 'qwen3.5:4b',
        effective_provider: 'ollama',
        effective_model: 'qwen3.5:4b',
        fallback_reason: null,
      },
    ],
  };

  assert.deepEqual(draftJobStatusCounts(payload), {
    running: 1,
    skipped_missing_model: 1,
    succeeded: 1,
  });

  const snapshot = sanitizeDraftJobSnapshot(payload, 42.4);

  assert.deepEqual(snapshot, {
    elapsed_ms: 42,
    source: 'draft-jobs',
    item_count: 3,
    status_counts: {
      running: 1,
      skipped_missing_model: 1,
      succeeded: 1,
    },
    generated_count: 1,
    jobs: [
      {
        id: 'job-running',
        status: 'running',
        generated_count: 0,
        configured_provider: 'ollama',
        configured_model: 'qwen3.5:4b',
        effective_provider: null,
        effective_model: null,
        fallback_reason: null,
        attribution_complete: false,
      },
      {
        id: 'job-skipped',
        status: 'skipped_missing_model',
        generated_count: 2,
        configured_provider: 'ollama',
        configured_model: 'qwen3.5:4b',
        effective_provider: null,
        effective_model: null,
        fallback_reason: null,
        attribution_complete: false,
      },
      {
        id: 'job-succeeded',
        status: 'succeeded',
        generated_count: 1,
        configured_provider: 'ollama',
        configured_model: 'qwen3.5:4b',
        effective_provider: 'ollama',
        effective_model: 'qwen3.5:4b',
        fallback_reason: null,
        attribution_complete: true,
      },
    ],
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

test('Full Exam evidence returns only the validated selected-document count', () => {
  const request = validFullExamRequest();
  const response = validFullExamResponse();

  const count = fullExamQuestionCountFromSession(request, response, {
    projectId: 'project-1',
    documentId: 'document-1',
  });

  assert.equal(count, 2);
  assert.doesNotMatch(JSON.stringify({ count }), /SECRET|Bearer|choice/i);
});

test('Full Exam evidence rejects stale counts, scope drift, and unusable questions', () => {
  const expected = { projectId: 'project-1', documentId: 'document-1' };

  const empty = validFullExamResponse();
  empty.question_ids = [];
  empty.questions = [];
  assert.equal(
    fullExamQuestionCountFromSession(validFullExamRequest(), empty, expected),
    null,
  );

  const staleCount = validFullExamResponse();
  staleCount.question_count = 5;
  assert.equal(
    fullExamQuestionCountFromSession(
      validFullExamRequest(),
      staleCount,
      expected,
    ),
    null,
  );

  const requestedCountMismatch = validFullExamRequest();
  requestedCountMismatch.question_count = 5;
  assert.equal(
    fullExamQuestionCountFromSession(
      requestedCountMismatch,
      validFullExamResponse(),
      expected,
    ),
    null,
  );

  const duplicateIds = validFullExamResponse();
  duplicateIds.question_ids = ['question-1', 'question-1'];
  assert.equal(
    fullExamQuestionCountFromSession(
      validFullExamRequest(),
      duplicateIds,
      expected,
    ),
    null,
  );

  const wrongOrder = validFullExamResponse();
  wrongOrder.question_ids = ['question-2', 'question-1'];
  assert.equal(
    fullExamQuestionCountFromSession(
      validFullExamRequest(),
      wrongOrder,
      expected,
    ),
    null,
  );

  const wrongDocument = validFullExamResponse();
  wrongDocument.questions[0] = {
    ...wrongDocument.questions[0],
    document_id: 'document-2',
  };
  assert.equal(
    fullExamQuestionCountFromSession(
      validFullExamRequest(),
      wrongDocument,
      expected,
    ),
    null,
  );

  const invalidAnswer = validFullExamResponse();
  invalidAnswer.questions[0] = {
    ...invalidAnswer.questions[0],
    answer: 'not-an-option',
  };
  assert.equal(
    fullExamQuestionCountFromSession(
      validFullExamRequest(),
      invalidAnswer,
      expected,
    ),
    null,
  );

  const missingRationale = validFullExamResponse();
  missingRationale.questions[0] = {
    ...missingRationale.questions[0],
    rationale: '   ',
  };
  assert.equal(
    fullExamQuestionCountFromSession(
      validFullExamRequest(),
      missingRationale,
      expected,
    ),
    null,
  );

  const missingEvidence = validFullExamResponse();
  missingEvidence.questions[0] = {
    ...missingEvidence.questions[0],
    citation_page: null,
    source_excerpt: '   ',
  };
  assert.equal(
    fullExamQuestionCountFromSession(
      validFullExamRequest(),
      missingEvidence,
      expected,
    ),
    null,
  );

  const wrongRequestMode = validFullExamRequest();
  wrongRequestMode.mode = 'random_draw';
  assert.equal(
    fullExamQuestionCountFromSession(
      wrongRequestMode,
      validFullExamResponse(),
      expected,
    ),
    null,
  );

  const wrongResponseDocument = validFullExamResponse();
  wrongResponseDocument.document_id = 'document-2';
  assert.equal(
    fullExamQuestionCountFromSession(
      validFullExamRequest(),
      wrongResponseDocument,
      expected,
    ),
    null,
  );

  const wrongProject = validFullExamResponse();
  wrongProject.project_id = 'project-2';
  assert.equal(
    fullExamQuestionCountFromSession(
      validFullExamRequest(),
      wrongProject,
      expected,
    ),
    null,
  );
});

test('streaming job attribution fails closed when required nullable fields are absent', () => {
  const snapshot = sanitizeDraftJobSnapshot(
    {
      items: [
        {
          id: 'job-1',
          status: 'succeeded',
          generated_count: 1,
          provider: 'ollama',
          model: 'qwen3.5:4b',
          effective_provider: 'ollama',
          effective_model: 'qwen3.5:4b',
        },
      ],
    },
    10,
  );

  assert.equal(snapshot.generated_count, 1);
  assert.equal(snapshot.jobs[0]?.fallback_reason, null);
  assert.equal(snapshot.jobs[0]?.attribution_complete, false);
});

test('streaming job attribution rejects whitespace-only fallback evidence', () => {
  const snapshot = sanitizeDraftJobSnapshot(
    {
      items: [
        {
          id: 'job-1',
          status: 'succeeded',
          generated_count: 1,
          provider: 'ollama',
          model: 'qwen3.5:4b',
          effective_provider: 'ollama',
          effective_model: 'qwen3.5:4b',
          fallback_reason: '   ',
        },
      ],
    },
    10,
  );

  assert.equal(snapshot.jobs[0]?.fallback_reason, '');
  assert.equal(snapshot.jobs[0]?.attribution_complete, false);
});

test('streaming job completion state separates active, success, and blockers', () => {
  assert.deepEqual(streamingJobCompletionState({ succeeded: 3 }), {
    total_count: 3,
    active_count: 0,
    terminal_count: 3,
    succeeded_count: 3,
    failed_count: 0,
    skipped_count: 0,
    all_terminal: true,
    all_succeeded: true,
  });

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

function validFullExamRequest() {
  return {
    mode: 'full_document',
    document_id: 'document-1',
    question_count: 2,
  };
}

function validFullExamResponse() {
  return {
    id: 'session-1',
    project_id: 'project-1',
    mode: 'full_document',
    document_id: 'document-1',
    question_count: 2,
    status: 'active',
    question_ids: ['question-1', 'question-2'],
    questions: [
      {
        id: 'question-1',
        question: 'SECRET first prompt',
        choices: ['SECRET choice A', 'choice B'],
        answer: 'SECRET choice A',
        rationale: 'SECRET rationale',
        citation_page: 1,
        source_excerpt: null,
        document_id: 'document-1',
      },
      {
        id: 'question-2',
        question: 'SECRET second prompt',
        choices: ['choice C', 'choice D'],
        answer: 'choice D',
        rationale: 'Second rationale',
        citation_page: null,
        source_excerpt: 'Second source excerpt',
        document_id: 'document-1',
      },
    ],
  };
}
