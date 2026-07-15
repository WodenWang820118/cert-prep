import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  loadDocumentCancellationOptions,
  loadInstalledCandidateBinding,
} from './args.mts';

test('document cancellation options verify the exact candidate and required files', async () => {
  const fixture = fixtureWorkspace();
  try {
    const options = await loadDocumentCancellationOptions(
      fixture.environment,
      fixture.workspaceRoot,
    );

    assert.equal(options.candidate.candidateId, fixture.candidateId);
    assert.equal(options.candidate.version, '0.1.0-alpha.1');
    assert.equal(options.candidate.tag, 'cert-prep-v0.1.0-alpha.1');
    assert.equal(options.candidate.commitSha, 'a'.repeat(40));
    assert.equal(options.candidate.harnessSha256, 'b'.repeat(64));
    assert.equal(options.candidateDistributionProfile, 'public_unsigned_alpha');
    assert.equal(options.acceptanceRunId, 'acceptance-run-0001');
    assert.equal(options.diagnosticsRoot, `${fixture.outputRoot}.diagnostics`);
    assert.equal(options.installation.packageKind, 'msi');
    assert.equal(
      options.installation.installerRelativePath,
      'release/installers/Cert Prep_0.1.0-alpha.1_x64_en-US.msi',
    );
    assert.equal(options.installation.installedExeName, 'Cert Prep.exe');
    assert.equal(options.installation.installedAt, '2026-07-14T00:00:00.000Z');
  } finally {
    fixture.cleanup();
  }
});

test('document cancellation options accept the exact local nonpublishable candidate pair', async () => {
  const fixture = fixtureWorkspace({ profile: 'local_nonpublishable' });
  try {
    const options = await loadDocumentCancellationOptions(
      fixture.environment,
      fixture.workspaceRoot,
    );

    assert.equal(options.candidateDistributionProfile, 'local_nonpublishable');
    assert.equal(
      options.candidate.tag,
      `cert-prep-local-v0.1.0-alpha.1-${'a'.repeat(12)}`,
    );
  } finally {
    fixture.cleanup();
  }
});

test('installed candidate binding can be revalidated after runner output exists', async () => {
  const fixture = fixtureWorkspace({ profile: 'local_nonpublishable' });
  try {
    mkdirSync(fixture.outputRoot);
    const environment = { ...fixture.environment };
    delete environment.CERT_PREP_RESILIENCE_PDF_PATH;
    delete environment.CERT_PREP_RESILIENCE_OUTPUT_ROOT;

    const binding = await loadInstalledCandidateBinding(
      environment,
      fixture.workspaceRoot,
    );

    assert.equal(binding.candidate.candidateId, fixture.candidateId);
    assert.equal(binding.candidateDistributionProfile, 'local_nonpublishable');
    assert.equal(binding.installedExePath, fixture.installedExePath);
    assert.equal(binding.installation.receiptPath, fixture.receiptPath);
  } finally {
    fixture.cleanup();
  }
});

test('document cancellation options reject hybrid and malformed distribution identities', async (t) => {
  await t.test('candidate profile does not match its public plan', async () => {
    const fixture = fixtureWorkspace({
      candidateOverrides: {
        distributionProfile: 'local_nonpublishable',
        publishable: false,
      },
    });
    try {
      await assert.rejects(
        loadDocumentCancellationOptions(
          fixture.environment,
          fixture.workspaceRoot,
        ),
        /Candidate identity does not match release plan: distributionProfile/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  await t.test('public plan is not publishable', async () => {
    const fixture = fixtureWorkspace({
      planOverrides: { publishable: false },
      candidateOverrides: { publishable: false },
    });
    try {
      await assert.rejects(
        loadDocumentCancellationOptions(
          fixture.environment,
          fixture.workspaceRoot,
        ),
        /exact supported distribution profile/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  await t.test('public asset base URL does not match its repository and tag', async () => {
    const fixture = fixtureWorkspace({
      planOverrides: { assetBaseUrl: 'https://example.invalid/releases' },
    });
    try {
      await assert.rejects(
        loadDocumentCancellationOptions(
          fixture.environment,
          fixture.workspaceRoot,
        ),
        /exact supported distribution profile/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  await t.test('local tag is not bound to the candidate commit SHA', async () => {
    const fixture = fixtureWorkspace({
      profile: 'local_nonpublishable',
      planOverrides: {
        tag: 'cert-prep-local-v0.1.0-alpha.1-deadbeefdead',
      },
      candidateOverrides: {
        tag: 'cert-prep-local-v0.1.0-alpha.1-deadbeefdead',
      },
    });
    try {
      await assert.rejects(
        loadDocumentCancellationOptions(
          fixture.environment,
          fixture.workspaceRoot,
        ),
        /exact supported distribution profile/,
      );
    } finally {
      fixture.cleanup();
    }
  });
});

test('document cancellation options require every candidate-bound input', async (t) => {
  const fixture = fixtureWorkspace();
  try {
    for (const name of [
      'CERT_PREP_RESILIENCE_CANDIDATE_ROOT',
      'CERT_PREP_RELEASE_CANDIDATE_ID',
      'ALPHA_HARDWARE_HARNESS_SHA256',
      'CERT_PREP_RESILIENCE_INSTALLED_EXE_PATH',
      'CERT_PREP_RESILIENCE_INSTALL_RECEIPT_PATH',
      'CERT_PREP_RESILIENCE_PDF_PATH',
      'CERT_PREP_RESILIENCE_OUTPUT_ROOT',
      'CERT_PREP_RESILIENCE_ACCEPTANCE_RUN_ID',
    ]) {
      await t.test(name, async () => {
        const environment = { ...fixture.environment };
        delete environment[name];
        await assert.rejects(
          loadDocumentCancellationOptions(environment, fixture.workspaceRoot),
          new RegExp(`${name} is required`),
        );
      });
    }
  } finally {
    fixture.cleanup();
  }
});

test('document cancellation options reject identity drift and reused output', async (t) => {
  const fixture = fixtureWorkspace();
  try {
    await t.test('candidate ID drift', async () => {
      await assert.rejects(
        loadDocumentCancellationOptions(
          {
            ...fixture.environment,
            CERT_PREP_RELEASE_CANDIDATE_ID: 'f'.repeat(64),
          },
          fixture.workspaceRoot,
        ),
        /does not match the verified candidate/,
      );
    });
    await t.test('invalid harness digest', async () => {
      await assert.rejects(
        loadDocumentCancellationOptions(
          {
            ...fixture.environment,
            ALPHA_HARDWARE_HARNESS_SHA256: 'not-a-digest',
          },
          fixture.workspaceRoot,
        ),
        /ALPHA_HARDWARE_HARNESS_SHA256 is invalid/,
      );
    });
    await t.test('invalid run ID', async () => {
      await assert.rejects(
        loadDocumentCancellationOptions(
          {
            ...fixture.environment,
            CERT_PREP_RESILIENCE_ACCEPTANCE_RUN_ID: 'short',
          },
          fixture.workspaceRoot,
        ),
        /CERT_PREP_RESILIENCE_ACCEPTANCE_RUN_ID is invalid/,
      );
    });
    await t.test('reused output', async () => {
      mkdirSync(fixture.outputRoot);
      await assert.rejects(
        loadDocumentCancellationOptions(
          fixture.environment,
          fixture.workspaceRoot,
        ),
        /must not exist before the run/,
      );
    });
  } finally {
    fixture.cleanup();
  }
});

test('document cancellation options reject a non-PDF payload', async () => {
  const fixture = fixtureWorkspace();
  try {
    writeFileSync(fixture.pdfPath, 'not a PDF');
    await assert.rejects(
      loadDocumentCancellationOptions(
        fixture.environment,
        fixture.workspaceRoot,
      ),
      /does not contain a PDF header/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('document cancellation options reject install-receipt candidate and binary drift', async (t) => {
  const fixture = fixtureWorkspace();
  try {
    await t.test('candidate binding drift', async () => {
      const receipt = JSON.parse(readFileSync(fixture.receiptPath, 'utf8')) as Record<
        string,
        unknown
      >;
      writeJson(fixture.receiptPath, {
        ...receipt,
        candidateId: 'f'.repeat(64),
      });
      await assert.rejects(
        loadDocumentCancellationOptions(
          fixture.environment,
          fixture.workspaceRoot,
        ),
        /not bound to the exact candidate/,
      );
    });
  } finally {
    fixture.cleanup();
  }

  const executableDrift = fixtureWorkspace();
  try {
    writeFileSync(executableDrift.installedExePath, 'modified executable');
    await assert.rejects(
      loadDocumentCancellationOptions(
        executableDrift.environment,
        executableDrift.workspaceRoot,
      ),
      /executable identity does not match/,
    );
  } finally {
    executableDrift.cleanup();
  }

  const installerDrift = fixtureWorkspace();
  try {
    writeFileSync(installerDrift.installerPath, 'modified installer');
    await assert.rejects(
      loadDocumentCancellationOptions(
        installerDrift.environment,
        installerDrift.workspaceRoot,
      ),
      /Candidate file identity does not match|installer does not match candidate\.json/,
    );
  } finally {
    installerDrift.cleanup();
  }

  for (const [label, override] of [
    ['non-fresh install', { freshInstallVerified: false }],
    ['failed installer', { installerExitCode: 1 }],
    ['invalid install timestamp', { installedAt: 'not-a-timestamp' }],
  ] as const) {
    const invalidReceipt = fixtureWorkspace();
    try {
      const receipt = JSON.parse(
        readFileSync(invalidReceipt.receiptPath, 'utf8'),
      ) as Record<string, unknown>;
      writeJson(invalidReceipt.receiptPath, { ...receipt, ...override });
      await assert.rejects(
        loadDocumentCancellationOptions(
          invalidReceipt.environment,
          invalidReceipt.workspaceRoot,
        ),
        /receipt schema is invalid/,
        label,
      );
    } finally {
      invalidReceipt.cleanup();
    }
  }
});

interface FixtureWorkspace {
  readonly workspaceRoot: string;
  readonly outputRoot: string;
  readonly pdfPath: string;
  readonly installedExePath: string;
  readonly installerPath: string;
  readonly receiptPath: string;
  readonly candidateId: string;
  readonly environment: Record<string, string>;
  cleanup(): void;
}

interface FixtureOptions {
  readonly profile?: 'public_unsigned_alpha' | 'local_nonpublishable';
  readonly planOverrides?: Readonly<Record<string, unknown>>;
  readonly candidateOverrides?: Readonly<Record<string, unknown>>;
}

function fixtureWorkspace({
  profile = 'public_unsigned_alpha',
  planOverrides = {},
  candidateOverrides = {},
}: FixtureOptions = {}): FixtureWorkspace {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cert-prep-resilience-'));
  const candidateRoot = join(workspaceRoot, 'candidate');
  const releaseMetadataRoot = join(candidateRoot, 'release', 'metadata');
  const releaseInstallerRoot = join(candidateRoot, 'release', 'installers');
  const harnessRoot = join(candidateRoot, 'harness');
  mkdirSync(releaseMetadataRoot, { recursive: true });
  mkdirSync(releaseInstallerRoot, { recursive: true });
  mkdirSync(harnessRoot, { recursive: true });
  const version = '0.1.0-alpha.1';
  const commitSha = 'a'.repeat(40);
  const repository =
    profile === 'local_nonpublishable'
      ? 'local/nonpublishable'
      : 'example/cert-prep';
  const tag =
    profile === 'local_nonpublishable'
      ? `cert-prep-local-v${version}-${commitSha.slice(0, 12)}`
      : `cert-prep-v${version}`;
  const plan = {
    version,
    tag,
    commitSha,
    repository,
    target: 'x86_64-pc-windows-msvc',
    signed: false,
    channel:
      profile === 'local_nonpublishable'
        ? 'local_nonpublishable'
        : 'unsigned_public_alpha',
    distributionProfile: profile,
    publishable: profile === 'public_unsigned_alpha',
    assetBaseUrl:
      profile === 'local_nonpublishable'
        ? pathToFileURL(join(candidateRoot, 'local-assets')).href
        : `https://github.com/${repository}/releases/download/${tag}`,
    ...planOverrides,
  };
  writeJson(join(releaseMetadataRoot, 'release-plan.json'), plan);
  const installerPath = join(
    releaseInstallerRoot,
    'Cert Prep_0.1.0-alpha.1_x64_en-US.msi',
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
    version: plan.version,
    tag: plan.tag,
    repository: plan.repository,
    commitSha: plan.commitSha,
    distributionProfile: plan.distributionProfile,
    publishable: plan.publishable,
    ...candidateOverrides,
  });

  const installedExePath = join(workspaceRoot, 'Cert Prep.exe');
  const pdfPath = join(workspaceRoot, 'acceptance.pdf');
  writeFileSync(installedExePath, 'installed candidate executable');
  writeFileSync(pdfPath, '%PDF-1.7 acceptance fixture');
  const outputRoot = join(
    workspaceRoot,
    'tmp',
    'cert-prep-desktop',
    'packaged-document-cancellation',
  );
  mkdirSync(join(outputRoot, '..'), { recursive: true });
  const receiptPath = join(workspaceRoot, 'install-receipt.json');
  writeJson(receiptPath, {
    schemaVersion: 1,
    candidateId,
    acceptanceRunId: 'acceptance-run-0001',
    harnessSha256: 'b'.repeat(64),
    packageKind: 'msi',
    installer: {
      relativePath:
        'release/installers/Cert Prep_0.1.0-alpha.1_x64_en-US.msi',
      sha256: sha256(installerPath),
    },
    installedExecutable: {
      path: installedExePath,
      name: 'Cert Prep.exe',
      bytes: statSync(installedExePath).size,
      sha256: sha256(installedExePath),
    },
    freshInstallVerified: true,
    installerExitCode: 0,
    installedAt: '2026-07-14T00:00:00.000Z',
  });

  return {
    workspaceRoot,
    outputRoot,
    pdfPath,
    installedExePath,
    installerPath,
    receiptPath,
    candidateId,
    environment: {
      CERT_PREP_RESILIENCE_CANDIDATE_ROOT: candidateRoot,
      CERT_PREP_RELEASE_CANDIDATE_ID: candidateId,
      ALPHA_HARDWARE_HARNESS_SHA256: 'b'.repeat(64),
      CERT_PREP_RESILIENCE_INSTALLED_EXE_PATH: installedExePath,
      CERT_PREP_RESILIENCE_INSTALL_RECEIPT_PATH: receiptPath,
      CERT_PREP_RESILIENCE_PDF_PATH: pdfPath,
      CERT_PREP_RESILIENCE_OUTPUT_ROOT: outputRoot,
      CERT_PREP_RESILIENCE_ACCEPTANCE_RUN_ID: 'acceptance-run-0001',
    },
    cleanup() {
      rmSync(workspaceRoot, { recursive: true, force: true });
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

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
