import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyQuestionGenerationStatus,
  questionJobStatusCounts,
  FIRST_CHUNK_GATE_MS,
  firstChunkGateMetrics,
  wholeSourceQuestionCountFromSession,
  sanitizeQuestionJobSnapshot,
  sanitizeQuestionSnapshot,
  questionJobCompletionState,
} from './question-generation-evidence.mts';

test('question generation status classification separates active, ready, and blockers', () => {
  assert.equal(classifyQuestionGenerationStatus('Generating 1/3'), 'active');
  assert.equal(classifyQuestionGenerationStatus('2 questions ready'), 'ready');
  assert.equal(
    classifyQuestionGenerationStatus('0 questions ready so far'),
    'none',
  );
  assert.equal(classifyQuestionGenerationStatus('Model missing'), 'blocked');
  assert.equal(
    classifyQuestionGenerationStatus('Reasoning unavailable'),
    'blocked',
  );
  assert.equal(classifyQuestionGenerationStatus('No question jobs'), 'none');
});

test('question job snapshots keep status evidence without response secrets', () => {
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

  assert.deepEqual(questionJobStatusCounts(payload), {
    running: 1,
    skipped_missing_model: 1,
    succeeded: 1,
  });

  const snapshot = sanitizeQuestionJobSnapshot(payload, 42.4);

  assert.deepEqual(snapshot, {
    elapsed_ms: 42,
    source: 'question-jobs',
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

test('generated question snapshots count usable questions without storing text', () => {
  const payload = {
    items: [
      {
        question: 'SECRET qwen question',
        choices: ['SECRET A', 'B'],
        answer: 'SECRET A',
        headers: { authorization: 'Bearer hidden-token' },
      },
      {
        question: 'Incomplete question',
        choices: ['A'],
      },
    ],
  };

  const snapshot = sanitizeQuestionSnapshot(payload, 101);

  assert.deepEqual(snapshot, {
    elapsed_ms: 101,
    source: 'questions',
    item_count: 2,
    usable_question_count: 1,
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|hidden-token|Bearer/i);
});

test('Whole source evidence returns only the validated selected-source count', () => {
  const request = validWholeSourceRequest();
  const response = validWholeSourceResponse();

  const count = wholeSourceQuestionCountFromSession(request, response, {
    projectId: 'project-1',
    sourceId: 'source-1',
  });

  assert.equal(count, 2);
  assert.doesNotMatch(JSON.stringify({ count }), /SECRET|Bearer|choice/i);
});

test('Whole source evidence rejects stale counts, scope drift, and unusable questions', () => {
  const expected = { projectId: 'project-1', sourceId: 'source-1' };

  const empty = validWholeSourceResponse();
  empty.question_ids = [];
  empty.questions = [];
  assert.equal(
    wholeSourceQuestionCountFromSession(validWholeSourceRequest(), empty, expected),
    null,
  );

  const staleCount = validWholeSourceResponse();
  staleCount.question_count = 5;
  assert.equal(
    wholeSourceQuestionCountFromSession(
      validWholeSourceRequest(),
      staleCount,
      expected,
    ),
    null,
  );

  const requestedCountMismatch = validWholeSourceRequest();
  requestedCountMismatch.question_count = 5;
  assert.equal(
    wholeSourceQuestionCountFromSession(
      requestedCountMismatch,
      validWholeSourceResponse(),
      expected,
    ),
    null,
  );

  const duplicateIds = validWholeSourceResponse();
  duplicateIds.question_ids = ['question-1', 'question-1'];
  assert.equal(
    wholeSourceQuestionCountFromSession(
      validWholeSourceRequest(),
      duplicateIds,
      expected,
    ),
    null,
  );

  const wrongOrder = validWholeSourceResponse();
  wrongOrder.question_ids = ['question-2', 'question-1'];
  assert.equal(
    wholeSourceQuestionCountFromSession(
      validWholeSourceRequest(),
      wrongOrder,
      expected,
    ),
    null,
  );

  const wrongSource = validWholeSourceResponse();
  wrongSource.questions[0] = {
    ...wrongSource.questions[0],
    source_id: 'source-2',
  };
  assert.equal(
    wholeSourceQuestionCountFromSession(
      validWholeSourceRequest(),
      wrongSource,
      expected,
    ),
    null,
  );

  const invalidAnswer = validWholeSourceResponse();
  invalidAnswer.questions[0] = {
    ...invalidAnswer.questions[0],
    answer: 'not-an-option',
  };
  assert.equal(
    wholeSourceQuestionCountFromSession(
      validWholeSourceRequest(),
      invalidAnswer,
      expected,
    ),
    null,
  );

  const missingRationale = validWholeSourceResponse();
  missingRationale.questions[0] = {
    ...missingRationale.questions[0],
    rationale: '   ',
  };
  assert.equal(
    wholeSourceQuestionCountFromSession(
      validWholeSourceRequest(),
      missingRationale,
      expected,
    ),
    null,
  );

  const missingEvidence = validWholeSourceResponse();
  missingEvidence.questions[0] = {
    ...missingEvidence.questions[0],
    citation_page: null,
    source_excerpt: '   ',
  };
  assert.equal(
    wholeSourceQuestionCountFromSession(
      validWholeSourceRequest(),
      missingEvidence,
      expected,
    ),
    null,
  );

  const wrongRequestMode = validWholeSourceRequest();
  wrongRequestMode.mode = 'random_draw';
  assert.equal(
    wholeSourceQuestionCountFromSession(
      wrongRequestMode,
      validWholeSourceResponse(),
      expected,
    ),
    null,
  );

  const wrongResponseSource = validWholeSourceResponse();
  wrongResponseSource.source_id = 'source-2';
  assert.equal(
    wholeSourceQuestionCountFromSession(
      validWholeSourceRequest(),
      wrongResponseSource,
      expected,
    ),
    null,
  );

  const wrongProject = validWholeSourceResponse();
  wrongProject.project_id = 'project-2';
  assert.equal(
    wholeSourceQuestionCountFromSession(
      validWholeSourceRequest(),
      wrongProject,
      expected,
    ),
    null,
  );
});

test('question generation job attribution fails closed when required nullable fields are absent', () => {
  const snapshot = sanitizeQuestionJobSnapshot(
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

test('question generation job attribution rejects whitespace-only fallback evidence', () => {
  const snapshot = sanitizeQuestionJobSnapshot(
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

test('question generation job completion state separates active, success, and blockers', () => {
  assert.deepEqual(questionJobCompletionState({ succeeded: 3 }), {
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
    questionJobCompletionState({
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

function validWholeSourceRequest() {
  return {
    mode: 'full_source',
    source_id: 'source-1',
    question_count: 2,
  };
}

function validWholeSourceResponse() {
  return {
    id: 'session-1',
    project_id: 'project-1',
    mode: 'full_source',
    source_id: 'source-1',
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
        source_id: 'source-1',
      },
      {
        id: 'question-2',
        question: 'SECRET second prompt',
        choices: ['choice C', 'choice D'],
        answer: 'choice D',
        rationale: 'Second rationale',
        citation_page: null,
        source_excerpt: 'Second source excerpt',
        source_id: 'source-1',
      },
    ],
  };
}
