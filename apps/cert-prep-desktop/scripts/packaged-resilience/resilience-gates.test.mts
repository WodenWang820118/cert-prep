import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type {
  JsonResponse,
  JsonTransport,
} from './api-client.mts';
import {
  drainUploadTriggeredDrafts,
  exactOllamaHealth,
  exactOllamaTags,
  exactProviderSelection,
  exactWindowsMlRequirement,
  waitForExactDocumentDrafts,
} from './resilience-runner.mts';

test('remaining provider selection accepts only exact raw Ollama 4b scope', async () => {
  const transport = new ScriptedTransport([
    response('/llm/provider-selection', {
      preference: 'ollama',
      selected_provider: 'ollama',
      effective_provider: 'ollama',
      configured_model: 'qwen3.5:4b',
      effective_model: 'qwen3.5:4b',
      runtime_requirement_kind: 'ollama',
      model_requirement_kind: 'ollama_model',
    }),
  ]);
  assert.deepEqual(await exactProviderSelection(transport), {
    provider: 'ollama',
    model: 'qwen3.5:4b',
    runtimeKind: 'ollama',
    modelKind: 'ollama_model',
  });

  const fastflow = new ScriptedTransport([
    response('/llm/provider-selection', {
      preference: 'auto',
      selected_provider: 'fastflowlm',
      effective_provider: 'fastflowlm',
      configured_model: 'qwen3.5:4b',
      effective_model: 'qwen3.5:4b',
      runtime_requirement_kind: 'fastflowlm',
      model_requirement_kind: 'fastflowlm_model',
    }),
  ]);
  await assert.rejects(
    exactProviderSelection(fastflow),
    /provider selection was not exact/,
  );
});

test('WindowsML requirement must transition from missing to a canonical run-local path', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'cert-prep-runtime-gate-'));
  try {
    const appData = join(workspace, 'app-data');
    const installed = join(appData, 'runtimes', 'windowsml');
    mkdirSync(installed, { recursive: true });
    const transport = new ScriptedTransport([
      response('/runtime/requirements', {
        items: [
          {
            kind: 'windowsml_ocr',
            available: false,
            unavailable_reason: 'windowsml_runtime_missing',
            installed_path: null,
          },
        ],
      }),
      response('/runtime/requirements', {
        items: [
          {
            kind: 'windowsml_ocr',
            available: true,
            unavailable_reason: null,
            installed_path: installed,
          },
        ],
      }),
    ]);

    assert.equal(
      (await exactWindowsMlRequirement(transport, false, appData)).available,
      false,
    );
    const ready = await exactWindowsMlRequirement(transport, true, appData);
    assert.equal(ready.available, true);
    assert.equal(ready.installedPathRelative, 'runtimes/windowsml');

    const outside = join(workspace, 'outside-runtime');
    mkdirSync(outside);
    const drift = new ScriptedTransport([
      response('/runtime/requirements', {
        items: [
          {
            kind: 'windowsml_ocr',
            available: true,
            unavailable_reason: null,
            installed_path: outside,
          },
        ],
      }),
    ]);
    await assert.rejects(
      exactWindowsMlRequirement(drift, true, appData),
      /not contained by this acceptance app-data/,
    );

    const linkedTarget = join(appData, 'linked-target');
    const linkedRuntime = join(linkedTarget, 'windowsml');
    const linkedParent = join(appData, 'linked-parent');
    mkdirSync(linkedRuntime, { recursive: true });
    symlinkSync(
      linkedTarget,
      linkedParent,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const reparseDrift = new ScriptedTransport([
      response('/runtime/requirements', {
        items: [
          {
            kind: 'windowsml_ocr',
            available: true,
            unavailable_reason: null,
            installed_path: join(linkedParent, 'windowsml'),
          },
        ],
      }),
    ]);
    await assert.rejects(
      exactWindowsMlRequirement(reparseDrift, true, appData),
      /installed path was not canonical/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('isolated Ollama tags and backend health prove the missing-to-installed model transition', async () => {
  const urls: string[] = [];
  const fetchEmpty: typeof fetch = async (input) => {
    urls.push(String(input));
    return jsonResponse({ models: [] });
  };
  const fetchReady: typeof fetch = async (input) => {
    urls.push(String(input));
    return jsonResponse({ models: [{ name: 'qwen3.5:4b' }] });
  };
  assert.deepEqual(
    await exactOllamaTags('http://127.0.0.1:11591', false, 1_000, fetchEmpty),
    { modelNames: [] },
  );
  assert.deepEqual(
    await exactOllamaTags('http://127.0.0.1:11591', true, 1_000, fetchReady),
    { modelNames: ['qwen3.5:4b'] },
  );
  assert.deepEqual(urls, [
    'http://127.0.0.1:11591/api/tags',
    'http://127.0.0.1:11591/api/tags',
  ]);

  const health = new ScriptedTransport([
    response('/llm/health', {
      provider: 'ollama',
      model: 'qwen3.5:4b',
      configured_model: 'qwen3.5:4b',
      effective_model: null,
      available: false,
      detail: 'model missing',
      unavailable_reason: 'model_missing',
    }),
    response('/llm/health', {
      provider: 'ollama',
      model: 'qwen3.5:4b',
      configured_model: 'qwen3.5:4b',
      effective_model: 'qwen3.5:4b',
      available: true,
      detail: 'model ready',
      unavailable_reason: null,
    }),
  ]);
  assert.equal((await exactOllamaHealth(health, false)).available, false);
  assert.equal((await exactOllamaHealth(health, true)).available, true);
});

test('upload-triggered jobs drain without questions before manual drafts publish', async () => {
  const projectId = 'project-1';
  const documentId = 'document-1';
  const transport = new ScriptedTransport([
    response(`/projects/${projectId}/documents/${documentId}/draft-jobs`, {
      items: [
        {
          id: 'auto-job-1',
          project_id: projectId,
          document_id: documentId,
          status: 'skipped_missing_model',
        },
      ],
    }),
    response(`/projects/${projectId}/question-drafts`, { items: [] }),
    response(`/projects/${projectId}/question-drafts`, {
      items: [
        draft('draft-1', projectId, documentId),
        draft('draft-2', projectId, documentId),
      ],
    }),
  ]);

  const drained = await drainUploadTriggeredDrafts(
    transport,
    projectId,
    documentId,
    1_000,
  );
  assert.equal(drained.usableDraftCount, 0);
  assert.equal(
    await waitForExactDocumentDrafts(transport, projectId, documentId, 1_000),
    2,
  );
  transport.assertConsumed();
});

interface ScriptedRequest {
  readonly path: string;
  readonly response: JsonResponse;
}

class ScriptedTransport implements JsonTransport {
  private readonly requests: ScriptedRequest[];

  constructor(requests: ScriptedRequest[]) {
    this.requests = requests;
  }

  async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
  ): Promise<JsonResponse> {
    assert.equal(method, 'GET');
    const next = this.requests.shift();
    assert.ok(next, `Unexpected request ${method} ${path}`);
    assert.equal(path, next.path);
    return next.response;
  }

  assertConsumed(): void {
    assert.equal(this.requests.length, 0);
  }
}

function response(path: string, body: unknown): ScriptedRequest {
  return { path, response: { status: 200, body } };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function draft(
  id: string,
  projectId: string,
  documentId: string,
): Record<string, unknown> {
  return {
    id,
    project_id: projectId,
    document_id: documentId,
    answer: 'answer',
  };
}
