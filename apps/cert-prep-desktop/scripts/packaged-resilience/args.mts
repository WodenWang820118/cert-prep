import { readFileSync, existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  readonly timeoutMs: number;
  readonly latePublishObservationWindowMs: number;
  readonly cdpPort: number;
}

interface CandidateIdentityDocument {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly version: string;
  readonly tag: string;
  readonly commitSha: string;
  readonly files: readonly string[];
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
  for (const key of ['version', 'tag', 'commitSha'] as const) {
    if (plan[key] !== candidateDocument[key]) {
      throw new Error(`Verified candidate ${key} does not match the release plan.`);
    }
  }

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
    timeoutMs,
    latePublishObservationWindowMs,
    cdpPort: optionalPositiveInteger(
      environment.CERT_PREP_RESILIENCE_CDP_PORT,
      'CERT_PREP_RESILIENCE_CDP_PORT',
      DEFAULT_CDP_PORT,
    ),
  };
}

async function validateCandidateRoot(
  candidateRoot: string,
  candidate: Record<string, unknown>,
): Promise<void> {
  const releaseLibUrl = pathToFileURL(
    resolve(defaultWorkspaceRoot, 'tools', 'release', 'release-lib.ts'),
  ).href;
  const releaseLib = (await import(releaseLibUrl)) as {
    readonly validateCandidateFiles: (
      root: string,
      value: Record<string, unknown>,
    ) => Promise<unknown>;
  };
  await releaseLib.validateCandidateFiles(candidateRoot, candidate);
}

function candidateIdentity(
  value: Record<string, unknown>,
): CandidateIdentityDocument {
  const candidateId = stringField(value.candidateId, 'candidateId');
  const version = stringField(value.version, 'version');
  const tag = stringField(value.tag, 'tag');
  const commitSha = stringField(value.commitSha, 'commitSha');
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.files) ||
    !value.files.every((item) => typeof item === 'string') ||
    !SHA256_PATTERN.test(candidateId) ||
    !VERSION_PATTERN.test(version) ||
    tag !== `cert-prep-v${version}` ||
    !COMMIT_SHA_PATTERN.test(commitSha)
  ) {
    throw new Error('Verified candidate identity fields are invalid.');
  }
  return {
    schemaVersion: 1,
    candidateId,
    version,
    tag,
    commitSha,
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
