import { createHash } from 'node:crypto';
import {
  createReadStream,
  readFileSync,
  existsSync,
  lstatSync,
  realpathSync,
  statSync,
} from 'node:fs';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { CandidateDistributionProfile } from '../packaged-flow-smoke/types.mts';
import type { CandidateBinding } from './evidence-contract.mts';

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const VERSION_PATTERN = /^\d+\.\d+\.\d+-alpha\.\d+$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
const DEFAULT_TIMEOUT_MS = 1_200_000;
const DEFAULT_LATE_PUBLISH_WINDOW_MS = 2_000;
const DEFAULT_CDP_PORT = 9591;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = resolve(scriptDir, '../../../..');

export interface DocumentCancellationRunnerOptions {
  readonly workspaceRoot: string;
  readonly candidateRoot: string;
  readonly installedExePath: string;
  readonly pdfPath: string;
  readonly outputRoot: string;
  readonly diagnosticsRoot: string;
  readonly acceptanceRunId: string;
  readonly candidate: CandidateBinding;
  readonly candidateDistributionProfile: CandidateDistributionProfile;
  readonly installation: InstalledCandidateBinding;
  readonly timeoutMs: number;
  readonly latePublishObservationWindowMs: number;
  readonly cdpPort: number;
}

export interface InstalledCandidateBinding {
  readonly receiptPath: string;
  readonly receiptSha256: string;
  readonly packageKind: 'msi' | 'nsis';
  readonly installerRelativePath: string;
  readonly installerSha256: string;
  readonly installedExeName: string;
  readonly installedExeBytes: number;
  readonly installedExeSha256: string;
  readonly installedAt: string;
}

interface CandidateIdentityDocument {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly version: string;
  readonly tag: string;
  readonly repository: string;
  readonly commitSha: string;
  readonly distributionProfile: CandidateDistributionProfile;
  readonly publishable: boolean;
  readonly files: readonly string[];
}

interface InstallReceiptDocument {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly acceptanceRunId: string;
  readonly harnessSha256: string;
  readonly packageKind: 'msi' | 'nsis';
  readonly installer: {
    readonly relativePath: string;
    readonly sha256: string;
  };
  readonly installedExecutable: {
    readonly path: string;
    readonly name: string;
    readonly bytes: number;
    readonly sha256: string;
  };
  readonly freshInstallVerified: true;
  readonly installerExitCode: 0;
  readonly installedAt: string;
}

export async function loadDocumentCancellationOptions(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  workspaceRoot = defaultWorkspaceRoot,
): Promise<DocumentCancellationRunnerOptions> {
  const resolvedWorkspaceRoot = realpathSync(resolve(workspaceRoot));
  const candidateRoot = requiredAbsolutePath(
    environment,
    'CERT_PREP_RESILIENCE_CANDIDATE_ROOT',
  );
  const installedExePath = requiredSafeFile(
    environment,
    'CERT_PREP_RESILIENCE_INSTALLED_EXE_PATH',
    '.exe',
  );
  const pdfPath = requiredSafeFile(
    environment,
    'CERT_PREP_RESILIENCE_PDF_PATH',
    '.pdf',
  );
  assertPdfHeader(pdfPath);

  const outputRoot = requiredAbsolutePath(
    environment,
    'CERT_PREP_RESILIENCE_OUTPUT_ROOT',
  );
  requireStrictDescendant(
    outputRoot,
    resolve(resolvedWorkspaceRoot, 'tmp', 'cert-prep-desktop'),
    'CERT_PREP_RESILIENCE_OUTPUT_ROOT',
  );
  const diagnosticsRoot = `${outputRoot}.diagnostics`;
  if (existsSync(outputRoot) || existsSync(diagnosticsRoot)) {
    throw new Error(
      'Packaged document-cancellation output and diagnostics paths must not exist before the run.',
    );
  }

  const expectedCandidateId = requiredPattern(
    environment,
    'CERT_PREP_RELEASE_CANDIDATE_ID',
    SHA256_PATTERN,
  ).toLowerCase();
  const harnessSha256 = requiredPattern(
    environment,
    'ALPHA_HARDWARE_HARNESS_SHA256',
    SHA256_PATTERN,
  ).toLowerCase();
  const acceptanceRunId = requiredPattern(
    environment,
    'CERT_PREP_RESILIENCE_ACCEPTANCE_RUN_ID',
    RUN_ID_PATTERN,
  );

  const candidatePath = resolve(candidateRoot, 'candidate.json');
  const candidateValue = readJsonObject(candidatePath, 'candidate.json');
  await validateCandidateRoot(candidateRoot, candidateValue);
  const candidateDocument = candidateIdentity(candidateValue);
  if (candidateDocument.candidateId.toLowerCase() !== expectedCandidateId) {
    throw new Error(
      'CERT_PREP_RELEASE_CANDIDATE_ID does not match the verified candidate.json.',
    );
  }
  const plan = readJsonObject(
    resolve(candidateRoot, 'release', 'metadata', 'release-plan.json'),
    'release plan',
  );
  const candidateDistributionProfile = await validateCandidateDistribution(
    candidateDocument,
    plan,
  );
  const installation = await validateInstallReceipt({
    environment,
    candidateRoot,
    candidate: candidateDocument,
    installedExePath,
    acceptanceRunId,
    harnessSha256,
  });

  const timeoutMs = optionalPositiveInteger(
    environment.CERT_PREP_RESILIENCE_TIMEOUT_MS,
    'CERT_PREP_RESILIENCE_TIMEOUT_MS',
    DEFAULT_TIMEOUT_MS,
  );
  const latePublishObservationWindowMs = optionalPositiveInteger(
    environment.CERT_PREP_RESILIENCE_LATE_PUBLISH_WINDOW_MS,
    'CERT_PREP_RESILIENCE_LATE_PUBLISH_WINDOW_MS',
    DEFAULT_LATE_PUBLISH_WINDOW_MS,
  );
  if (latePublishObservationWindowMs < 1_000) {
    throw new Error(
      'CERT_PREP_RESILIENCE_LATE_PUBLISH_WINDOW_MS must be at least 1000.',
    );
  }

  return {
    workspaceRoot: resolvedWorkspaceRoot,
    candidateRoot: realpathSync(candidateRoot),
    installedExePath,
    pdfPath,
    outputRoot,
    diagnosticsRoot,
    acceptanceRunId,
    candidate: {
      candidateId: candidateDocument.candidateId.toLowerCase(),
      version: candidateDocument.version,
      tag: candidateDocument.tag,
      commitSha: candidateDocument.commitSha.toLowerCase(),
      harnessSha256,
    },
    candidateDistributionProfile,
    installation,
    timeoutMs,
    latePublishObservationWindowMs,
    cdpPort: optionalPositiveInteger(
      environment.CERT_PREP_RESILIENCE_CDP_PORT,
      'CERT_PREP_RESILIENCE_CDP_PORT',
      DEFAULT_CDP_PORT,
    ),
  };
}

async function validateInstallReceipt({
  environment,
  candidateRoot,
  candidate,
  installedExePath,
  acceptanceRunId,
  harnessSha256,
}: {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly candidateRoot: string;
  readonly candidate: CandidateIdentityDocument;
  readonly installedExePath: string;
  readonly acceptanceRunId: string;
  readonly harnessSha256: string;
}): Promise<InstalledCandidateBinding> {
  const receiptPath = requiredSafeFile(
    environment,
    'CERT_PREP_RESILIENCE_INSTALL_RECEIPT_PATH',
    '.json',
  );
  const receipt = installReceipt(
    readJsonObject(receiptPath, 'installed candidate receipt'),
  );
  if (
    receipt.candidateId.toLowerCase() !== candidate.candidateId.toLowerCase() ||
    receipt.acceptanceRunId !== acceptanceRunId ||
    receipt.harnessSha256.toLowerCase() !== harnessSha256.toLowerCase()
  ) {
    throw new Error(
      'Installed candidate receipt is not bound to the exact candidate, acceptance run, and pinned harness.',
    );
  }

  const installerRelativePath = safeCandidateRelativePath(
    receipt.installer.relativePath,
  );
  const expectedInstallerExtension =
    receipt.packageKind === 'msi' ? '.msi' : '.exe';
  if (
    !installerRelativePath.startsWith('release/installers/') ||
    extname(installerRelativePath).toLowerCase() !== expectedInstallerExtension ||
    (receipt.packageKind === 'nsis' &&
      !basename(installerRelativePath).toLowerCase().endsWith('setup.exe'))
  ) {
    throw new Error('Installed candidate receipt package kind does not match its installer.');
  }
  const installerPath = safeCandidateFile(candidateRoot, installerRelativePath);
  const installerSha256 = await sha256File(installerPath);
  if (
    installerSha256 !== receipt.installer.sha256.toLowerCase() ||
    !candidate.files.includes(`${installerRelativePath}:${installerSha256}`)
  ) {
    throw new Error(
      'Installed candidate receipt installer does not match candidate.json and the physical installer.',
    );
  }

  const receiptExePath = requiredReceiptAbsolutePath(
    receipt.installedExecutable.path,
    'installedExecutable.path',
  );
  if (receiptExePath !== installedExePath) {
    throw new Error(
      'Installed candidate receipt executable path does not match CERT_PREP_RESILIENCE_INSTALLED_EXE_PATH.',
    );
  }
  const exeStat = statSync(installedExePath);
  const installedExeSha256 = await sha256File(installedExePath);
  if (
    receipt.installedExecutable.name !== basename(installedExePath) ||
    receipt.installedExecutable.bytes !== exeStat.size ||
    receipt.installedExecutable.sha256.toLowerCase() !== installedExeSha256
  ) {
    throw new Error(
      'Installed candidate receipt executable identity does not match the physical installed executable.',
    );
  }

  return {
    receiptPath,
    receiptSha256: await sha256File(receiptPath),
    packageKind: receipt.packageKind,
    installerRelativePath,
    installerSha256,
    installedExeName: receipt.installedExecutable.name,
    installedExeBytes: receipt.installedExecutable.bytes,
    installedExeSha256,
    installedAt: receipt.installedAt,
  };
}

function installReceipt(value: Record<string, unknown>): InstallReceiptDocument {
  const installer = jsonRecord(value.installer, 'installer');
  const installedExecutable = jsonRecord(
    value.installedExecutable,
    'installedExecutable',
  );
  const packageKind = value.packageKind;
  const bytes = installedExecutable.bytes;
  const installedAt = receiptString(value.installedAt, 'installedAt');
  if (
    value.schemaVersion !== 1 ||
    (packageKind !== 'msi' && packageKind !== 'nsis') ||
    !Number.isSafeInteger(bytes) ||
    Number(bytes) < 1 ||
    value.freshInstallVerified !== true ||
    value.installerExitCode !== 0 ||
    !Number.isFinite(Date.parse(installedAt))
  ) {
    throw new Error('Installed candidate receipt schema is invalid.');
  }
  return {
    schemaVersion: 1,
    candidateId: receiptPattern(value.candidateId, 'candidateId', SHA256_PATTERN),
    acceptanceRunId: receiptPattern(
      value.acceptanceRunId,
      'acceptanceRunId',
      RUN_ID_PATTERN,
    ),
    harnessSha256: receiptPattern(
      value.harnessSha256,
      'harnessSha256',
      SHA256_PATTERN,
    ),
    packageKind,
    installer: {
      relativePath: receiptString(installer.relativePath, 'installer.relativePath'),
      sha256: receiptPattern(installer.sha256, 'installer.sha256', SHA256_PATTERN),
    },
    installedExecutable: {
      path: receiptString(installedExecutable.path, 'installedExecutable.path'),
      name: receiptString(installedExecutable.name, 'installedExecutable.name'),
      bytes: Number(bytes),
      sha256: receiptPattern(
        installedExecutable.sha256,
        'installedExecutable.sha256',
        SHA256_PATTERN,
      ),
    },
    freshInstallVerified: true,
    installerExitCode: 0,
    installedAt,
  };
}

function jsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Installed candidate receipt ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function receiptString(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    value.length > 1_024 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw new Error(`Installed candidate receipt ${label} is invalid.`);
  }
  return value;
}

function receiptPattern(
  value: unknown,
  label: string,
  pattern: RegExp,
): string {
  const text = receiptString(value, label);
  if (!pattern.test(text)) {
    throw new Error(`Installed candidate receipt ${label} is invalid.`);
  }
  return text;
}

function safeCandidateRelativePath(value: string): string {
  if (
    value.includes('\\') ||
    value.startsWith('/') ||
    value.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw new Error('Installed candidate receipt installer path is unsafe.');
  }
  return value;
}

function safeCandidateFile(candidateRoot: string, relativePath: string): string {
  const path = resolve(candidateRoot, ...relativePath.split('/'));
  requireStrictDescendant(path, candidateRoot, 'Installed candidate installer');
  if (
    !existsSync(path) ||
    !statSync(path).isFile() ||
    lstatSync(path).isSymbolicLink()
  ) {
    throw new Error('Installed candidate receipt installer is missing or unsafe.');
  }
  const canonicalPath = realpathSync(path);
  requireStrictDescendant(
    canonicalPath,
    realpathSync(candidateRoot),
    'Installed candidate installer',
  );
  return canonicalPath;
}

function requiredReceiptAbsolutePath(value: string, label: string): string {
  if (!isAbsolute(value)) {
    throw new Error(`Installed candidate receipt ${label} must be absolute.`);
  }
  const path = resolve(value);
  if (
    !existsSync(path) ||
    !statSync(path).isFile() ||
    lstatSync(path).isSymbolicLink()
  ) {
    throw new Error(`Installed candidate receipt ${label} is missing or unsafe.`);
  }
  return realpathSync(path);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function validateCandidateRoot(
  candidateRoot: string,
  candidate: Record<string, unknown>,
): Promise<void> {
  const releaseLib = await loadReleaseValidation();
  await releaseLib.validateCandidateFiles(candidateRoot, candidate);
}

async function validateCandidateDistribution(
  candidate: CandidateIdentityDocument,
  plan: Record<string, unknown>,
): Promise<CandidateDistributionProfile> {
  const releaseLib = await loadReleaseValidation();
  releaseLib.assertSupportedDistributionPlan(plan);
  releaseLib.assertCandidateMatchesPlan(candidate, plan);
  return candidate.distributionProfile;
}

interface ReleaseValidation {
  readonly validateCandidateFiles: (
    root: string,
    value: Record<string, unknown>,
  ) => Promise<unknown>;
  readonly assertSupportedDistributionPlan: (
    value: Record<string, unknown>,
  ) => unknown;
  readonly assertCandidateMatchesPlan: (
    candidate: CandidateIdentityDocument,
    plan: Record<string, unknown>,
  ) => void;
}

async function loadReleaseValidation(): Promise<ReleaseValidation> {
  const releaseLibUrl = pathToFileURL(
    resolve(defaultWorkspaceRoot, 'tools', 'release', 'release-lib.ts'),
  ).href;
  return (await import(releaseLibUrl)) as ReleaseValidation;
}

function candidateIdentity(
  value: Record<string, unknown>,
): CandidateIdentityDocument {
  const candidateId = stringField(value.candidateId, 'candidateId');
  const version = stringField(value.version, 'version');
  const tag = stringField(value.tag, 'tag');
  const repository = stringField(value.repository, 'repository');
  const commitSha = stringField(value.commitSha, 'commitSha');
  const distributionProfile = stringField(
    value.distributionProfile,
    'distributionProfile',
  );
  const publishable = value.publishable;
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.files) ||
    !value.files.every((item) => typeof item === 'string') ||
    !SHA256_PATTERN.test(candidateId) ||
    !VERSION_PATTERN.test(version) ||
    !COMMIT_SHA_PATTERN.test(commitSha) ||
    (distributionProfile !== 'public_unsigned_alpha' &&
      distributionProfile !== 'local_nonpublishable') ||
    typeof publishable !== 'boolean'
  ) {
    throw new Error('Verified candidate identity fields are invalid.');
  }
  return {
    schemaVersion: 1,
    candidateId,
    version,
    tag,
    repository,
    commitSha,
    distributionProfile,
    publishable,
    files: value.files,
  };
}

function requiredAbsolutePath(
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
): string {
  const value = requiredString(environment, name);
  if (!isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return resolve(value);
}

function requiredSafeFile(
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
  expectedExtension: string,
): string {
  const path = requiredAbsolutePath(environment, name);
  if (
    !existsSync(path) ||
    !statSync(path).isFile() ||
    lstatSync(path).isSymbolicLink() ||
    extname(path).toLowerCase() !== expectedExtension
  ) {
    throw new Error(`${name} must identify a non-symlink ${expectedExtension} file.`);
  }
  return realpathSync(path);
}

function requiredPattern(
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
  pattern: RegExp,
): string {
  const value = requiredString(environment, name);
  if (!pattern.test(value)) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function requiredString(
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function optionalPositiveInteger(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function readJsonObject(path: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${label} is missing or invalid JSON.`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Candidate ${name} must be a non-empty string.`);
  }
  return value.trim();
}

function assertPdfHeader(path: string): void {
  const header = readFileSync(path).subarray(0, 5).toString('ascii');
  if (header !== '%PDF-') {
    throw new Error('CERT_PREP_RESILIENCE_PDF_PATH does not contain a PDF header.');
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
