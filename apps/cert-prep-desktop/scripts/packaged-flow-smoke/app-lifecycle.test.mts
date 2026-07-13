import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';

import {
  buildAppLaunchEnvironment,
  createCleanupWithTimeoutController,
  prepareRunDirectories,
  sanitizeInheritedLaunchEnvironment,
  startAcceptanceVideoForSmoke,
} from './app-lifecycle.mts';
import type { SmokeRunState } from './types.mts';

test('cleanup timeout does not mark the underlying cleanup as finished', async () => {
  const target = {};
  const cleanupControl: { finish: () => void } = {
    finish: () => assert.fail('cleanup resolver was not initialized'),
  };
  const timeoutResolvers: Array<() => void> = [];
  const controller = createCleanupWithTimeoutController({
    cleanup: async () => {
      await new Promise<void>((resolve) => {
        cleanupControl.finish = resolve;
      });
    },
    timeoutMs: 10,
    delayForTimeout: async () => {
      await new Promise<void>((resolve) => timeoutResolvers.push(resolve));
    },
  });

  const cleanupView = controller.cleanupWithTimeout(target);
  assert.equal(controller.isFinished(target), false);

  timeoutResolvers.shift()?.();
  await assert.rejects(cleanupView, /cleanup is still running/);
  assert.equal(controller.isFinished(target), false);

  cleanupControl.finish();
  await setImmediate();

  await controller.cleanupWithTimeout(target);
  assert.equal(controller.isFinished(target), true);
});

test('concurrent cleanup timeout callers reuse one actual cleanup', async () => {
  const target = {};
  let cleanupCalls = 0;
  const cleanupControl: { finish: () => void } = {
    finish: () => assert.fail('cleanup resolver was not initialized'),
  };
  const controller = createCleanupWithTimeoutController({
    cleanup: async () => {
      cleanupCalls += 1;
      await new Promise<void>((resolve) => {
        cleanupControl.finish = resolve;
      });
    },
    timeoutMs: 10,
    delayForTimeout: async () => {
      await new Promise<void>(() => undefined);
    },
  });

  const first = controller.cleanupWithTimeout(target);
  const second = controller.cleanupWithTimeout(target);

  assert.strictEqual(first, second);
  assert.equal(cleanupCalls, 1);

  cleanupControl.finish();
  await first;
  await controller.cleanupWithTimeout(target);

  assert.equal(cleanupCalls, 1);
  assert.equal(controller.isFinished(target), true);
});

test('acceptance video start failures are recorded without aborting smoke', async () => {
  const run = {
    metrics: {
      observations: [],
    },
  } as unknown as SmokeRunState;

  await startAcceptanceVideoForSmoke(run, async () => {
    throw new Error('screencast denied');
  });

  assert.deepEqual(run.metrics.observations, [
    'acceptance video start failed: screencast denied',
  ]);
});

test('XDNA2 acceptance strips inherited runtime overrides without mutation', () => {
  const inherited: NodeJS.ProcessEnv = {
    Path: 'C:\\Windows\\System32',
    SystemRoot: 'C:\\Windows',
    HTTPS_PROXY: 'http://proxy.invalid',
    no_proxy: 'proxy.invalid',
    SAFE_PARENT_VALUE: 'preserved',
    OMITTED_VALUE: undefined,
    CERT_PREP_BACKEND_URL: 'http://127.0.0.1:9999',
    cert_prep_backend_token: 'untrusted-token',
    Cert_Prep_Allow_Local_Ocr_Runtime_Url: 'true',
    cert_prep_fastflowlm_terms_accepted_version: 'untrusted',
    OLLAMA_HOST: 'http://127.0.0.1:11435',
    Ollama_Models: 'C:\\untrusted-models',
    FastFlowLM_HOME: 'C:\\untrusted-fastflow',
    FLM_ENDPOINT: 'http://127.0.0.1:52626',
    WebView2_Additional_Browser_Arguments: '--untrusted',
    WEBVIEW2_USER_DATA_FOLDER: 'C:\\untrusted-webview',
  };
  const originalEntries = Object.entries(inherited);

  const sanitized = sanitizeInheritedLaunchEnvironment(
    inherited,
    'xdna2-fastflow',
  );
  const normalizedSanitized = normalizedEnvironment(sanitized);
  assert.equal(normalizedSanitized.path, 'C:\\Windows\\System32');
  assert.equal(normalizedSanitized.systemroot, 'C:\\Windows');
  assert.equal(normalizedSanitized.https_proxy, 'http://proxy.invalid');
  assert.equal(normalizedSanitized.safe_parent_value, 'preserved');
  assert.equal(normalizedSanitized.omitted_value, undefined);
  assert.equal(normalizedSanitized.no_proxy, undefined);
  for (const prefix of [
    'cert_prep_',
    'ollama_',
    'fastflowlm_',
    'flm_',
    'webview2_',
  ]) {
    assert.equal(
      Object.keys(normalizedSanitized).some((name) => name.startsWith(prefix)),
      false,
    );
  }

  const environment = buildAppLaunchEnvironment(
    launchEnvironmentRun('xdna2-fastflow'),
    inherited,
  );
  const normalized = normalizedEnvironment(environment);
  assert.equal(normalized.cert_prep_backend_url, undefined);
  assert.equal(normalized.cert_prep_backend_token, undefined);
  assert.equal(normalized.ollama_host, undefined);
  assert.equal(normalized.fastflowlm_home, undefined);
  assert.equal(normalized.flm_endpoint, undefined);
  assert.equal(normalized.cert_prep_llm_provider, 'auto');
  assert.equal(normalized.cert_prep_ollama_model, 'qwen3.5:4b');
  assert.equal(normalized.no_proxy, 'localhost,127.0.0.1,::1');
  assert.equal(
    normalized.webview2_user_data_folder,
    join('C:\\qa\\app-data', 'webview2'),
  );
  assert.equal(
    Object.keys(environment).filter(
      (name) =>
        name.toLowerCase() === 'webview2_additional_browser_arguments',
    ).length,
    1,
  );
  assert.equal(
    normalized.webview2_additional_browser_arguments,
    '--remote-debugging-port=9491',
  );

  assert.deepEqual(Object.entries(inherited), originalEntries);
});

test('ordinary smoke preserves inherited environment behavior', () => {
  for (const lane of ['none', undefined] as const) {
    const inherited = {
      CERT_PREP_BACKEND_URL: 'http://127.0.0.1:9999',
    };
    const environment = buildAppLaunchEnvironment(
      launchEnvironmentRun(lane),
      inherited,
    );

    assert.equal(
      normalizedEnvironment(environment).cert_prep_backend_url,
      'http://127.0.0.1:9999',
    );
  }
});

test('acceptance launch requires an explicit isolated app-data directory', () => {
  const run = launchEnvironmentRun('xdna2-fastflow');
  delete run.options.appDataDir;

  assert.throws(
    () => buildAppLaunchEnvironment(run, {}),
    /requires an explicit isolated app-data directory/,
  );
});

test('XDNA2 acceptance atomically creates fresh isolated run directories', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cert-prep-acceptance-'));
  try {
    const outDir = join(
      workspaceRoot,
      'tmp',
      'cert-prep-desktop',
      'xdna2-run',
    );
    const run = launchEnvironmentRun('xdna2-fastflow');
    run.options.workspaceRoot = workspaceRoot;
    run.options.outDir = outDir;
    run.options.appDataDir = join(outDir, 'app-data');

    prepareRunDirectories(run, () => new Date('2026-07-13T00:00:00.000Z'));

    assert.equal(existsSync(outDir), true);
    assert.equal(existsSync(run.options.appDataDir), true);
    assert.deepEqual(readdirSync(run.options.appDataDir), []);
    assert.deepEqual(run.metrics.acceptance_isolation_at_launch, {
      captured_at: '2026-07-13T00:00:00.000Z',
      out_dir_created_by_runner: true,
      app_data_dir_created_by_runner: true,
      app_data_dir_empty_at_launch: true,
      paths_within_workspace_run_root: true,
      reparse_points_absent: true,
    });
    assert.throws(
      () => prepareRunDirectories(run),
      /output directory must not exist before the run/,
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('XDNA2 acceptance rolls back staging when app-data changes before commit', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cert-prep-acceptance-'));
  try {
    const parentDir = join(workspaceRoot, 'tmp', 'cert-prep-desktop');
    const outDir = join(parentDir, 'xdna2-run');
    const run = launchEnvironmentRun('xdna2-fastflow');
    run.options.workspaceRoot = workspaceRoot;
    run.options.outDir = outDir;
    run.options.appDataDir = join(outDir, 'app-data');

    assert.throws(
      () =>
        prepareRunDirectories(run, () => new Date(), {
          afterAppDataCreated(stagingAppDataDir) {
            writeFileSync(join(stagingAppDataDir, 'polluted.db'), 'stale');
          },
        }),
      /modified before atomic commit/,
    );

    assert.equal(existsSync(outDir), false);
    assert.equal(run.metrics.acceptance_isolation_at_launch, undefined);
    assert.equal(
      readdirSync(parentDir).some((name) => name.includes('.preparing-')),
      false,
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('XDNA2 acceptance rejects app-data outside the fresh output directory', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cert-prep-acceptance-'));
  try {
    const run = launchEnvironmentRun('xdna2-fastflow');
    run.options.workspaceRoot = workspaceRoot;
    run.options.outDir = join(
      workspaceRoot,
      'tmp',
      'cert-prep-desktop',
      'xdna2-run',
    );
    run.options.appDataDir = join(workspaceRoot, 'preseeded-app-data');

    assert.throws(
      () => prepareRunDirectories(run),
      /app-data directory must stay under/,
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('XDNA2 acceptance rejects reparse points in the run path', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cert-prep-acceptance-'));
  try {
    const runRoot = join(workspaceRoot, 'tmp', 'cert-prep-desktop');
    const junctionTarget = join(workspaceRoot, 'junction-target');
    const linkedRuns = join(runRoot, 'linked-runs');
    mkdirSync(runRoot, { recursive: true });
    mkdirSync(junctionTarget);
    symlinkSync(
      junctionTarget,
      linkedRuns,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const run = launchEnvironmentRun('xdna2-fastflow');
    run.options.workspaceRoot = workspaceRoot;
    run.options.outDir = join(linkedRuns, 'xdna2-run');
    run.options.appDataDir = join(run.options.outDir, 'app-data');

    assert.throws(
      () => prepareRunDirectories(run),
      /must not traverse a reparse point/,
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

function launchEnvironmentRun(
  acceptanceLane: 'none' | 'xdna2-fastflow' | undefined,
): SmokeRunState {
  return {
    port: 9491,
    options: {
      ...(acceptanceLane ? { acceptanceLane } : {}),
      appDataDir: 'C:\\qa\\app-data',
      outDir: 'C:\\qa\\out',
      llmProvider: 'auto',
      ocrProvider: 'windowsml',
      ocrPageWorkers: 1,
      ollamaModel: 'qwen3.5:4b',
      ollamaFallbackModels: ['qwen3.5:2b'],
    },
    metrics: {
      observations: [],
    },
  } as unknown as SmokeRunState;
}

function normalizedEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(environment).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]),
  );
}
