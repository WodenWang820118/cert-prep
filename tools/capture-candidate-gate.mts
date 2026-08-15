import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  CAPTURE_RUNTIME_FILE,
  CAPTURE_RUNTIME_RELEASE_ASSETS,
  validateCaptureRuntimeReleaseManifest,
} from './install-capture-runtime.mts';
import { assertCaptureRuntimeConsumerVersions } from './capture-runtime-version-check.mts';

const CONSUMER_REPOSITORY = 'WodenWang820118/cert-prep';
const WORKFLOW_PATH = '.github/workflows/capture-candidate-gate.yml';
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;

export type CaptureCandidateGateArguments = {
  readonly candidate: string;
  readonly candidateId: string;
  readonly candidateManifestSha256: string;
  readonly sourceCommit: string;
  readonly releaseVersion: string;
  readonly workflowRunId: number;
  readonly output: string;
  readonly skipChecks: boolean;
};

export type CaptureCandidateGateResult = {
  readonly schemaVersion: '2';
  readonly consumerRepository: typeof CONSUMER_REPOSITORY;
  readonly consumerCommit: string;
  readonly workflowPath: typeof WORKFLOW_PATH;
  readonly workflowRunId: number;
  readonly candidateId: string;
  readonly candidateManifestSha256: string;
  readonly verdict: 'passed';
  readonly checks: readonly {
    readonly name: string;
    readonly status: 'passed';
  }[];
  readonly startedAt: string;
  readonly completedAt: string;
};

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`Missing required argument: ${name}.`);
  return value;
}

export function parseArguments(
  args: readonly string[],
): CaptureCandidateGateArguments {
  const values = new Map<string, string>();
  let skipChecks = false;
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === '--skip-checks') {
      if (skipChecks) throw new Error('Arguments must be unique.');
      skipChecks = true;
      continue;
    }
    const value = args[index + 1];
    if (!name?.startsWith('--') || !value || values.has(name)) {
      throw new Error('Arguments must be unique --name value pairs.');
    }
    values.set(name, value);
    index += 1;
  }
  const candidateId = required(values, '--candidate-id');
  const candidateManifestSha256 = required(
    values,
    '--candidate-manifest-sha256',
  );
  const sourceCommit = required(values, '--source-commit');
  const workflowRunId = Number(required(values, '--workflow-run-id'));
  if (!SHA256_PATTERN.test(candidateId))
    throw new Error('Candidate ID must be a lowercase SHA-256 digest.');
  if (!SHA256_PATTERN.test(candidateManifestSha256))
    throw new Error(
      'Candidate manifest digest must be a lowercase SHA-256 digest.',
    );
  if (!GIT_SHA_PATTERN.test(sourceCommit))
    throw new Error('Source commit must be a full lowercase Git SHA.');
  if (!Number.isSafeInteger(workflowRunId) || workflowRunId < 1)
    throw new Error('Workflow run ID must be a positive integer.');
  return {
    candidate: resolve(required(values, '--candidate')),
    candidateId,
    candidateManifestSha256,
    sourceCommit,
    releaseVersion: required(values, '--release-version'),
    workflowRunId,
    output: resolve(required(values, '--output')),
    skipChecks,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function requireRegularFile(path: string, label: string): Promise<void> {
  const details = await stat(path);
  if (!details.isFile()) throw new Error(`${label} must be a regular file.`);
}

export async function verifyCandidate(
  input: Pick<
    CaptureCandidateGateArguments,
    | 'candidate'
    | 'candidateId'
    | 'candidateManifestSha256'
    | 'sourceCommit'
    | 'releaseVersion'
  >,
): Promise<{ readonly releaseMode: 'core-only' | 'model-enabled' }> {
  const manifestPath = join(input.candidate, 'candidate-manifest.json');
  const manifestBytes = await readFile(manifestPath);
  if (sha256(manifestBytes) !== input.candidateManifestSha256) {
    throw new Error(
      'Candidate manifest digest does not match the dispatch input.',
    );
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<
    string,
    unknown
  >;
  if (
    manifest.candidateId !== input.candidateId ||
    manifest.sourceCommit !== input.sourceCommit ||
    manifest.releaseVersion !== input.releaseVersion
  ) {
    throw new Error(
      'Candidate manifest identity does not match the dispatch input.',
    );
  }
  if (
    manifest.releaseMode !== 'core-only' &&
    manifest.releaseMode !== 'model-enabled'
  ) {
    throw new Error('Candidate release mode is invalid.');
  }

  const runtime = join(input.candidate, 'runtime');
  const runtimeManifest = validateCaptureRuntimeReleaseManifest(
    JSON.parse(
      await readFile(join(runtime, 'capture-runtime-manifest.json'), 'utf8'),
    ),
    input.releaseVersion,
  );
  for (const name of CAPTURE_RUNTIME_RELEASE_ASSETS) {
    await requireRegularFile(join(runtime, name), `Candidate runtime ${name}`);
  }
  await requireRegularFile(
    join(runtime, runtimeManifest.fileName),
    'Candidate runtime executable',
  );
  const executableBytes = await readFile(join(runtime, CAPTURE_RUNTIME_FILE));
  if (executableBytes.byteLength !== runtimeManifest.bytes) {
    throw new Error(
      'Candidate runtime executable byte count does not match its manifest.',
    );
  }
  if (sha256(executableBytes) !== runtimeManifest.sha256) {
    throw new Error(
      'Candidate runtime executable digest does not match its manifest.',
    );
  }
  const schemaBytes = await readFile(
    join(runtime, runtimeManifest.schemaFileName),
  );
  if (sha256(schemaBytes) !== runtimeManifest.schemaSha256) {
    throw new Error(
      'Candidate runtime schema digest does not match its manifest.',
    );
  }

  const packageNames = await readdir(join(input.candidate, 'package'));
  if (
    !packageNames.some(
      (name) =>
        name.startsWith(
          `gx-capture-capture-workbench-ui-${input.releaseVersion}`,
        ) && name.endsWith('.tgz'),
    )
  ) {
    throw new Error(
      'Candidate does not contain the Workbench package archive.',
    );
  }
  return { releaseMode: manifest.releaseMode };
}

function runNx(target: string): void {
  const result = spawnSync(
    'pnpm',
    ['nx', 'run', target, '--skip-nx-cache', '--outputStyle=static'],
    {
      cwd: resolve(import.meta.dirname, '..'),
      env: process.env,
      stdio: 'inherit',
      shell: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Consumer gate target failed: ${target}.`);
}

function currentCommit(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  if (result.status !== 0)
    throw new Error('Could not resolve the consumer commit.');
  const commit = result.stdout.trim();
  if (!GIT_SHA_PATTERN.test(commit))
    throw new Error('Consumer commit is invalid.');
  return commit;
}

export function createResult(input: {
  readonly consumerCommit: string;
  readonly workflowRunId: number;
  readonly candidateId: string;
  readonly candidateManifestSha256: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly checks: readonly {
    readonly name: string;
    readonly status: 'passed';
  }[];
}): CaptureCandidateGateResult {
  return {
    schemaVersion: '2',
    consumerRepository: CONSUMER_REPOSITORY,
    consumerCommit: input.consumerCommit,
    workflowPath: WORKFLOW_PATH,
    workflowRunId: input.workflowRunId,
    candidateId: input.candidateId,
    candidateManifestSha256: input.candidateManifestSha256,
    verdict: 'passed',
    checks: input.checks,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  };
}

async function main(): Promise<void> {
  const input = parseArguments(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const candidate = await verifyCandidate(input);
  assertCaptureRuntimeConsumerVersions();
  const checks: { name: string; status: 'passed' }[] = [
    { name: 'candidate-identity', status: 'passed' },
    { name: 'candidate-runtime-assets', status: 'passed' },
    { name: 'candidate-workbench-package', status: 'passed' },
    { name: 'consumer-version-lock', status: 'passed' },
  ];
  if (!input.skipChecks) {
    runNx('cert-prep-desktop:capture-runtime-consumer-test');
    checks.push({ name: 'capture-runtime-consumer-tests', status: 'passed' });
    runNx('cert-prep-backend:test');
    checks.push({ name: 'cert-prep-backend-tests', status: 'passed' });
    runNx('cert-prep-desktop:package-qa-test');
    checks.push({ name: 'cert-prep-desktop-package-qa', status: 'passed' });
  }
  if (candidate.releaseMode === 'model-enabled') {
    const modelCatalog = join(
      input.candidate,
      'runtime',
      'capture-engine-catalog.json',
    );
    await requireRegularFile(modelCatalog, 'Model-enabled candidate catalog');
    checks.push({ name: 'model-enabled-catalog-present', status: 'passed' });
  }
  const completedAt = new Date().toISOString();
  const result = createResult({
    consumerCommit: currentCommit(),
    workflowRunId: input.workflowRunId,
    candidateId: input.candidateId,
    candidateManifestSha256: input.candidateManifestSha256,
    startedAt,
    completedAt,
    checks,
  });
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(resolve(input.output, '..'), { recursive: true });
  await writeFile(input.output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `Cert Prep consumer gate passed for candidate ${input.candidateId}.\n`,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
