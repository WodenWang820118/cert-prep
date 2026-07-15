import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { DocumentCancellationRunnerOptions } from './args.mts';
import {
  loadRemainingResilienceOptions,
  type DocumentCancellationOptionsLoader,
} from './remaining-options.mts';

test('remaining options preserve the base options and derive isolated Ollama inputs', async () => {
  const fixture = optionsFixture();
  try {
    let observedEnvironment: Readonly<NodeJS.ProcessEnv> | undefined;
    let observedWorkspaceRoot: string | undefined;
    const baseLoader: DocumentCancellationOptionsLoader = async (
      environment,
      workspaceRoot,
    ) => {
      observedEnvironment = environment;
      observedWorkspaceRoot = workspaceRoot;
      return fixture.baseOptions;
    };

    const options = await loadRemainingResilienceOptions(
      fixture.environment,
      fixture.baseOptions.workspaceRoot,
      baseLoader,
    );

    assert.equal(observedEnvironment, fixture.environment);
    assert.equal(observedWorkspaceRoot, fixture.baseOptions.workspaceRoot);
    for (const [key, value] of Object.entries(fixture.baseOptions)) {
      assert.deepEqual(
        options[key as keyof DocumentCancellationRunnerOptions],
        value,
      );
    }
    assert.equal(options.ollamaExePath, fixture.ollamaExePath);
    assert.equal(options.ollamaHost, '127.0.0.1:23847');
    assert.equal(
      options.ollamaModelsRoot,
      `${fixture.baseOptions.diagnosticsRoot}/ollama-models`,
    );
  } finally {
    fixture.cleanup();
  }
});

test('remaining options propagate a real document-options validation error first', async () => {
  await assert.rejects(
    loadRemainingResilienceOptions({
      CERT_PREP_RESILIENCE_OLLAMA_EXE_PATH: 'relative/ollama.exe',
      CERT_PREP_RESILIENCE_OLLAMA_PORT: '0',
    }),
    /CERT_PREP_RESILIENCE_CANDIDATE_ROOT is required/,
  );
});

test('remaining options require a canonical absolute non-reparse ollama.exe', async (t) => {
  const fixture = optionsFixture();
  try {
    await t.test('requires the environment input', async () => {
      await assert.rejects(
        loadWith(fixture, {
          ...fixture.environment,
          CERT_PREP_RESILIENCE_OLLAMA_EXE_PATH: undefined,
        }),
        /CERT_PREP_RESILIENCE_OLLAMA_EXE_PATH is required/,
      );
    });

    await t.test('rejects a relative path', async () => {
      await assert.rejects(
        loadWith(fixture, {
          ...fixture.environment,
          CERT_PREP_RESILIENCE_OLLAMA_EXE_PATH: 'ollama.exe',
        }),
        /must be an absolute path/,
      );
    });

    await t.test('rejects a path traversing a reparse point', async () => {
      const targetDirectory = join(fixture.root, 'ollama-target');
      const linkedDirectory = join(fixture.root, 'ollama-link');
      mkdirSync(targetDirectory);
      writeFileSync(join(targetDirectory, 'ollama.exe'), 'ollama');
      symlinkSync(
        targetDirectory,
        linkedDirectory,
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      await assert.rejects(
        loadWith(fixture, {
          ...fixture.environment,
          CERT_PREP_RESILIENCE_OLLAMA_EXE_PATH: join(
            linkedDirectory,
            'ollama.exe',
          ),
        }),
        /canonical non-symlink, non-reparse/,
      );
    });
  } finally {
    fixture.cleanup();
  }
});

test('remaining options require a dedicated non-default valid Ollama port', async (t) => {
  const fixture = optionsFixture();
  try {
    await t.test('does not inherit OLLAMA_HOST or port 11434', async () => {
      await assert.rejects(
        loadWith(fixture, {
          ...fixture.environment,
          CERT_PREP_RESILIENCE_OLLAMA_PORT: undefined,
          OLLAMA_HOST: '127.0.0.1:11434',
        }),
        /CERT_PREP_RESILIENCE_OLLAMA_PORT is required/,
      );
      await assert.rejects(
        loadWith(fixture, {
          ...fixture.environment,
          CERT_PREP_RESILIENCE_OLLAMA_PORT: '11434',
        }),
        /must not use Ollama's inherited\/default port 11434/,
      );
    });

    for (const value of ['0', '-1', '1.5', '65536', 'not-a-port']) {
      await t.test(`rejects ${value}`, async () => {
        await assert.rejects(
          loadWith(fixture, {
            ...fixture.environment,
            CERT_PREP_RESILIENCE_OLLAMA_PORT: value,
          }),
          /must be an integer from 1 through 65535/,
        );
      });
    }

    for (const offset of [0, 1, 2]) {
      await t.test(`rejects restart CDP port +${offset}`, async () => {
        await assert.rejects(
          loadWith(fixture, {
            ...fixture.environment,
            CERT_PREP_RESILIENCE_OLLAMA_PORT: String(
              fixture.baseOptions.cdpPort + offset,
            ),
          }),
          /must not equal any initial or restart CDP port/,
        );
      });
    }

    await t.test('requires room for two restart CDP ports', async () => {
      await assert.rejects(
        loadRemainingResilienceOptions(
          fixture.environment,
          fixture.baseOptions.workspaceRoot,
          async () => ({ ...fixture.baseOptions, cdpPort: 65_534 }),
        ),
        /must leave room for two crash restarts/,
      );
    });
  } finally {
    fixture.cleanup();
  }
});

test('remaining options reject a pre-existing derived model root', async () => {
  const fixture = optionsFixture();
  try {
    mkdirSync(fixture.baseOptions.diagnosticsRoot);
    mkdirSync(`${fixture.baseOptions.diagnosticsRoot}/ollama-models`);

    await assert.rejects(
      loadWith(fixture, fixture.environment),
      /derived Ollama models root must not exist/,
    );
  } finally {
    fixture.cleanup();
  }
});

function loadWith(
  fixture: OptionsFixture,
  environment: Readonly<NodeJS.ProcessEnv>,
) {
  return loadRemainingResilienceOptions(
    environment,
    fixture.baseOptions.workspaceRoot,
    async () => fixture.baseOptions,
  );
}

interface OptionsFixture {
  readonly root: string;
  readonly ollamaExePath: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly baseOptions: DocumentCancellationRunnerOptions;
  cleanup(): void;
}

function optionsFixture(): OptionsFixture {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'cert-prep-remaining-options-')),
  );
  const ollamaExePath = join(root, 'ollama.exe');
  writeFileSync(ollamaExePath, 'ollama');
  const outputRoot = join(root, 'output');
  const diagnosticsRoot = `${outputRoot}.diagnostics`;
  const baseOptions: DocumentCancellationRunnerOptions = {
    workspaceRoot: root,
    candidateRoot: join(root, 'candidate'),
    installedExePath: join(root, 'Cert Prep.exe'),
    pdfPath: join(root, 'input.pdf'),
    outputRoot,
    diagnosticsRoot,
    acceptanceRunId: 'acceptance-run-0001',
    candidate: {
      candidateId: 'a'.repeat(64),
      version: '0.1.0-alpha.1',
      tag: 'cert-prep-v0.1.0-alpha.1',
      commitSha: 'b'.repeat(40),
      harnessSha256: 'c'.repeat(64),
    },
    candidateDistributionProfile: 'public_unsigned_alpha',
    installation: {
      receiptPath: join(root, 'receipt.json'),
      receiptSha256: 'd'.repeat(64),
      packageKind: 'msi',
      installerRelativePath: 'release/installers/cert-prep.msi',
      installerSha256: 'e'.repeat(64),
      installedExeName: 'Cert Prep.exe',
      installedExeBytes: 123,
      installedExeSha256: 'f'.repeat(64),
      installedAt: '2026-07-14T00:00:00.000Z',
    },
    timeoutMs: 30_000,
    latePublishObservationWindowMs: 1_000,
    cdpPort: 9_591,
  };
  return {
    root,
    ollamaExePath: realpathSync.native(ollamaExePath),
    environment: {
      CERT_PREP_RESILIENCE_OLLAMA_EXE_PATH: ollamaExePath,
      CERT_PREP_RESILIENCE_OLLAMA_PORT: '23847',
    },
    baseOptions,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
