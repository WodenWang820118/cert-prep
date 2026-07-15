import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  loadInstalledCandidateBinding,
  type InstalledCandidateRunnerBinding,
} from './args.mts';
import {
  RESILIENCE_CHECKS,
  type CandidateBinding,
  type InstallationBinding,
} from './evidence-contract.mts';
import {
  buildValidResilienceEvidence,
  buildValidSessionRestartEvidence,
  FIXTURE_CANDIDATE,
  FIXTURE_INSTALLATION_BINDING,
} from './evidence-fixtures.mts';
import { verifyLocalResilienceEvidence } from './local-evidence-verifier.mts';

const DOCUMENT_CHECKS = [
  'upload',
  'ocr',
  'cancelVsCompleteRace',
  'crashRecovery',
  'partialDataRemoved',
] as const;

const REMAINING_CHECKS = [
  'draft',
  'runtime',
  'model',
  'ownedProcessesReleased',
] as const;

const WORKSPACE_ROOT = realpathSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'),
);
const VERIFIER_SCRIPT = join(
  WORKSPACE_ROOT,
  'apps',
  'cert-prep-desktop',
  'scripts',
  'packaged-resilience',
  'local-evidence-verifier.mts',
);

test('local verifier validates and hashes the exact nine checks plus session restart', async () => {
  const fixture = evidenceFixture();
  let bindingLoads = 0;
  try {
    const result = await verifyLocalResilienceEvidence(
      fixture.environment,
      fixture.workspaceRoot,
      {
        loadInstalledCandidate: async () => {
          bindingLoads += 1;
          return fixture.binding;
        },
      },
    );

    assert.equal(bindingLoads, 2);
    assert.equal(result.passed, true);
    assert.equal(result.scope, 'local_nonpublishable');
    assert.equal(
      result.candidate.candidateId,
      fixture.binding.candidate.candidateId,
    );
    assert.equal(
      result.installation.receiptSha256,
      fixture.binding.installation.receiptSha256,
    );
    assert.deepEqual(
      Object.keys(result.cancellation).sort(),
      [...RESILIENCE_CHECKS].sort(),
    );
    assert.equal(
      result.sessionRestart.sha256,
      sha256(join(fixture.remainingOutputRoot, 'session-restart.json')),
    );
    assert.equal(result.sessionRestart.path, 'remaining/session-restart.json');
  } finally {
    fixture.cleanup();
  }
});

test('local verifier rejects incomplete or undeclared evidence trees', async (t) => {
  await t.test('missing required check', async () => {
    const fixture = evidenceFixture();
    try {
      rmSync(join(fixture.documentOutputRoot, 'cancellation', 'ocr.json'));
      await assert.rejects(
        verifyFixture(fixture),
        /does not contain the exact required file set/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  await t.test('extra undeclared file', async () => {
    const fixture = evidenceFixture();
    try {
      writeFileSync(
        join(fixture.remainingOutputRoot, 'unexpected.json'),
        '{}\n',
      );
      await assert.rejects(
        verifyFixture(fixture),
        /does not contain the exact required file set/,
      );
    } finally {
      fixture.cleanup();
    }
  });
});

test('local verifier rejects evidence identity and installation drift', async (t) => {
  await t.test('acceptance run drift', async () => {
    const fixture = evidenceFixture();
    try {
      const path = join(
        fixture.documentOutputRoot,
        'cancellation',
        'upload.json',
      );
      const evidence = readJson(path);
      writeJson(path, { ...evidence, acceptanceRunId: 'acceptance-run-drift' });
      await assert.rejects(
        verifyFixture(fixture),
        /acceptanceRunId is not bound/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  await t.test('install receipt drift', async () => {
    const fixture = evidenceFixture();
    try {
      const path = join(
        fixture.remainingOutputRoot,
        'cancellation',
        'draft.json',
      );
      const evidence = readJson(path);
      const proof = evidence.proof as Record<string, unknown>;
      const installationBinding = proof.installationBinding as Record<
        string,
        unknown
      >;
      writeJson(path, {
        ...evidence,
        proof: {
          ...proof,
          installationBinding: {
            ...installationBinding,
            receiptSha256: 'a'.repeat(64),
          },
        },
      });
      await assert.rejects(
        verifyFixture(fixture),
        /installation binding does not match the current install receipt: receiptSha256/,
      );
    } finally {
      fixture.cleanup();
    }
  });
});

test('local verifier rejects a public profile and binding drift during verification', async (t) => {
  await t.test('public distribution profile', async () => {
    const fixture = evidenceFixture();
    try {
      await assert.rejects(
        verifyLocalResilienceEvidence(
          fixture.environment,
          fixture.workspaceRoot,
          {
            loadInstalledCandidate: async () => ({
              ...fixture.binding,
              candidateDistributionProfile: 'public_unsigned_alpha',
            }),
          },
        ),
        /requires a local_nonpublishable candidate/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  await t.test(
    'binding changes between initial and final validation',
    async () => {
      const fixture = evidenceFixture();
      let loads = 0;
      try {
        await assert.rejects(
          verifyLocalResilienceEvidence(
            fixture.environment,
            fixture.workspaceRoot,
            {
              loadInstalledCandidate: async () => {
                loads += 1;
                return loads === 1
                  ? fixture.binding
                  : {
                      ...fixture.binding,
                      acceptanceRunId: 'acceptance-run-reloaded',
                    };
              },
            },
          ),
          /binding changed while local resilience evidence was verified/,
        );
      } finally {
        fixture.cleanup();
      }
    },
  );
});

test('local verifier rejects unsafe or ambiguous evidence roots', async (t) => {
  await t.test('relative root', async () => {
    const fixture = evidenceFixture();
    try {
      await assert.rejects(
        verifyFixture(fixture, {
          ...fixture.environment,
          CERT_PREP_RESILIENCE_DOCUMENT_OUTPUT_ROOT: 'relative-document-run',
        }),
        /CERT_PREP_RESILIENCE_DOCUMENT_OUTPUT_ROOT must be an absolute path/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  await t.test('root outside the workspace evidence parent', async () => {
    const fixture = evidenceFixture();
    try {
      const outsideRoot = join(fixture.workspaceRoot, 'outside-document-run');
      mkdirSync(outsideRoot);
      await assert.rejects(
        verifyFixture(fixture, {
          ...fixture.environment,
          CERT_PREP_RESILIENCE_DOCUMENT_OUTPUT_ROOT: outsideRoot,
        }),
        /CERT_PREP_RESILIENCE_DOCUMENT_OUTPUT_ROOT must stay under/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  await t.test(
    'document and remaining roots resolve to the same directory',
    async () => {
      const fixture = evidenceFixture();
      try {
        await assert.rejects(
          verifyFixture(fixture, {
            ...fixture.environment,
            CERT_PREP_RESILIENCE_REMAINING_OUTPUT_ROOT:
              fixture.documentOutputRoot,
          }),
          /evidence roots must be distinct/,
        );
      } finally {
        fixture.cleanup();
      }
    },
  );
});

test('local verifier rejects linked evidence paths', async (t) => {
  await t.test(
    'directory reached through a junction or symbolic link',
    async (t) => {
      const fixture = evidenceFixture();
      try {
        const evidenceParent = join(
          fixture.workspaceRoot,
          'tmp',
          'cert-prep-desktop',
        );
        const targetParent = join(fixture.workspaceRoot, 'linked-target');
        const targetDocumentRoot = join(targetParent, 'document-run');
        const linkedParent = join(evidenceParent, 'linked-parent');
        mkdirSync(targetParent);
        renameSync(fixture.documentOutputRoot, targetDocumentRoot);
        try {
          symlinkSync(
            targetParent,
            linkedParent,
            process.platform === 'win32' ? 'junction' : 'dir',
          );
        } catch (error) {
          if (isWindowsLinkUnavailable(error)) {
            t.skip(`Directory links are unavailable: ${errorCode(error)}`);
            return;
          }
          throw error;
        }

        await assert.rejects(
          verifyFixture(fixture, {
            ...fixture.environment,
            CERT_PREP_RESILIENCE_DOCUMENT_OUTPUT_ROOT: join(
              linkedParent,
              'document-run',
            ),
          }),
          /must not traverse a reparse point or path alias/,
        );
      } finally {
        fixture.cleanup();
      }
    },
  );

  await t.test('symbolic-link evidence file', async (t) => {
    const fixture = evidenceFixture();
    try {
      const uploadPath = join(
        fixture.documentOutputRoot,
        'cancellation',
        'upload.json',
      );
      const targetPath = join(fixture.workspaceRoot, 'linked-upload.json');
      renameSync(uploadPath, targetPath);
      try {
        symlinkSync(targetPath, uploadPath, 'file');
      } catch (error) {
        if (isWindowsLinkUnavailable(error)) {
          t.skip(`File symbolic links are unavailable: ${errorCode(error)}`);
          return;
        }
        throw error;
      }

      await assert.rejects(
        verifyFixture(fixture),
        /upload\.json must be a canonical non-symlink file/,
      );
    } finally {
      fixture.cleanup();
    }
  });
});

test('local verifier CLI reports missing environment through its process contract', () => {
  const result = spawnSync(process.execPath, [VERIFIER_SCRIPT], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    env: {},
    windowsHide: true,
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(
    result.stderr,
    /CERT_PREP_RESILIENCE_CANDIDATE_ROOT is required/,
  );
});

test('local verifier CLI prints successful verification JSON', async () => {
  const fixture = await cliEvidenceFixture();
  try {
    const result = spawnSync(process.execPath, [VERIFIER_SCRIPT], {
      cwd: WORKSPACE_ROOT,
      encoding: 'utf8',
      env: { ...process.env, ...fixture.environment },
      windowsHide: true,
    });

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(report.passed, true);
    assert.equal(report.scope, 'local_nonpublishable');
    assert.equal(report.acceptanceRunId, 'acceptance-run-0001');
    assert.deepEqual(
      Object.keys(report.cancellation as Record<string, unknown>).sort(),
      [...RESILIENCE_CHECKS].sort(),
    );
    assert.equal(
      (report.sessionRestart as Record<string, unknown>).sha256,
      sha256(join(fixture.remainingOutputRoot, 'session-restart.json')),
    );
  } finally {
    fixture.cleanup();
  }
});

interface EvidenceFixture {
  readonly workspaceRoot: string;
  readonly documentOutputRoot: string;
  readonly remainingOutputRoot: string;
  readonly environment: Record<string, string>;
  readonly binding: InstalledCandidateRunnerBinding;
  cleanup(): void;
}

interface CliEvidenceFixture {
  readonly environment: Record<string, string>;
  readonly remainingOutputRoot: string;
  cleanup(): void;
}

function evidenceFixture(): EvidenceFixture {
  const workspaceRoot = realpathSync(
    mkdtempSync(join(tmpdir(), 'cert-prep-local-evidence-')),
  );
  const evidenceParent = join(workspaceRoot, 'tmp', 'cert-prep-desktop');
  const documentOutputRoot = join(evidenceParent, 'document-run');
  const remainingOutputRoot = join(evidenceParent, 'remaining-run');
  const documentCancellationRoot = join(documentOutputRoot, 'cancellation');
  const remainingCancellationRoot = join(remainingOutputRoot, 'cancellation');
  mkdirSync(documentCancellationRoot, { recursive: true });
  mkdirSync(remainingCancellationRoot, { recursive: true });

  const candidate = {
    ...FIXTURE_CANDIDATE,
    tag: `cert-prep-local-v${FIXTURE_CANDIDATE.version}-${FIXTURE_CANDIDATE.commitSha.slice(0, 12)}`,
  };
  for (const check of DOCUMENT_CHECKS) {
    writeJson(
      join(documentCancellationRoot, `${check}.json`),
      buildValidResilienceEvidence(check, { candidate }),
    );
  }
  for (const check of REMAINING_CHECKS) {
    writeJson(
      join(remainingCancellationRoot, `${check}.json`),
      buildValidResilienceEvidence(check, { candidate }),
    );
  }
  writeJson(
    join(remainingOutputRoot, 'session-restart.json'),
    buildValidSessionRestartEvidence({ candidate }),
  );

  const candidateRoot = join(workspaceRoot, 'candidate');
  const installedExePath = join(workspaceRoot, 'Cert Prep.exe');
  const receiptPath = join(workspaceRoot, 'install-receipt.json');
  mkdirSync(candidateRoot);
  writeFileSync(installedExePath, 'installed executable');
  writeJson(receiptPath, { fixture: true });
  const binding: InstalledCandidateRunnerBinding = {
    workspaceRoot,
    candidateRoot,
    installedExePath,
    acceptanceRunId: 'acceptance-run-0001',
    candidate,
    candidateDistributionProfile: 'local_nonpublishable',
    installation: {
      receiptPath,
      ...FIXTURE_INSTALLATION_BINDING,
    },
  };

  return {
    workspaceRoot,
    documentOutputRoot,
    remainingOutputRoot,
    binding,
    environment: {
      CERT_PREP_RESILIENCE_DOCUMENT_OUTPUT_ROOT: documentOutputRoot,
      CERT_PREP_RESILIENCE_REMAINING_OUTPUT_ROOT: remainingOutputRoot,
    },
    cleanup() {
      rmSync(workspaceRoot, { recursive: true, force: true });
    },
  };
}

async function cliEvidenceFixture(): Promise<CliEvidenceFixture> {
  const evidenceParent = join(WORKSPACE_ROOT, 'tmp', 'cert-prep-desktop');
  mkdirSync(evidenceParent, { recursive: true });
  const fixtureRoot = realpathSync(
    mkdtempSync(join(evidenceParent, 'local-evidence-cli-')),
  );
  const candidateRoot = join(fixtureRoot, 'candidate');
  const releaseMetadataRoot = join(candidateRoot, 'release', 'metadata');
  const releaseInstallerRoot = join(candidateRoot, 'release', 'installers');
  const harnessRoot = join(candidateRoot, 'harness');
  mkdirSync(releaseMetadataRoot, { recursive: true });
  mkdirSync(releaseInstallerRoot, { recursive: true });
  mkdirSync(harnessRoot, { recursive: true });

  const version = FIXTURE_CANDIDATE.version;
  const commitSha = FIXTURE_CANDIDATE.commitSha;
  const repository = 'local/nonpublishable';
  const tag = `cert-prep-local-v${version}-${commitSha.slice(0, 12)}`;
  writeJson(join(releaseMetadataRoot, 'release-plan.json'), {
    version,
    tag,
    commitSha,
    repository,
    target: 'x86_64-pc-windows-msvc',
    signed: false,
    channel: 'local_nonpublishable',
    distributionProfile: 'local_nonpublishable',
    publishable: false,
    assetBaseUrl: pathToFileURL(join(candidateRoot, 'local-assets')).href,
  });
  const installerRelativePath =
    'release/installers/Cert Prep_0.1.0-alpha.1_x64_en-US.msi';
  const installerPath = join(
    candidateRoot,
    ...installerRelativePath.split('/'),
  );
  writeFileSync(installerPath, 'candidate installer payload');
  writeFileSync(join(harnessRoot, 'harness.txt'), 'pinned harness payload\n');
  const identities = [
    ...candidateFiles(join(candidateRoot, 'release'), 'release'),
    ...candidateFiles(harnessRoot, 'harness'),
  ].sort();
  const candidateId = createHash('sha256')
    .update(identities.join('\n'))
    .digest('hex');
  writeJson(join(candidateRoot, 'candidate.json'), {
    schemaVersion: 1,
    candidateId,
    files: identities,
    version,
    tag,
    repository,
    commitSha,
    distributionProfile: 'local_nonpublishable',
    publishable: false,
  });

  const installedExePath = join(fixtureRoot, 'Cert Prep.exe');
  writeFileSync(installedExePath, 'installed candidate executable');
  const receiptPath = join(fixtureRoot, 'install-receipt.json');
  writeJson(receiptPath, {
    schemaVersion: 1,
    candidateId,
    acceptanceRunId: 'acceptance-run-0001',
    harnessSha256: FIXTURE_CANDIDATE.harnessSha256,
    packageKind: 'msi',
    installer: {
      relativePath: installerRelativePath,
      sha256: sha256(installerPath),
    },
    installedExecutable: {
      path: realpathSync(installedExePath),
      name: 'Cert Prep.exe',
      bytes: statSync(installedExePath).size,
      sha256: sha256(installedExePath),
    },
    freshInstallVerified: true,
    installerExitCode: 0,
    installedAt: FIXTURE_INSTALLATION_BINDING.installedAt,
  });

  const environment = {
    CERT_PREP_RESILIENCE_CANDIDATE_ROOT: candidateRoot,
    CERT_PREP_RELEASE_CANDIDATE_ID: candidateId,
    ALPHA_HARDWARE_HARNESS_SHA256: FIXTURE_CANDIDATE.harnessSha256,
    CERT_PREP_RESILIENCE_INSTALLED_EXE_PATH: installedExePath,
    CERT_PREP_RESILIENCE_INSTALL_RECEIPT_PATH: receiptPath,
    CERT_PREP_RESILIENCE_ACCEPTANCE_RUN_ID: 'acceptance-run-0001',
  };
  const binding = await loadInstalledCandidateBinding(
    environment,
    WORKSPACE_ROOT,
  );
  const documentOutputRoot = join(fixtureRoot, 'document-run');
  const remainingOutputRoot = join(fixtureRoot, 'remaining-run');
  writeEvidenceTrees(
    documentOutputRoot,
    remainingOutputRoot,
    binding.candidate,
    binding.installation,
  );

  return {
    remainingOutputRoot,
    environment: {
      ...environment,
      CERT_PREP_RESILIENCE_DOCUMENT_OUTPUT_ROOT: documentOutputRoot,
      CERT_PREP_RESILIENCE_REMAINING_OUTPUT_ROOT: remainingOutputRoot,
    },
    cleanup() {
      rmSync(fixtureRoot, { recursive: true, force: true });
    },
  };
}

function verifyFixture(
  fixture: EvidenceFixture,
  environment: Readonly<NodeJS.ProcessEnv> = fixture.environment,
) {
  return verifyLocalResilienceEvidence(environment, fixture.workspaceRoot, {
    loadInstalledCandidate: async () => fixture.binding,
  });
}

function writeEvidenceTrees(
  documentOutputRoot: string,
  remainingOutputRoot: string,
  candidate: CandidateBinding,
  installation: InstallationBinding,
): void {
  const documentCancellationRoot = join(documentOutputRoot, 'cancellation');
  const remainingCancellationRoot = join(remainingOutputRoot, 'cancellation');
  mkdirSync(documentCancellationRoot, { recursive: true });
  mkdirSync(remainingCancellationRoot, { recursive: true });
  for (const check of DOCUMENT_CHECKS) {
    writeJson(
      join(documentCancellationRoot, `${check}.json`),
      withInstallationBinding(
        buildValidResilienceEvidence(check, { candidate }),
        installation,
      ),
    );
  }
  for (const check of REMAINING_CHECKS) {
    writeJson(
      join(remainingCancellationRoot, `${check}.json`),
      withInstallationBinding(
        buildValidResilienceEvidence(check, { candidate }),
        installation,
      ),
    );
  }
  writeJson(
    join(remainingOutputRoot, 'session-restart.json'),
    withInstallationBinding(
      buildValidSessionRestartEvidence({ candidate }),
      installation,
    ),
  );
}

function withInstallationBinding(
  evidence: Record<string, unknown>,
  installation: InstallationBinding,
): Record<string, unknown> {
  return {
    ...evidence,
    proof: {
      ...(evidence.proof as Record<string, unknown>),
      installationBinding: installation,
    },
  };
}

function candidateFiles(root: string, prefix: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && statSync(path).isFile()) {
        const relativePath = relative(root, path).replaceAll('\\', '/');
        files.push(`${prefix}/${relativePath}:${sha256(path)}`);
      }
    }
  };
  visit(root);
  return files;
}

function isWindowsLinkUnavailable(error: unknown): boolean {
  return (
    process.platform === 'win32' &&
    ['EACCES', 'ENOSYS', 'ENOTSUP', 'EPERM'].includes(errorCode(error))
  );
}

function errorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return 'unknown';
  }
  return String(error.code);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
