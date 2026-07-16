import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  assertFreshInstallPreconditions,
  knownCertPrepInstallRoots,
  nsisInstallArguments,
  nsisManufacturerRegistryPath,
  resolveWindowsPowerShellExecutable,
  runLocalInstallAcceptance,
  writeJsonAtomically,
  type HostInstallState,
} from './local-install-acceptance.ts';
import { LOCAL_NONPUBLISHABLE_PROFILE, sha256File } from './release-lib.ts';

const COMMIT_SHA = 'a'.repeat(40);
const VERSION = '0.1.0-alpha.1';
const EMPTY_HOST_STATE: HostInstallState = {
  uninstallEntries: [],
  manufacturerKeyExists: false,
  manufacturerInstallLocation: '',
  runningProcesses: [],
  existingInstallRoots: [],
};

test('dry run validates the exact candidate without installing or writing output', async () => {
  await withFixture(async (fixture) => {
    let installerCalls = 0;
    const result = await runLocalInstallAcceptance(
      {
        'workspace-root': fixture.workspaceRoot,
        'candidate-root': fixture.candidateRoot,
        'output-root': fixture.outputRoot,
        'acceptance-run-id': 'acceptance-dry-run-0001',
        'dry-run': 'true',
      },
      fixture.dependencies({
        runInstaller: () => {
          installerCalls += 1;
          return { exitCode: 0 };
        },
      }),
    );

    assert.equal(result.mode, 'dry-run');
    assert.equal(result.candidateId, fixture.candidate.candidateId);
    assert.equal(result.harnessSha256, fixture.harnessSha256);
    assert.equal(installerCalls, 0);
    assert.equal(existsSync(fixture.outputRoot), false);
  });
});

test('installs NSIS into an isolated root and writes an exact atomic receipt', async () => {
  await withFixture(async (fixture) => {
    let installed = false;
    const resolvedPowerShell =
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const inspectedWith: string[] = [];
    const now = new Date('2026-07-15T08:30:00.000Z');
    const dependencies = fixture.dependencies({
      resolvePowerShellExecutable: () => resolvedPowerShell,
      inspectHostState: (_knownInstallRoots, powershellExecutable) => {
        inspectedWith.push(powershellExecutable);
        return installed ? fixture.installedHostState() : EMPTY_HOST_STATE;
      },
      runInstaller: (installerPath, installRoot) => {
        assert.equal(installerPath, fixture.installerPath);
        assert.equal(installRoot, fixture.installRoot);
        mkdirSync(installRoot, { recursive: true });
        writeFileSync(
          join(installRoot, 'cert-prep-desktop.exe'),
          'installed-exe',
        );
        installed = true;
        return { exitCode: 0 };
      },
      now: () => now,
    });

    const result = await runLocalInstallAcceptance(
      {
        'workspace-root': fixture.workspaceRoot,
        'candidate-root': fixture.candidateRoot,
        'output-root': fixture.outputRoot,
        'acceptance-run-id': 'acceptance-install-0001',
      },
      dependencies,
    );

    assert.equal(result.mode, 'installed');
    assert.equal(result.installedExePath, fixture.installedExePath);
    assert.equal(result.installReceiptPath, fixture.receiptPath);
    assert.deepEqual(inspectedWith, [resolvedPowerShell, resolvedPowerShell]);
    assert.deepEqual(result.resilienceEnvironment, {
      CERT_PREP_RESILIENCE_CANDIDATE_ROOT: fixture.candidateRoot,
      CERT_PREP_RELEASE_CANDIDATE_ID: fixture.candidate.candidateId,
      CERT_PREP_ACCEPTANCE_HARNESS_SHA256: fixture.harnessSha256,
      CERT_PREP_RESILIENCE_INSTALLED_EXE_PATH: fixture.installedExePath,
      CERT_PREP_RESILIENCE_INSTALL_RECEIPT_PATH: fixture.receiptPath,
      CERT_PREP_RESILIENCE_ACCEPTANCE_RUN_ID: 'acceptance-install-0001',
    });

    const receipt = JSON.parse(readFileSync(fixture.receiptPath, 'utf8'));
    assert.deepEqual(receipt, {
      schemaVersion: 1,
      candidateId: fixture.candidate.candidateId,
      acceptanceRunId: 'acceptance-install-0001',
      harnessSha256: fixture.harnessSha256,
      packageKind: 'nsis',
      installer: {
        relativePath: fixture.installerRelativePath,
        sha256: fixture.installerSha256,
      },
      installedExecutable: {
        path: fixture.installedExePath,
        name: 'cert-prep-desktop.exe',
        bytes: 13,
        sha256: await sha256File(fixture.installedExePath),
      },
      freshInstallVerified: true,
      installerExitCode: 0,
      installedAt: now.toISOString(),
    });
    assert.deepEqual(readdirSync(fixture.outputRoot).sort(), [
      'install-receipt.json',
      'installed',
    ]);
  });
});

test('fails closed before installation when fresh-install state exists', async () => {
  const blockerStates: Array<[string, HostInstallState]> = [
    [
      'uninstall entry',
      {
        ...EMPTY_HOST_STATE,
        uninstallEntries: [
          {
            hive: 'HKCU',
            key: 'Cert Prep',
            displayName: 'Cert Prep',
            displayVersion: VERSION,
            publisher: 'certprep',
            installLocation: 'C:\\existing',
            mainBinaryName: 'cert-prep-desktop.exe',
            uninstallString: 'C:\\existing\\uninstall.exe',
          },
        ],
      },
    ],
    [
      'uninstall entry',
      {
        ...EMPTY_HOST_STATE,
        uninstallEntries: [
          {
            hive: 'HKCU',
            key: 'Cert Prep',
            displayName: 'Drifted display name',
            displayVersion: '',
            publisher: '',
            installLocation: '',
            mainBinaryName: '',
            uninstallString: 'C:\\stale\\uninstall.exe',
          },
        ],
      },
    ],
    [
      'manufacturer registry key',
      { ...EMPTY_HOST_STATE, manufacturerKeyExists: true },
    ],
    [
      'running process',
      {
        ...EMPTY_HOST_STATE,
        runningProcesses: [
          {
            processId: 123,
            name: 'cert-prep-desktop.exe',
            executablePath: 'C:\\existing\\cert-prep-desktop.exe',
          },
        ],
      },
    ],
    [
      'existing install root',
      { ...EMPTY_HOST_STATE, existingInstallRoots: ['C:\\existing'] },
    ],
  ];

  for (const [label, state] of blockerStates) {
    assert.throws(
      () => assertFreshInstallPreconditions(state),
      new RegExp(label),
    );
  }
});

test('rejects workspace HEAD and executing-harness mismatches', async () => {
  await withFixture(async (fixture) => {
    await assert.rejects(
      () =>
        runLocalInstallAcceptance(
          {
            'workspace-root': fixture.workspaceRoot,
            'candidate-root': fixture.candidateRoot,
            'output-root': fixture.outputRoot,
            'dry-run': 'true',
          },
          fixture.dependencies({ readWorkspaceHead: () => 'b'.repeat(40) }),
        ),
      /Workspace HEAD does not match/,
    );

    const otherHarness = join(fixture.workspaceRoot, 'other-harness.ts');
    writeFileSync(otherHarness, 'export {};\n');
    await assert.rejects(
      () =>
        runLocalInstallAcceptance(
          {
            'workspace-root': fixture.workspaceRoot,
            'candidate-root': fixture.candidateRoot,
            'output-root': fixture.outputRoot,
            'dry-run': 'true',
          },
          fixture.dependencies({ executingHarnessPath: otherHarness }),
        ),
      /must execute the harness copied into the exact candidate/,
    );
  });
});

test('rejects a public or hybrid candidate before invoking the installer', async () => {
  await withFixture(async (fixture) => {
    const candidatePath = join(fixture.candidateRoot, 'candidate.json');
    const candidate = JSON.parse(readFileSync(candidatePath, 'utf8'));
    writeFileSync(
      candidatePath,
      `${JSON.stringify({ ...candidate, publishable: true }, null, 2)}\n`,
    );
    let installerCalls = 0;
    await assert.rejects(
      () =>
        runLocalInstallAcceptance(
          {
            'workspace-root': fixture.workspaceRoot,
            'candidate-root': fixture.candidateRoot,
            'output-root': fixture.outputRoot,
          },
          fixture.dependencies({
            runInstaller: () => {
              installerCalls += 1;
              return { exitCode: 0 };
            },
          }),
        ),
      /requires a valid local_nonpublishable candidate identity/,
    );
    assert.equal(installerCalls, 0);
  });
});

test('does not issue a receipt when installer or HKCU verification fails', async () => {
  await withFixture(async (fixture) => {
    await assert.rejects(
      () =>
        runLocalInstallAcceptance(
          {
            'workspace-root': fixture.workspaceRoot,
            'candidate-root': fixture.candidateRoot,
            'output-root': fixture.outputRoot,
          },
          fixture.dependencies({ runInstaller: () => ({ exitCode: 7 }) }),
        ),
      /exit code 7/,
    );
    assert.equal(existsSync(fixture.receiptPath), false);
  });

  await withFixture(async (fixture) => {
    let installed = false;
    await assert.rejects(
      () =>
        runLocalInstallAcceptance(
          {
            'workspace-root': fixture.workspaceRoot,
            'candidate-root': fixture.candidateRoot,
            'output-root': fixture.outputRoot,
          },
          fixture.dependencies({
            inspectHostState: () =>
              installed
                ? fixture.installedHostState('C:\\wrong-location')
                : EMPTY_HOST_STATE,
            runInstaller: (_installerPath, installRoot) => {
              mkdirSync(installRoot, { recursive: true });
              writeFileSync(
                join(installRoot, 'cert-prep-desktop.exe'),
                'installed-exe',
              );
              installed = true;
              return { exitCode: 0 };
            },
          }),
        ),
      /HKCU uninstall metadata does not match/,
    );
    assert.equal(existsSync(fixture.receiptPath), false);
  });
});

test('atomic receipt creation refuses replacement and leaves no scratch file', () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-install-receipt-'));
  try {
    const receiptPath = join(root, 'install-receipt.json');
    writeJsonAtomically(receiptPath, { schemaVersion: 1 }, () => 'first');
    assert.equal(
      readFileSync(receiptPath, 'utf8'),
      '{\n  "schemaVersion": 1\n}\n',
    );
    assert.throws(
      () =>
        writeJsonAtomically(receiptPath, { schemaVersion: 2 }, () => 'second'),
      /already exists/,
    );
    assert.deepEqual(readdirSync(root), ['install-receipt.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('NSIS arguments keep the isolated install root last', () => {
  const installRoot = resolve('C:\\cert-prep-acceptance\\installed');
  assert.deepEqual(nsisInstallArguments(installRoot), [
    '/S',
    '/NS',
    `/D=${installRoot}`,
  ]);
});

test('fresh-install roots include current and legacy per-user locations', () => {
  assert.deepEqual(
    knownCertPrepInstallRoots({
      LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    }),
    [
      resolve('C:\\Users\\tester\\AppData\\Local\\Cert Prep'),
      resolve('C:\\Users\\tester\\AppData\\Local\\Programs\\Cert Prep'),
      resolve('C:\\Program Files\\Cert Prep'),
      resolve('C:\\Program Files (x86)\\Cert Prep'),
    ],
  );
});

test('manufacturer registry contract matches the rendered Tauri NSIS value', () => {
  assert.equal(
    nsisManufacturerRegistryPath(),
    'HKCU:\\Software\\certprep\\Cert Prep',
  );
});

test('NSIS final uninstall removes only the product metadata key and an empty parent', () => {
  const workspaceRoot = resolve(fileURLToPath(import.meta.url), '../../..');
  const tauriRoot = join(
    workspaceRoot,
    'apps',
    'cert-prep-desktop',
    'src-tauri',
  );
  const config = JSON.parse(
    readFileSync(join(tauriRoot, 'tauri.conf.json'), 'utf8'),
  ) as {
    readonly bundle?: {
      readonly windows?: {
        readonly nsis?: { readonly installerHooks?: string };
      };
    };
  };
  const configuredHook = config.bundle?.windows?.nsis?.installerHooks;

  assert.equal(configuredHook, 'nsis/installer-hooks.nsh');
  const hook = readFileSync(join(tauriRoot, configuredHook), 'utf8');
  const instructions = hook
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith(';'));
  assert.deepEqual(instructions, [
    '!macro NSIS_HOOK_POSTUNINSTALL',
    '${If} $UpdateMode <> 1',
    'DeleteRegKey SHCTX "${MANUPRODUCTKEY}"',
    'DeleteRegKey /ifempty SHCTX "${MANUKEY}"',
    '${EndIf}',
    '!macroend',
  ]);
});

test('PowerShell resolver uses canonical SystemRoot executable with a reduced PATH', () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-powershell-resolver-'));
  try {
    const systemRoot = join(root, 'Windows');
    const executable = join(
      systemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    mkdirSync(dirname(executable), { recursive: true });
    writeFileSync(executable, 'fixture Windows PowerShell executable');

    assert.equal(
      resolveWindowsPowerShellExecutable({ SystemRoot: systemRoot, PATH: '' }),
      realpathSync(executable),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PowerShell resolver fails closed without a canonical executable', () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-powershell-missing-'));
  try {
    assert.throws(
      () =>
        resolveWindowsPowerShellExecutable({
          SystemRoot: join(root, 'missing'),
          PATH: '',
        }),
      /Unable to resolve a canonical Windows PowerShell executable/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('candidate-copied harness starts without workspace module imports', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-candidate-harness-'));
  try {
    const candidateRoot = join(root, 'candidate');
    const sourceHarnessPath = fileURLToPath(
      new URL('./local-install-acceptance.ts', import.meta.url),
    );
    await writeCandidate(candidateRoot, {
      harnessSource: readFileSync(sourceHarnessPath, 'utf8'),
    });
    const candidateHarnessPath = join(
      candidateRoot,
      'harness',
      'tools',
      'release',
      'local-install-acceptance.ts',
    );
    const workspaceRoot = resolve(fileURLToPath(import.meta.url), '../../..');
    const outputRoot = join(
      workspaceRoot,
      'tmp',
      'cert-prep-desktop',
      `candidate-copy-startup-${process.pid}`,
    );
    const invocation = spawnSync(
      process.execPath,
      [
        candidateHarnessPath,
        '--workspace-root',
        workspaceRoot,
        '--candidate-root',
        candidateRoot,
        '--output-root',
        outputRoot,
        '--dry-run',
        'true',
      ],
      { encoding: 'utf8', windowsHide: true },
    );

    assert.equal(invocation.status, 1);
    assert.match(String(invocation.stderr), /Workspace HEAD does not match/);
    assert.doesNotMatch(String(invocation.stderr), /ERR_MODULE_NOT_FOUND/);
    assert.equal(existsSync(outputRoot), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Fixture {
  readonly workspaceRoot: string;
  readonly candidateRoot: string;
  readonly outputRoot: string;
  readonly installRoot: string;
  readonly receiptPath: string;
  readonly installedExePath: string;
  readonly installerPath: string;
  readonly installerRelativePath: string;
  readonly installerSha256: string;
  readonly harnessPath: string;
  readonly harnessSha256: string;
  readonly candidate: {
    readonly candidateId: string;
  };
  readonly dependencies: (
    overrides?: Record<string, unknown>,
  ) => Parameters<typeof runLocalInstallAcceptance>[1];
  readonly installedHostState: (installLocation?: string) => HostInstallState;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-local-install-'));
  try {
    const workspaceRoot = resolve(root, 'workspace');
    mkdirSync(workspaceRoot, { recursive: true });
    const candidateRoot = resolve(
      workspaceRoot,
      'tmp',
      'local-alpha-candidate',
    );
    const candidate = await writeCandidate(candidateRoot);
    const outputRoot = resolve(
      workspaceRoot,
      'tmp',
      'cert-prep-desktop',
      'local-install-acceptance',
    );
    const installRoot = join(outputRoot, 'installed');
    const harnessPath = join(
      candidateRoot,
      'harness',
      'tools',
      'release',
      'local-install-acceptance.ts',
    );
    const installerRelativePath =
      'release/installers/Cert Prep_0.1.0-alpha.1_x64-setup.exe';
    const installerPath = resolve(
      candidateRoot,
      ...installerRelativePath.split('/'),
    );
    const installedExePath = join(installRoot, 'cert-prep-desktop.exe');
    const receiptPath = join(outputRoot, 'install-receipt.json');
    const baseDependencies = {
      platform: 'win32' as const,
      executingHarnessPath: harnessPath,
      readWorkspaceHead: () => COMMIT_SHA,
      resolvePowerShellExecutable: () =>
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      inspectHostState: () => EMPTY_HOST_STATE,
      runInstaller: () => {
        throw new Error('Test unexpectedly invoked the installer.');
      },
      now: () => new Date('2026-07-15T00:00:00.000Z'),
      newRunId: () => 'acceptance-generated-0001',
      newTempId: () => 'receipt-temp-0001',
    };
    const installedHostState = (
      installLocation = installRoot,
    ): HostInstallState => ({
      uninstallEntries: [
        {
          hive: 'HKCU',
          key: 'Cert Prep',
          displayName: 'Cert Prep',
          displayVersion: VERSION,
          publisher: 'certprep',
          installLocation: `"${installLocation}"`,
          mainBinaryName: 'cert-prep-desktop.exe',
          uninstallString: `"${join(installLocation, 'uninstall.exe')}"`,
        },
      ],
      manufacturerKeyExists: true,
      manufacturerInstallLocation: installLocation,
      runningProcesses: [],
      existingInstallRoots: [],
    });
    await run({
      workspaceRoot,
      candidateRoot,
      outputRoot,
      installRoot,
      receiptPath,
      installedExePath,
      installerPath,
      installerRelativePath,
      installerSha256: await sha256File(installerPath),
      harnessPath,
      harnessSha256: await sha256File(harnessPath),
      candidate,
      dependencies: (overrides = {}) =>
        ({
          ...baseDependencies,
          ...overrides,
        }) as Parameters<typeof runLocalInstallAcceptance>[1],
      installedHostState,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function writeCandidate(
  root: string,
  {
    harnessSource = 'export const candidateHarness = true;\n',
    commitSha = COMMIT_SHA,
  }: { readonly harnessSource?: string; readonly commitSha?: string } = {},
) {
  const releasePlanPath = join(
    root,
    'release',
    'metadata',
    'release-plan.json',
  );
  const installerPath = join(
    root,
    'release',
    'installers',
    'Cert Prep_0.1.0-alpha.1_x64-setup.exe',
  );
  const harnessPath = join(
    root,
    'harness',
    'tools',
    'release',
    'local-install-acceptance.ts',
  );
  mkdirSync(join(root, 'release', 'metadata'), { recursive: true });
  mkdirSync(join(root, 'release', 'installers'), { recursive: true });
  mkdirSync(join(root, 'harness', 'tools', 'release'), { recursive: true });
  const plan = {
    schemaVersion: 1,
    channel: LOCAL_NONPUBLISHABLE_PROFILE,
    version: VERSION,
    tag: `cert-prep-local-v${VERSION}-${commitSha.slice(0, 12)}`,
    repository: 'local/nonpublishable',
    commitSha,
    target: 'x86_64-pc-windows-msvc',
    assetBaseUrl: pathToFileURL(join(root, 'local-ocr-runtime')).href,
    signed: false,
    distributionProfile: LOCAL_NONPUBLISHABLE_PROFILE,
    publishable: false,
  };
  writeFileSync(releasePlanPath, `${JSON.stringify(plan, null, 2)}\n`);
  writeFileSync(installerPath, 'fake-nsis-installer');
  writeFileSync(harnessPath, harnessSource);
  const files = [
    `harness/tools/release/local-install-acceptance.ts:${await sha256File(harnessPath)}`,
    `release/installers/${basename(installerPath)}:${await sha256File(installerPath)}`,
    `release/metadata/release-plan.json:${await sha256File(releasePlanPath)}`,
  ].sort();
  const candidateId = createHash('sha256')
    .update(files.join('\n'))
    .digest('hex');
  const candidate = {
    schemaVersion: 1,
    candidateId,
    version: VERSION,
    tag: `cert-prep-local-v${VERSION}-${commitSha.slice(0, 12)}`,
    repository: 'local/nonpublishable',
    commitSha,
    distributionProfile: LOCAL_NONPUBLISHABLE_PROFILE,
    publishable: false,
    files,
  };
  writeFileSync(
    join(root, 'candidate.json'),
    `${JSON.stringify(candidate, null, 2)}\n`,
  );
  return candidate;
}
