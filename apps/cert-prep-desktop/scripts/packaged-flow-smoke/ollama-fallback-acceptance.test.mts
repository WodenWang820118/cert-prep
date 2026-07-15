import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Page } from 'playwright';

import {
  assertOllamaFallbackRoute,
  captureOllamaFallbackReadinessAfterRestart,
  finalizeOllamaFallbackAcceptance,
  sanitizeOllamaFallbackSelection,
  validatePhysicalTrigger,
} from './ollama-fallback-acceptance.mts';
import type {
  GenerationReadinessSnapshot,
  OllamaFallbackAcceptanceEvidence,
  OllamaFallbackSelectionEvidence,
  OllamaPhysicalInventoryEvidence,
  SmokeRunState,
} from './types.mts';

test('restart readiness allows the bounded WindowsML cold-start window', async () => {
  const readiness: GenerationReadinessSnapshot = {
    captured_at: '2026-07-15T00:00:00.000Z',
    ready: true,
    provider_selection: null,
    runtime_requirements: [],
    blockers: [],
  };
  let requestTimeoutMs: number | undefined;

  const result = await captureOllamaFallbackReadinessAfterRestart(
    {} as SmokeRunState,
    {} as Page,
    async (_run, options) => {
      requestTimeoutMs = options?.requestTimeoutMs;
      return readiness;
    },
  );

  assert.equal(requestTimeoutMs, 180_000);
  assert.equal(result, readiness);
});

test('selection contract accepts only real FastFlow-to-Ollama declined-terms routing', () => {
  const before = selection({
    selected_provider: 'fastflowlm',
    effective_provider: 'fastflowlm',
    provider_fallback_reason: null,
    hardware_compatible: true,
    requires_terms_acceptance: true,
    terms_version: '0.9.43',
    runtime_requirement_kind: 'fastflowlm',
    model_requirement_kind: 'fastflowlm_model',
  });
  const after = selection({
    provider_fallback_reason: 'FastFlowLM terms were declined.',
  });

  assert.doesNotThrow(() =>
    assertOllamaFallbackRoute('declined-terms', before, after),
  );
  assert.throws(
    () =>
      assertOllamaFallbackRoute(
        'declined-terms',
        { ...before, hardware_compatible: false },
        after,
      ),
    /decline_precondition_failed/,
  );
  assert.throws(
    () =>
      assertOllamaFallbackRoute('declined-terms', before, {
        ...after,
        selected_provider: 'fastflowlm',
      }),
    /selection_contract_failed/,
  );
});

test('physical fallback triggers bind exact provider reasons to observed inventory', () => {
  const inventory = physicalInventory();
  const unsupported = selection({
    provider_fallback_reason: 'No compatible AMD XDNA2 NPU was detected.',
    hardware_compatible: false,
  });
  assert.doesNotThrow(() =>
    assertOllamaFallbackRoute('unsupported-xdna2', unsupported, unsupported),
  );
  assert.doesNotThrow(() =>
    validatePhysicalTrigger('unsupported-xdna2', unsupported, inventory),
  );

  const oldDriver = selection({
    provider_fallback_reason:
      'The AMD accelerator driver must be at least 32.0.203.304.',
    hardware_compatible: false,
  });
  assert.doesNotThrow(() =>
    validatePhysicalTrigger('old-driver', oldDriver, inventory),
  );
  assert.throws(
    () =>
      validatePhysicalTrigger('old-driver', oldDriver, {
        ...inventory,
        accelerators: inventory.accelerators.map((accelerator) => ({
          ...accelerator,
          driver_version: null,
        })),
      }),
    /driver_evidence_missing/,
  );
  assert.throws(
    () => validatePhysicalTrigger('unsupported-xdna2', oldDriver, inventory),
    /physical_trigger_mismatch/,
  );
});

test('selection sanitizer rejects fake providers and malformed fallback evidence', () => {
  const payload = selectionPayload();
  assert.ok(
    sanitizeOllamaFallbackSelection(payload, '2026-07-14T00:00:00.000Z'),
  );
  assert.equal(
    sanitizeOllamaFallbackSelection(
      { ...payload, selected_provider: 'fake' },
      '2026-07-14T00:00:00.000Z',
    ),
    null,
  );
  assert.equal(
    sanitizeOllamaFallbackSelection(
      { ...payload, fallback_reason: '  untrusted reason  ' },
      '2026-07-14T00:00:00.000Z',
    ),
    null,
  );
  assert.equal(
    sanitizeOllamaFallbackSelection(
      { ...payload, runtime_requirement_kind: 'fastflowlm' },
      '2026-07-14T00:00:00.000Z',
    ),
    null,
  );
});

test('final evidence keeps provider and low-resource model fallback reasons separate', async () => {
  const evidence = acceptanceEvidence();
  const run = {
    options: { acceptanceLane: 'ollama-fallback' },
    metrics: {
      ollama_fallback_acceptance: evidence,
      full_exam_question_count: 4,
      streaming_questions: {
        job_snapshots: [
          {
            elapsed_ms: 100,
            source: 'draft-jobs',
            item_count: 1,
            status_counts: { succeeded: 1 },
            generated_count: 2,
            jobs: [
              {
                id: 'job-1',
                status: 'succeeded',
                generated_count: 2,
                configured_provider: 'ollama',
                configured_model: 'cert-prep-qwen3.5-4b-study-8k',
                effective_provider: 'ollama',
                effective_model: 'cert-prep-qwen3.5-2b-study-4k',
                fallback_reason: 'Primary model failed under memory pressure.',
                attribution_complete: true,
              },
            ],
          },
        ],
        question_snapshots: [
          {
            elapsed_ms: 100,
            source: 'question-drafts',
            item_count: 2,
            usable_question_count: 2,
          },
        ],
        status_counts: { succeeded: 1 },
      },
    },
  } as unknown as SmokeRunState;
  const page = {
    request: {
      async get() {
        return {
          status: () => 200,
          json: async () => ({ models: [] }),
        };
      },
    },
  } as unknown as Pick<Page, 'request'>;

  await finalizeOllamaFallbackAcceptance(run, {
    page,
    now: () => new Date('2026-07-14T00:10:00.000Z'),
    waitForRelease: async () => undefined,
  });

  assert.equal(
    evidence.provider_fallback_reason,
    'FastFlowLM terms were declined.',
  );
  assert.equal(
    evidence.model_fallback_reason,
    'Primary model failed under memory pressure.',
  );
  assert.equal(
    run.metrics.provider_fallback_reason,
    evidence.provider_fallback_reason,
  );
  assert.equal(
    run.metrics.model_fallback_reason,
    evidence.model_fallback_reason,
  );
  assert.equal(evidence.usable_question_count, 2);
  assert.equal(evidence.full_exam_question_count, 4);
  assert.equal(evidence.resource_release?.released, true);
});

function selection(
  overrides: Partial<OllamaFallbackSelectionEvidence> = {},
): OllamaFallbackSelectionEvidence {
  return {
    captured_at: '2026-07-14T00:00:00.000Z',
    preference: 'auto',
    selected_provider: 'ollama',
    effective_provider: 'ollama',
    configured_model: 'qwen3.5:4b',
    effective_model: 'cert-prep-qwen3.5-4b-study-8k',
    provider_fallback_reason: 'FastFlowLM terms were declined.',
    hardware_compatible: true,
    requires_terms_acceptance: false,
    terms_accepted: false,
    terms_version: null,
    runtime_requirement_kind: 'ollama',
    model_requirement_kind: 'ollama_model',
    ...overrides,
  };
}

function selectionPayload(): Record<string, unknown> {
  return {
    preference: 'auto',
    selected_provider: 'ollama',
    effective_provider: 'ollama',
    configured_model: 'qwen3.5:4b',
    effective_model: 'cert-prep-qwen3.5-4b-study-8k',
    selection_reason: 'Auto-selected Ollama.',
    fallback_reason: 'FastFlowLM terms were declined.',
    hardware_compatible: true,
    requires_terms_acceptance: false,
    terms_accepted: false,
    terms_version: null,
    terms_url: null,
    runtime_requirement_kind: 'ollama',
    model_requirement_kind: 'ollama_model',
  };
}

function physicalInventory(): OllamaPhysicalInventoryEvidence {
  return {
    schema_version: 1,
    platform: 'Windows',
    platform_version: '11',
    architecture: 'AMD64',
    cpu_name: 'AMD Ryzen AI',
    total_ram_bytes: 16 * 1024 ** 3,
    available_ram_bytes: 8 * 1024 ** 3,
    accelerators: [
      {
        kind: 'npu',
        name: 'AMD XDNA2 NPU',
        vendor: 'AMD',
        driver_version: '31.0.1.0',
        device_id: 'PCI\\VEN_1022',
      },
    ],
    warnings: [],
  };
}

function acceptanceEvidence(): OllamaFallbackAcceptanceEvidence {
  const routed = selection();
  return {
    schema_version: 1,
    trigger: 'declined-terms',
    trigger_mode: 'persisted_terms_decision',
    overrides_used: false,
    fake_provider_observed: false,
    decision_endpoint: '/llm/provider-selection/fastflowlm-terms-decision',
    selection_before: selection({
      selected_provider: 'fastflowlm',
      effective_provider: 'fastflowlm',
      provider_fallback_reason: null,
      requires_terms_acceptance: true,
      terms_version: '0.9.43',
      runtime_requirement_kind: 'fastflowlm',
      model_requirement_kind: 'fastflowlm_model',
    }),
    selection_after_route: routed,
    selection_after_restart: routed,
    provider_fallback_reason: 'FastFlowLM terms were declined.',
    model_fallback_reason: null,
    runtime: {
      requirement_version: '0.12.0',
      installed_path_verified: true,
      api_version: '0.12.0',
      installed_models: ['cert-prep-qwen3.5-4b-study-8k:latest'],
      profile: {
        profile_enabled: true,
        profile_id: 'qwen3.5-4b-study-8k',
        support_status: 'supported',
        selection_reason: 'Selected the default profile.',
        effective_model: 'cert-prep-qwen3.5-4b-study-8k',
        base_model: 'qwen3.5:4b',
        modelfile_sha256: 'a'.repeat(64),
        fallback_models: ['cert-prep-qwen3.5-2b-study-4k'],
        inventory: physicalInventory(),
      },
    },
    job_attribution: [],
    usable_question_count: 0,
    full_exam_question_count: 0,
    resource_release: null,
  };
}
