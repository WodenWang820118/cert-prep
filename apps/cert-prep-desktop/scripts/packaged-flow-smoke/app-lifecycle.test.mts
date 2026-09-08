import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';

import {
  buildAppLaunchEnvironment,
  closeAppAndCheckResidue,
  createCleanupWithTimeoutController,
  forceCrashAndReconnect,
  prepareRunDirectories,
  sanitizeInheritedLaunchEnvironment,
} from './app-lifecycle.mts';
import {
  createAcceptanceAppDataDirectory,
  removeAcceptanceAppDataDirectory,
} from '../acceptance-app-data.mts';
import { selectCertPrepResidue } from '../process-lifecycle/processes.mts';
import type { ProcessRecord } from '../process-lifecycle/processes.mts';
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

test('listener snapshot failure still closes the exact child and preserves the baseline', async () => {
  const baseline = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const app = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  assert.ok(baseline.pid);
  assert.ok(app.pid);
  const baselinePid = baseline.pid;
  const appPid = app.pid;
  const baselineRecord = processRecord(
    baselinePid,
    1,
    'baseline-external.exe',
    '20260831090000.000000+000',
  );
  const appRecord = processRecord(
    appPid,
    1,
    'cert-prep-desktop.exe',
    '20260831090001.000000+000',
  );
  const order: string[] = [];
  let listenerSnapshotCalls = 0;
  let terminateRequested = false;
  const run = {
    app,
    appExit: { exited: false, code: null, signal: null },
    browser: null,
    page: null,
    metrics: { errors: [], observations: [] },
  } as unknown as SmokeRunState;

  try {
    const summary = await closeAppAndCheckResidue(run, 'listener failure', {
      snapshotProcesses: () =>
        app.exitCode === null && app.signalCode === null
          ? [baselineRecord, appRecord]
          : [baselineRecord],
      snapshotListeners: () => {
        listenerSnapshotCalls += 1;
        throw new Error('injected listener snapshot failure');
      },
      stopCapture: async () => {
        order.push('stop-capture');
      },
      requestWindowClose: (pid) => {
        assert.equal(pid, appPid);
        order.push('window-close');
        return false;
      },
      waitForExit: async (child) => {
        order.push('wait-for-exit');
        if (!terminateRequested) return false;
        if (child.exitCode === null && child.signalCode === null) {
          await once(child, 'exit');
        }
        return true;
      },
      terminateProcessTree: (pid) => {
        assert.equal(pid, appPid);
        order.push('terminate-exact-child');
        terminateRequested = true;
        app.kill();
        return {
          attempted: true,
          method: 'signal_process',
          exitCode: null,
          error: null,
        };
      },
    });

    assert.deepEqual(order, [
      'stop-capture',
      'window-close',
      'wait-for-exit',
      'terminate-exact-child',
      'wait-for-exit',
    ]);
    assert.equal(listenerSnapshotCalls, 1);
    assert.notEqual(app.signalCode, null);
    assert.doesNotThrow(() => process.kill(baselinePid, 0));
    assert.deepEqual(summary.ownedCleanupObservation, {
      evidenceUnavailable: {
        source: 'windows_listener_snapshot',
        stage: 'before_close',
      },
    });
    assert.match(
      run.metrics.observations.join('\n'),
      /pre-close listener snapshot failed/u,
    );
  } finally {
    await stopTestChild(app);
    await stopTestChild(baseline);
  }
});

test('forced crash reconnect terminates the app tree without a graceful close request', async () => {
  const order: string[] = [];
  const crashedApp = {
    pid: 4_242,
    exitCode: null,
    killed: false,
  } as unknown as ChildProcess;
  const replacementApp = {
    pid: 4_243,
    exitCode: null,
    killed: false,
  } as unknown as ChildProcess;
  const appProcess = processRecord(
    4_242,
    100,
    'cert-prep-desktop.exe',
    '20260714010000.000000+000',
  );
  let snapshotCalls = 0;
  const run = {
    app: crashedApp,
    appExit: { exited: false, code: null, signal: null },
    browser: {
      close: async () => {
        order.push('browser-close');
      },
    },
    page: {},
    projectApi: {
      apiBaseUrl: 'http://127.0.0.1:8000',
      authorization: 'Bearer stale',
      projectId: 'project-1',
    },
    uploadedDocument: { documentId: 'document-1' },
    metrics: { observations: [] },
    port: 9591,
  } as unknown as SmokeRunState;

  const summary = await forceCrashAndReconnect(run, 'ocr crash recovery', {
    terminateProcessTree(pid) {
      assert.equal(pid, 4_242);
      order.push('terminate-tree');
      return {
        attempted: true,
        method: 'taskkill_process_tree',
        exitCode: 0,
        error: null,
      };
    },
    async waitForExit(child, timeoutMs) {
      assert.strictEqual(child, crashedApp);
      assert.equal(timeoutMs, 15_000);
      order.push('wait-for-exit');
      return true;
    },
    snapshotProcesses: () => {
      snapshotCalls += 1;
      return snapshotCalls === 1 ? [appProcess] : [];
    },
    waitAfterTermination: async () => undefined,
    async launch(target) {
      order.push('launch');
      target.app = replacementApp;
    },
  });

  assert.deepEqual(order, [
    'terminate-tree',
    'wait-for-exit',
    'browser-close',
    'launch',
  ]);
  assert.equal(summary.appPid, 4_242);
  assert.strictEqual(run.app, replacementApp);
  assert.equal(run.port, 9592);
  assert.equal(run.projectApi, null);
  assert.equal(run.uploadedDocument, null);
  assert.match(
    run.metrics.observations[0] ?? '',
    /without a graceful close request/,
  );
});

test('forced crash detects a captured child after it is reparented', async () => {
  const appPid = 5_242;
  const childPid = 5_243;
  const crashedApp = {
    pid: appPid,
    exitCode: null,
    killed: false,
  } as unknown as ChildProcess;
  const root = processRecord(
    appPid,
    100,
    'cert-prep-desktop.exe',
    '20260714010100.000000+000',
  );
  const child = processRecord(
    childPid,
    appPid,
    'cert-prep-backend.exe',
    '20260714010101.000000+000',
  );
  const reparentedChild = { ...child, parentPid: 4 };
  assert.deepEqual(selectCertPrepResidue([reparentedChild], appPid), []);

  let snapshotCalls = 0;
  let launchCalls = 0;
  const run = {
    app: crashedApp,
    appExit: { exited: false, code: null, signal: null },
    browser: { close: async () => undefined },
    page: {},
    projectApi: {
      apiBaseUrl: 'http://127.0.0.1:8000',
      authorization: 'Bearer stale',
      projectId: 'project-1',
    },
    uploadedDocument: { documentId: 'document-1' },
    metrics: { observations: [] },
    port: 9591,
  } as unknown as SmokeRunState;

  await assert.rejects(
    forceCrashAndReconnect(run, 'ocr crash recovery', {
      terminateProcessTree: () => ({
        attempted: true,
        method: 'taskkill_process_tree',
        exitCode: 0,
        error: null,
      }),
      waitForExit: async () => true,
      snapshotProcesses: () => {
        snapshotCalls += 1;
        return snapshotCalls === 1 ? [root, child] : [reparentedChild];
      },
      waitAfterTermination: async () => undefined,
      launch: async () => {
        launchCalls += 1;
      },
    }),
    /cert-prep-backend\.exe#5243/,
  );

  assert.equal(snapshotCalls, 6);
  assert.equal(launchCalls, 0);
});

test('forced crash ignores stale parent PID links from processes older than the app', async () => {
  const appPid = 6_242;
  const crashedApp = {
    pid: appPid,
    exitCode: null,
    killed: false,
  } as unknown as ChildProcess;
  const root = processRecord(
    appPid,
    100,
    'cert-prep-desktop.exe',
    '/Date(2000)/',
  );
  const staleChild = processRecord(
    6_243,
    appPid,
    'WebKitNetworkProcess.exe',
    '/Date(1000)/',
  );
  const staleGrandchild = processRecord(
    6_244,
    staleChild.pid,
    'conhost.exe',
    '/Date(1001)/',
  );
  let snapshotCalls = 0;
  let launchCalls = 0;
  const run = {
    app: crashedApp,
    appExit: { exited: false, code: null, signal: null },
    browser: { close: async () => undefined },
    page: {},
    projectApi: {
      apiBaseUrl: 'http://127.0.0.1:8000',
      authorization: 'Bearer stale',
      projectId: 'project-1',
    },
    uploadedDocument: { documentId: 'document-1' },
    metrics: { observations: [] },
    port: 9591,
  } as unknown as SmokeRunState;

  await forceCrashAndReconnect(run, 'ocr crash recovery', {
    terminateProcessTree: () => ({
      attempted: true,
      method: 'taskkill_process_tree',
      exitCode: 0,
      error: null,
    }),
    waitForExit: async () => true,
    snapshotProcesses: () => {
      snapshotCalls += 1;
      return snapshotCalls === 1
        ? [root, staleChild, staleGrandchild]
        : [staleChild, staleGrandchild];
    },
    waitAfterTermination: async () => undefined,
    launch: async () => {
      launchCalls += 1;
    },
  });

  assert.equal(snapshotCalls, 2);
  assert.equal(launchCalls, 1);
});

test('isolated acceptance strips inherited runtime overrides without mutation', () => {
  const inherited: NodeJS.ProcessEnv = {
    Path: 'C:\\Windows\\System32',
    SystemRoot: 'C:\\Windows',
    HTTPS_PROXY: 'http://proxy.invalid',
    no_proxy: 'proxy.invalid',
    SAFE_PARENT_VALUE: 'preserved',
    OMITTED_VALUE: undefined,
    CERT_PREP_BACKEND_URL: 'http://127.0.0.1:9999',
    cert_prep_backend_token: 'untrusted-token',
    OLLAMA_HOST: 'http://127.0.0.1:11435',
    Ollama_Models: 'C:\\untrusted-models',
    WebView2_Additional_Browser_Arguments: '--untrusted',
    WEBVIEW2_USER_DATA_FOLDER: 'C:\\untrusted-webview',
  };
  const originalEntries = Object.entries(inherited);

  const sanitized = sanitizeInheritedLaunchEnvironment(inherited, true);
  const normalizedSanitized = normalizedEnvironment(sanitized);
  assert.equal(normalizedSanitized.path, 'C:\\Windows\\System32');
  assert.equal(normalizedSanitized.systemroot, 'C:\\Windows');
  assert.equal(normalizedSanitized.https_proxy, 'http://proxy.invalid');
  assert.equal(normalizedSanitized.safe_parent_value, 'preserved');
  assert.equal(normalizedSanitized.omitted_value, undefined);
  assert.equal(normalizedSanitized.no_proxy, undefined);
  for (const prefix of ['cert_prep_', 'ollama_', 'webview2_']) {
    assert.equal(
      Object.keys(normalizedSanitized).some((name) => name.startsWith(prefix)),
      false,
    );
  }

  const environment = buildAppLaunchEnvironment(
    launchEnvironmentRun(true),
    inherited,
  );
  const normalized = normalizedEnvironment(environment);
  assert.equal(normalized.cert_prep_backend_url, undefined);
  assert.equal(normalized.cert_prep_backend_token, undefined);
  assert.equal(normalized.ollama_host, undefined);
  assert.equal(normalized.cert_prep_llm_provider, 'auto');
  assert.equal(normalized.cert_prep_ollama_model, 'qwen3.5:4b');
  assert.equal(normalized.no_proxy, 'localhost,127.0.0.1,::1');
  assert.equal(
    normalized.webview2_user_data_folder,
    join('C:\\qa\\app-data', 'webview2'),
  );
  assert.equal(
    Object.keys(environment).filter(
      (name) => name.toLowerCase() === 'webview2_additional_browser_arguments',
    ).length,
    1,
  );
  assert.equal(
    normalized.webview2_additional_browser_arguments,
    '--remote-debugging-port=9491',
  );

  assert.deepEqual(Object.entries(inherited), originalEntries);
});

test('ordinary smoke preserves unrelated environment and pins the fixed model', () => {
  const inherited = {
    CERT_PREP_BACKEND_URL: 'http://127.0.0.1:9999',
    CERT_PREP_OLLAMA_MODEL: 'unexpected:model',
    CERT_PREP_OLLAMA_FALLBACK_MODELS: 'unexpected:fallback',
    CERT_PREP_PACKAGE_SMOKE_LLM_MODEL: 'unexpected:model',
    CERT_PREP_PACKAGE_SMOKE_LLM_FALLBACK_MODELS: 'unexpected:fallback',
  };
  const environment = buildAppLaunchEnvironment(
    launchEnvironmentRun(false),
    inherited,
  );

  const normalized = normalizedEnvironment(environment);
  assert.equal(normalized.cert_prep_backend_url, 'http://127.0.0.1:9999');
  assert.equal(normalized.cert_prep_ollama_model, 'qwen3.5:4b');
  assert.equal(normalized.cert_prep_ollama_fallback_models, undefined);
  assert.equal(normalized.cert_prep_package_smoke_llm_model, undefined);
  assert.equal(
    normalized.cert_prep_package_smoke_llm_fallback_models,
    undefined,
  );
});

test('isolated acceptance forwards only the explicit 0.4.2 local probe marker', () => {
  const environment = buildAppLaunchEnvironment(
    launchEnvironmentRun(true),
    {
      CERT_PREP_CAPTURE_RUNTIME_PROBE: ' 1 ',
      CERT_PREP_CAPTURE_RUNTIME_EXPECTED_VERSION: ' 0.4.2 ',
      CERT_PREP_CAPTURE_RUNTIME_LOCAL_MODEL_ROOT:
        ' C:\\qa\\capture-runtime-models ',
      CERT_PREP_BACKEND_URL: 'http://127.0.0.1:9999',
      cert_prep_untrusted_override: 'must-not-pass',
    },
  );

  const normalized = normalizedEnvironment(environment);
  assert.equal(normalized.cert_prep_capture_runtime_probe, '1');
  assert.equal(
    normalized.cert_prep_capture_runtime_expected_version,
    '0.4.2',
  );
  assert.equal(
    normalized.cert_prep_capture_runtime_local_model_root,
    'C:\\qa\\capture-runtime-models',
  );
  assert.equal(normalized.cert_prep_backend_url, undefined);
  assert.equal(normalized.cert_prep_untrusted_override, undefined);
});

test('Phase 1 acceptance identity forces the 0.4.2 local probe marker', () => {
  const run = launchEnvironmentRun(true);
  run.options.acceptanceRuntimeIdentity = {
    runtimeArtifactSha256: 'a'.repeat(64),
    contractSetSha256: 'b'.repeat(64),
    workerArchiveSha256: 'c'.repeat(64),
    workerExecutableSha256: 'd'.repeat(64),
    preflightMode: 'gpu-dml',
  };

  const environment = buildAppLaunchEnvironment(run, {});
  const normalized = normalizedEnvironment(environment);

  assert.equal(normalized.cert_prep_capture_runtime_probe, '1');
  assert.equal(
    normalized.cert_prep_capture_runtime_expected_version,
    '0.4.2',
  );
});

test('Phase 1 JPEG acceptance forwards only the exact OCR execution proof opt-in', () => {
  const run = launchEnvironmentRun(true);
  run.options.ocrExecutionEvidenceRoot = 'C:\\qa\\proof-root';
  run.options.ocrExecutionProofExpected = {
    sourceSha256: '1'.repeat(64),
    runtimeSha256: '2'.repeat(64),
    workerExecutableSha256: '3'.repeat(64),
    modelSha256: '4'.repeat(64),
    profileId: 'capture-workbench-ocr-profile',
    profileSpecSha256: '5'.repeat(64),
    contractSetSha256: '6'.repeat(64),
    expectedAdapterClass: 'dedicated',
    expectedAdapterDescriptionIncludes: 'RTX 4060',
  };

  const normalized = normalizedEnvironment(
    buildAppLaunchEnvironment(run, {
      CAPTURE_OCR_EXECUTION_EVIDENCE_OPT_IN: '1',
      CAPTURE_OCR_EXECUTION_EVIDENCE_ROOT: 'C:\\untrusted',
      CAPTURE_OCR_EXECUTION_RUNTIME_SHA256: 'f'.repeat(64),
    }),
  );
  assert.equal(normalized.capture_ocr_execution_evidence_opt_in, '1');
  assert.equal(normalized.capture_ocr_execution_evidence_root, 'C:\\qa\\proof-root');
  assert.equal(normalized.capture_ocr_execution_runtime_sha256, '2'.repeat(64));
});

test('acceptance launch requires an explicit isolated app-data directory', () => {
  const run = launchEnvironmentRun(true);
  delete run.options.appDataDir;

  assert.throws(
    () => buildAppLaunchEnvironment(run, {}),
    /requires an explicit isolated app-data directory/,
  );
});

test('acceptance atomically creates fresh isolated run directories', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cert-prep-acceptance-'));
  try {
    const outDir = join(
      workspaceRoot,
      'tmp',
      'cert-prep-desktop',
      'acceptance-run',
    );
    const run = launchEnvironmentRun(true);
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

test('acceptance supports a controlled short app-data lease', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cert-prep-acceptance-'));
  let appDataDir: string | undefined;
  try {
    const outDir = join(
      workspaceRoot,
      'tmp',
      'cert-prep-desktop',
      'acceptance-short-run',
    );
    appDataDir = createAcceptanceAppDataDirectory(
      workspaceRoot,
      'run-1234567890',
      'image',
    );
    const run = launchEnvironmentRun(true);
    run.options.workspaceRoot = workspaceRoot;
    run.options.outDir = outDir;
    run.options.appDataDir = appDataDir;

    prepareRunDirectories(run, () => new Date('2026-07-13T00:00:00.000Z'));

    assert.equal(existsSync(outDir), true);
    assert.equal(existsSync(appDataDir), true);
    assert.deepEqual(readdirSync(appDataDir), []);
    assert.deepEqual(run.metrics.acceptance_isolation_at_launch, {
      captured_at: '2026-07-13T00:00:00.000Z',
      out_dir_created_by_runner: true,
      app_data_dir_created_by_runner: true,
      app_data_dir_empty_at_launch: true,
      paths_within_workspace_run_root: false,
      app_data_dir_within_controlled_root: true,
      reparse_points_absent: true,
    });
  } finally {
    if (appDataDir) removeAcceptanceAppDataDirectory(workspaceRoot, appDataDir);
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('acceptance rolls back staging when app-data changes before commit', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cert-prep-acceptance-'));
  try {
    const parentDir = join(workspaceRoot, 'tmp', 'cert-prep-desktop');
    const outDir = join(parentDir, 'acceptance-run');
    const run = launchEnvironmentRun(true);
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

test('acceptance rejects app-data outside the fresh output directory', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cert-prep-acceptance-'));
  try {
    const run = launchEnvironmentRun(true);
    run.options.workspaceRoot = workspaceRoot;
    run.options.outDir = join(
      workspaceRoot,
      'tmp',
      'cert-prep-desktop',
      'acceptance-run',
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

test('acceptance rejects reparse points in the run path', () => {
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
    const run = launchEnvironmentRun(true);
    run.options.workspaceRoot = workspaceRoot;
    run.options.outDir = join(linkedRuns, 'acceptance-run');
    run.options.appDataDir = join(run.options.outDir, 'app-data');

    assert.throws(
      () => prepareRunDirectories(run),
      /must not traverse a reparse point/,
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('Ollama acceptance injects only the typed isolated host and model root after sanitizing', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'cert-prep-ollama-env-'));
  try {
    const outDir = join(workspace, 'out');
    const modelsDir = join(outDir, 'isolated-ollama-models');
    mkdirSync(modelsDir, { recursive: true });
    const run = launchEnvironmentRun(true);
    run.options.outDir = outDir;
    run.options.appDataDir = join(outDir, 'app-data');
    run.options.llmProvider = 'ollama';
    run.options.ollamaHost = 'http://127.0.0.1:11591';
    run.options.ollamaModelsDir = modelsDir;
    run.options.ollamaProfileEnabled = false;

    const environment = buildAppLaunchEnvironment(run, {
      CERT_PREP_OLLAMA_HOST: 'http://127.0.0.1:11434',
      CERT_PREP_OLLAMA_MODEL: 'unexpected:model',
      CERT_PREP_OLLAMA_PROFILE_ENABLED: 'true',
      CERT_PREP_PACKAGE_SMOKE_LLM_MODEL: 'unexpected:model',
      OLLAMA_HOST: '127.0.0.1:11434',
      OLLAMA_MODELS: 'C:\\untrusted-models',
    });
    const normalized = normalizedEnvironment(environment);

    assert.equal(normalized.cert_prep_llm_provider, 'ollama');
    assert.equal(normalized.cert_prep_ollama_host, 'http://127.0.0.1:11591');
    assert.equal(normalized.cert_prep_ollama_model, 'qwen3.5:4b');
    assert.equal(normalized.cert_prep_ollama_profile_enabled, 'false');
    assert.equal(normalized.cert_prep_package_smoke_llm_model, undefined);
    assert.equal(normalized.ollama_host, undefined);
    assert.equal(normalized.ollama_models, realpathSync(modelsDir));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Ollama acceptance rejects non-loopback hosts and model roots outside the run', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'cert-prep-ollama-env-reject-'));
  try {
    const outDir = join(workspace, 'out');
    const outside = join(workspace, 'outside-models');
    mkdirSync(outDir, { recursive: true });
    mkdirSync(outside);
    const run = launchEnvironmentRun(true);
    run.options.outDir = outDir;
    run.options.appDataDir = join(outDir, 'app-data');
    run.options.ollamaHost = 'http://example.com:11591';
    run.options.ollamaModelsDir = outside;
    run.options.ollamaProfileEnabled = false;
    assert.throws(
      () => buildAppLaunchEnvironment(run, {}),
      /exact loopback HTTP/,
    );

    run.options.ollamaHost = 'http://127.0.0.1:11591';
    assert.throws(
      () => buildAppLaunchEnvironment(run, {}),
      /must stay inside the acceptance output directory/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function processRecord(
  pid: number,
  parentPid: number,
  name: string,
  creationDate: string,
): ProcessRecord {
  return {
    pid,
    parentPid,
    name,
    creationDate,
    executablePath: `C:\\Program Files\\Cert Prep\\${name}`,
    commandLine: `"C:\\Program Files\\Cert Prep\\${name}"`,
    workingSetBytes: null,
  };
}

async function stopTestChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await Promise.race([exited, delay(2_000)]);
}

function launchEnvironmentRun(acceptanceIsolation: boolean): SmokeRunState {
  return {
    port: 9491,
    options: {
      acceptanceIsolation,
      appDataDir: 'C:\\qa\\app-data',
      outDir: 'C:\\qa\\out',
      llmProvider: 'auto',
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
