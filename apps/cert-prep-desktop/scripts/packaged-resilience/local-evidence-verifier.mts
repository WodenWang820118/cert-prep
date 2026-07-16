import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  loadInstalledCandidateBinding,
  type InstalledCandidateRunnerBinding,
} from './args.mts';
import {
  RESILIENCE_CHECKS,
  validateResilienceEvidence,
  validateSessionRestartEvidence,
  type InstallationBinding,
  type ResilienceCheck,
} from './evidence-contract.mts';

const DOCUMENT_CHECKS = [
  'upload',
  'ocr',
  'cancelVsCompleteRace',
  'crashRecovery',
  'partialDataRemoved',
] as const satisfies readonly ResilienceCheck[];

const REMAINING_CHECKS = [
  'draft',
  'runtime',
  'model',
  'ownedProcessesReleased',
] as const satisfies readonly ResilienceCheck[];

const INSTALLATION_BINDING_KEYS = [
  'receiptSha256',
  'packageKind',
  'installerRelativePath',
  'installerSha256',
  'installedExeName',
  'installedExeBytes',
  'installedExeSha256',
  'installedAt',
] as const satisfies readonly (keyof InstallationBinding)[];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = resolve(scriptDir, '../../../..');

export interface VerifiedLocalEvidenceArtifact {
  readonly passed: true;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface LocalResilienceEvidenceVerification {
  readonly schemaVersion: 1;
  readonly passed: true;
  readonly scope: 'local_nonpublishable';
  readonly candidate: InstalledCandidateRunnerBinding['candidate'];
  readonly acceptanceRunId: string;
  readonly installation: {
    readonly receiptSha256: string;
    readonly packageKind: 'nsis';
    readonly installerSha256: string;
    readonly installedExeSha256: string;
  };
  readonly documentOutputRoot: string;
  readonly remainingOutputRoot: string;
  readonly cancellation: Readonly<
    Record<ResilienceCheck, VerifiedLocalEvidenceArtifact>
  >;
  readonly sessionRestart: VerifiedLocalEvidenceArtifact;
}

export interface LocalEvidenceVerifierDependencies {
  readonly loadInstalledCandidate: typeof loadInstalledCandidateBinding;
}

const DEFAULT_DEPENDENCIES: LocalEvidenceVerifierDependencies = {
  loadInstalledCandidate: loadInstalledCandidateBinding,
};

export async function verifyLocalResilienceEvidence(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  workspaceRoot = defaultWorkspaceRoot,
  dependencies: LocalEvidenceVerifierDependencies = DEFAULT_DEPENDENCIES,
): Promise<LocalResilienceEvidenceVerification> {
  assertExactCheckPartition();
  const binding = await dependencies.loadInstalledCandidate(
    environment,
    workspaceRoot,
  );
  if (binding.candidateDistributionProfile !== 'local_nonpublishable') {
    throw new Error(
      'Local resilience evidence verification requires a local_nonpublishable candidate.',
    );
  }

  const evidenceParent = resolve(
    binding.workspaceRoot,
    'tmp',
    'cert-prep-desktop',
  );
  const documentOutputRoot = requiredEvidenceRoot(
    environment,
    'CERT_PREP_RESILIENCE_DOCUMENT_OUTPUT_ROOT',
    evidenceParent,
  );
  const remainingOutputRoot = requiredEvidenceRoot(
    environment,
    'CERT_PREP_RESILIENCE_REMAINING_OUTPUT_ROOT',
    evidenceParent,
  );
  if (samePath(documentOutputRoot, remainingOutputRoot)) {
    throw new Error(
      'Document and remaining resilience evidence roots must be distinct.',
    );
  }

  const context = {
    candidate: binding.candidate,
    acceptanceRunId: binding.acceptanceRunId,
  };
  const documentArtifacts = verifyCancellationTree(
    documentOutputRoot,
    'document',
    DOCUMENT_CHECKS,
    binding,
    context,
  );
  const remainingArtifacts = verifyCancellationTree(
    remainingOutputRoot,
    'remaining',
    REMAINING_CHECKS,
    binding,
    context,
  );
  assertExactEntries(
    remainingOutputRoot,
    ['cancellation', 'session-restart.json'],
    'Remaining resilience evidence root',
  );
  const sessionRestart = verifySessionRestartArtifact(
    remainingOutputRoot,
    binding,
    context,
  );

  const reloadedBinding = await dependencies.loadInstalledCandidate(
    environment,
    workspaceRoot,
  );
  assertBindingUnchanged(binding, reloadedBinding);

  return {
    schemaVersion: 1,
    passed: true,
    scope: 'local_nonpublishable',
    candidate: binding.candidate,
    acceptanceRunId: binding.acceptanceRunId,
    installation: {
      receiptSha256: binding.installation.receiptSha256,
      packageKind: binding.installation.packageKind,
      installerSha256: binding.installation.installerSha256,
      installedExeSha256: binding.installation.installedExeSha256,
    },
    documentOutputRoot,
    remainingOutputRoot,
    cancellation: {
      ...documentArtifacts,
      ...remainingArtifacts,
    },
    sessionRestart,
  };
}

function verifyCancellationTree<const Check extends ResilienceCheck>(
  root: string,
  lane: 'document' | 'remaining',
  checks: readonly Check[],
  binding: InstalledCandidateRunnerBinding,
  context: {
    readonly candidate: InstalledCandidateRunnerBinding['candidate'];
    readonly acceptanceRunId: string;
  },
): Readonly<Record<Check, VerifiedLocalEvidenceArtifact>> {
  if (lane === 'document') {
    assertExactEntries(
      root,
      ['cancellation'],
      'Document resilience evidence root',
    );
  }
  const cancellationRoot = canonicalDirectory(
    join(root, 'cancellation'),
    `${lane} cancellation evidence directory`,
  );
  assertExactEntries(
    cancellationRoot,
    checks.map((check) => `${check}.json`),
    `${lane} cancellation evidence directory`,
  );

  return Object.fromEntries(
    checks.map((check) => {
      const relativePath = `${lane}/cancellation/${check}.json`;
      const payload = readSafeArtifact(
        join(cancellationRoot, `${check}.json`),
        relativePath,
      );
      const value = parseJsonArtifact(payload, relativePath);
      const evidence = validateResilienceEvidence(value, check, context);
      assertInstallationBinding(
        evidence.proof.installationBinding,
        binding.installation,
        check,
      );
      return [check, artifactReference(relativePath, payload)] as const;
    }),
  ) as Readonly<Record<Check, VerifiedLocalEvidenceArtifact>>;
}

function verifySessionRestartArtifact(
  root: string,
  binding: InstalledCandidateRunnerBinding,
  context: {
    readonly candidate: InstalledCandidateRunnerBinding['candidate'];
    readonly acceptanceRunId: string;
  },
): VerifiedLocalEvidenceArtifact {
  const relativePath = 'remaining/session-restart.json';
  const payload = readSafeArtifact(
    join(root, 'session-restart.json'),
    relativePath,
  );
  const evidence = validateSessionRestartEvidence(
    parseJsonArtifact(payload, relativePath),
    context,
  );
  assertInstallationBinding(
    evidence.proof.installationBinding,
    binding.installation,
    'sessionRestart',
  );
  return artifactReference(relativePath, payload);
}

function requiredEvidenceRoot(
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
  evidenceParent: string,
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  if (!isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  const root = canonicalDirectory(resolve(value), name);
  requireStrictDescendant(root, evidenceParent, name);
  return root;
}

function canonicalDirectory(path: string, label: string): string {
  if (!existsSync(path)) {
    throw new Error(`${label} does not exist.`);
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a canonical non-symlink directory.`);
  }
  const canonicalPath = realpathSync.native(path);
  if (!samePath(canonicalPath, resolve(path))) {
    throw new Error(
      `${label} must not traverse a reparse point or path alias.`,
    );
  }
  return canonicalPath;
}

function assertExactEntries(
  root: string,
  expectedNames: readonly string[],
  label: string,
): void {
  const actualNames = readdirSync(root).sort();
  const expected = [...expectedNames].sort();
  if (
    actualNames.length !== expected.length ||
    actualNames.some((name, index) => name !== expected[index])
  ) {
    throw new Error(`${label} does not contain the exact required file set.`);
  }
}

function readSafeArtifact(path: string, label: string): Buffer {
  if (!existsSync(path)) {
    throw new Error(`${label} is missing.`);
  }
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`${label} must be a canonical non-symlink file.`);
  }
  const canonicalPath = realpathSync.native(path);
  if (!samePath(canonicalPath, resolve(path))) {
    throw new Error(
      `${label} must not traverse a reparse point or path alias.`,
    );
  }
  const payload = readFileSync(canonicalPath);
  const after = statSync(canonicalPath);
  if (
    payload.length === 0 ||
    before.size !== payload.length ||
    after.size !== payload.length
  ) {
    throw new Error(`${label} changed while it was being read or is empty.`);
  }
  return payload;
}

function parseJsonArtifact(payload: Buffer, label: string): unknown {
  try {
    return JSON.parse(payload.toString('utf8')) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function artifactReference(
  path: string,
  payload: Buffer,
): VerifiedLocalEvidenceArtifact {
  return {
    passed: true,
    path,
    bytes: payload.length,
    sha256: createHash('sha256').update(payload).digest('hex'),
  };
}

function assertInstallationBinding(
  raw: unknown,
  expected: InstallationBinding,
  label: string,
): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${label} installation binding is missing.`);
  }
  const actual = raw as Record<string, unknown>;
  for (const key of INSTALLATION_BINDING_KEYS) {
    if (actual[key] !== expected[key]) {
      throw new Error(
        `${label} installation binding does not match the current install receipt: ${key}.`,
      );
    }
  }
}

function assertBindingUnchanged(
  before: InstalledCandidateRunnerBinding,
  after: InstalledCandidateRunnerBinding,
): void {
  if (
    JSON.stringify(bindingIdentity(before)) !==
    JSON.stringify(bindingIdentity(after))
  ) {
    throw new Error(
      'Installed candidate binding changed while local resilience evidence was verified.',
    );
  }
}

function bindingIdentity(binding: InstalledCandidateRunnerBinding): unknown {
  return {
    workspaceRoot: binding.workspaceRoot,
    candidateRoot: binding.candidateRoot,
    installedExePath: binding.installedExePath,
    acceptanceRunId: binding.acceptanceRunId,
    candidate: binding.candidate,
    candidateDistributionProfile: binding.candidateDistributionProfile,
    installation: binding.installation,
  };
}

function assertExactCheckPartition(): void {
  const partition = [...DOCUMENT_CHECKS, ...REMAINING_CHECKS].sort();
  const expected = [...RESILIENCE_CHECKS].sort();
  if (
    partition.length !== expected.length ||
    partition.some((check, index) => check !== expected[index])
  ) {
    throw new Error('Local resilience evidence check partition is incomplete.');
  }
}

function requireStrictDescendant(
  candidatePath: string,
  parentPath: string,
  label: string,
): void {
  const child = resolve(candidatePath);
  const parent = resolve(parentPath);
  const childRelative = relative(parent, child);
  if (
    !childRelative ||
    childRelative === '..' ||
    childRelative.startsWith(`..${sep}`) ||
    isAbsolute(childRelative)
  ) {
    throw new Error(`${label} must stay under ${parent}.`);
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function main(): Promise<void> {
  const result = await verifyLocalResilienceEvidence();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
