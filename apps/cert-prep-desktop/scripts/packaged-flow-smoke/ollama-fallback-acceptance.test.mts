import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Page } from 'playwright';

import {
  assertOllamaFallbackRoute,
  captureOllamaFallbackReadinessAfterRestart,
  ensureOllamaProfileModels,
  finalizeOllamaFallbackAcceptance,
  sanitizeOllamaFallbackSelection,
  validatePhysicalTrigger,
} from './ollama-fallback-acceptance.mts';
import type {
  GenerationReadinessSnapshot,
  OllamaFallbackAcceptanceEvidence,
  OllamaFallbackSelectionEvidence,
  OllamaPhysicalInventoryEvidence,
  ProjectApiRef,
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

test('model onboarding reuses only a stable profile with every selected and fallback alias', async () => {
  let postCalls = 0;
  const page = onboardingPage({
    tagsBefore: installedProfileTags(),
    tagsAfter: installedProfileTags(),
    onPost: () => {
      postCalls += 1;
      return response(500, {});
    },
  });

  const evidence = await ensureOllamaProfileModels(page, projectApi(), {
    now: dateSequence(
      '2026-07-14T00:00:10.000Z',
      '2026-07-14T00:00:11.000Z',
    ),
  });

  assert.equal(evidence.mode, 'reused');
  assert.equal(evidence.job, null);
  assert.equal(postCalls, 0);
  assert.deepEqual(evidence.required_models, [
    'cert-prep-qwen3.5-4b-study-8k',
    'cert-prep-qwen3.5-2b-study-4k',
  ]);
});

test('model onboarding lets the product endpoint start a stopped Ollama runtime before proving reuse', async () => {
  let postCalls = 0;
  let deleteCalls = 0;
  const page = onboardingPage({
    tagsBefore: [],
    tagsAfter: installedProfileTags(),
    onTags: (read) => {
      if (read === 1) {
        throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
      }
      return response(200, { models: installedProfileTags() });
    },
    onPost: () => {
      postCalls += 1;
      return response(
        202,
        modelDownloadJob(
          'succeeded',
          'completed',
          false,
          '2026-07-14T00:00:12.000Z',
        ),
      );
    },
    onDelete: () => {
      deleteCalls += 1;
      return response(200, {});
    },
  });

  const evidence = await ensureOllamaProfileModels(page, projectApi(), {
    now: dateSequence(
      '2026-07-14T00:00:10.000Z',
      '2026-07-14T00:00:12.000Z',
    ),
  });

  assert.equal(postCalls, 1);
  assert.equal(deleteCalls, 0);
  assert.equal(evidence.mode, 'reused');
  assert.equal(evidence.job, null);
  assert.deepEqual(evidence.missing_models_before, []);
  assert.deepEqual(evidence.installed_models_before, [
    'cert-prep-qwen3.5-2b-study-4k:latest',
    'cert-prep-qwen3.5-4b-study-8k:latest',
  ]);
});

test('model onboarding installs missing profile aliases through the exact product job', async () => {
  const observedRequests: string[] = [];
  const jobs = [
    modelDownloadJob('running', 'model_download', true, '2026-07-14T00:00:12.000Z'),
    modelDownloadJob('succeeded', 'completed', false, '2026-07-14T00:00:13.000Z'),
  ];
  const page = onboardingPage({
    tagsBefore: [{ name: 'qwen3.5:4b' }],
    tagsAfter: installedProfileTags(),
    onPost: (url) => {
      observedRequests.push(`POST ${url}`);
      return response(
        202,
        modelDownloadJob('queued', 'queued', true, '2026-07-14T00:00:11.000Z'),
      );
    },
    onPoll: (url) => {
      observedRequests.push(`GET ${url}`);
      return response(200, jobs.shift());
    },
  });

  const evidence = await ensureOllamaProfileModels(page, projectApi(), {
    timeoutMs: 5_000,
    now: dateSequence(
      '2026-07-14T00:00:10.000Z',
      '2026-07-14T00:00:14.000Z',
    ),
    monotonicNow: numberSequence(0, 10),
    wait: async () => undefined,
  });

  assert.equal(evidence.mode, 'installed');
  assert.equal(evidence.job?.provider, 'ollama');
  assert.equal(evidence.job?.final_status, 'succeeded');
  assert.deepEqual(evidence.job?.observed_statuses, [
    'queued',
    'running',
    'succeeded',
  ]);
  assert.deepEqual(evidence.missing_models_before, [
    'cert-prep-qwen3.5-4b-study-8k',
    'cert-prep-qwen3.5-2b-study-4k',
  ]);
  assert.match(observedRequests[0] ?? '', /POST .*\/llm\/model-downloads$/);
  assert.match(
    observedRequests[1] ?? '',
    /GET .*\/llm\/model-downloads\/11111111-1111-4111-8111-111111111111$/,
  );
});

test('model onboarding fails closed when a succeeded job does not publish every alias', async () => {
  const page = onboardingPage({
    tagsBefore: [{ name: 'qwen3.5:4b' }],
    tagsAfter: [{ name: 'cert-prep-qwen3.5-4b-study-8k:latest' }],
    onPost: () =>
      response(
        202,
        modelDownloadJob('queued', 'queued', true, '2026-07-14T00:00:11.000Z'),
      ),
    onPoll: () =>
      response(
        200,
        modelDownloadJob('succeeded', 'completed', false, '2026-07-14T00:00:12.000Z'),
      ),
  });

  await assert.rejects(
    ensureOllamaProfileModels(page, projectApi(), {
      now: dateSequence(
        '2026-07-14T00:00:10.000Z',
        '2026-07-14T00:00:13.000Z',
      ),
      monotonicNow: numberSequence(0),
    }),
    /ollama_model_onboarding_models_after/,
  );
});

test('model onboarding best-effort cancels its exact job on timeout without masking the timeout', async () => {
  let canceledUrl = '';
  const page = onboardingPage({
    tagsBefore: [{ name: 'qwen3.5:4b' }],
    tagsAfter: [],
    onPost: () =>
      response(
        202,
        modelDownloadJob('queued', 'queued', true, '2026-07-14T00:00:11.000Z'),
      ),
    onPoll: () =>
      response(
        200,
        modelDownloadJob('running', 'model_download', true, '2026-07-14T00:00:12.000Z'),
      ),
    onDelete: async (url) => {
      canceledUrl = url;
      throw new Error('cancel transport failed');
    },
  });

  await assert.rejects(
    ensureOllamaProfileModels(page, projectApi(), {
      timeoutMs: 1,
      now: dateSequence('2026-07-14T00:00:10.000Z'),
      monotonicNow: numberSequence(0, 2),
      wait: async () => undefined,
    }),
    /ollama_model_onboarding_timed_out/,
  );
  assert.match(
    canceledUrl,
    /\/llm\/model-downloads\/11111111-1111-4111-8111-111111111111$/,
  );
});

test('model onboarding best-effort cancels its exact cancellable job after a real poll failure', async () => {
  let canceledUrl = '';
  const page = onboardingPage({
    tagsBefore: [{ name: 'qwen3.5:4b' }],
    tagsAfter: [],
    onPost: () =>
      response(
        202,
        modelDownloadJob('queued', 'queued', true, '2026-07-14T00:00:11.000Z'),
      ),
    onPoll: () => {
      throw new Error('model poll transport failed');
    },
    onDelete: (url) => {
      canceledUrl = url;
      return response(200, {});
    },
  });

  await assert.rejects(
    ensureOllamaProfileModels(page, projectApi(), {
      timeoutMs: 5_000,
      now: dateSequence('2026-07-14T00:00:10.000Z'),
      monotonicNow: numberSequence(0, 1),
    }),
    /model poll transport failed/,
  );
  assert.match(
    canceledUrl,
    /\/llm\/model-downloads\/11111111-1111-4111-8111-111111111111$/,
  );
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
    schema_version: 2,
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
    model_onboarding: onboardingEvidence(),
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

function onboardingEvidence() {
  return {
    schema_version: 1 as const,
    endpoint: '/llm/model-downloads' as const,
    mode: 'reused' as const,
    started_at: '2026-07-14T00:00:10.000Z',
    completed_at: '2026-07-14T00:00:11.000Z',
    profile_id: 'qwen3.5-4b-study-8k',
    effective_model: 'cert-prep-qwen3.5-4b-study-8k',
    base_model: 'qwen3.5:4b',
    modelfile_sha256: 'a'.repeat(64),
    fallback_models: ['cert-prep-qwen3.5-2b-study-4k'],
    required_models: [
      'cert-prep-qwen3.5-4b-study-8k',
      'cert-prep-qwen3.5-2b-study-4k',
    ],
    installed_models_before: [
      'cert-prep-qwen3.5-4b-study-8k:latest',
      'cert-prep-qwen3.5-2b-study-4k:latest',
    ],
    missing_models_before: [],
    installed_models_after: [
      'cert-prep-qwen3.5-4b-study-8k:latest',
      'cert-prep-qwen3.5-2b-study-4k:latest',
    ],
    profile_selection_stable: true as const,
    job: null,
  };
}

function projectApi(): ProjectApiRef {
  return {
    apiBaseUrl: 'http://127.0.0.1:8765',
    authorization: 'Bearer acceptance-token',
    projectId: 'project-1',
  };
}

function onboardingProfilePayload(): Record<string, unknown> {
  return {
    profile_enabled: true,
    profile_id: 'qwen3.5-4b-study-8k',
    selected_profile: {
      profile_id: 'qwen3.5-4b-study-8k',
      base_model: 'qwen3.5:4b',
      local_model: 'cert-prep-qwen3.5-4b-study-8k',
      explicit_opt_in_required: false,
      fallback_profile_ids: ['qwen3.5-2b-study-4k'],
    },
    support_status: 'supported',
    reason: 'Selected the default profile.',
    fallback_profiles: [
      {
        profile_id: 'qwen3.5-2b-study-4k',
        base_model: 'qwen3.5:2b',
        local_model: 'cert-prep-qwen3.5-2b-study-4k',
        explicit_opt_in_required: false,
        fallback_profile_ids: [],
      },
    ],
    fallback_models: ['cert-prep-qwen3.5-2b-study-4k'],
    warnings: [],
    inventory: physicalInventory(),
    modelfile_sha256: 'a'.repeat(64),
    effective_model: 'cert-prep-qwen3.5-4b-study-8k',
    base_model: 'qwen3.5:4b',
  };
}

function installedProfileTags(): Array<{ readonly name: string }> {
  return [
    { name: 'cert-prep-qwen3.5-4b-study-8k:latest' },
    { name: 'cert-prep-qwen3.5-2b-study-4k:latest' },
  ];
}

function modelDownloadJob(
  status: 'queued' | 'running' | 'succeeded',
  phase: string,
  cancellable: boolean,
  updatedAt: string,
): Record<string, unknown> {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    provider: 'ollama',
    model: 'cert-prep-qwen3.5-4b-study-8k',
    status,
    phase,
    cancellable,
    detail: status === 'succeeded' ? 'model download complete' : 'working',
    completed: status === 'succeeded' ? 100 : 0,
    total: 100,
    created_at: '2026-07-14T00:00:11.000Z',
    updated_at: updatedAt,
    commit_started_at:
      status === 'succeeded' ? '2026-07-14T00:00:12.000Z' : null,
    error: null,
  };
}

function response(status: number, payload: unknown) {
  return {
    status: () => status,
    json: async () => payload,
  };
}

function onboardingPage(options: {
  readonly tagsBefore: unknown;
  readonly tagsAfter: unknown;
  readonly onTags?: (read: number) => unknown;
  readonly onPost?: (url: string) => unknown;
  readonly onPoll?: (url: string) => unknown;
  readonly onDelete?: (url: string) => unknown;
}): Pick<Page, 'request'> {
  let profileReads = 0;
  let tagReads = 0;
  return {
    request: {
      async get(url: string) {
        if (url.endsWith('/llm/profile-selection')) {
          profileReads += 1;
          return response(200, onboardingProfilePayload());
        }
        if (url === 'http://127.0.0.1:11434/api/tags') {
          tagReads += 1;
          if (options.onTags) {
            return options.onTags(tagReads) as never;
          }
          return response(200, {
            models: tagReads === 1 ? options.tagsBefore : options.tagsAfter,
          });
        }
        if (url.includes('/llm/model-downloads/')) {
          return (options.onPoll?.(url) ?? response(500, {})) as never;
        }
        throw new Error(`Unexpected GET ${url}; profile reads: ${profileReads}`);
      },
      async post(url: string) {
        return (options.onPost?.(url) ?? response(500, {})) as never;
      },
      async delete(url: string) {
        return (await options.onDelete?.(url)) as never;
      },
    } as never,
  };
}

function dateSequence(...values: string[]): () => Date {
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)] ?? 'invalid');
}

function numberSequence(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? Number.NaN;
}
