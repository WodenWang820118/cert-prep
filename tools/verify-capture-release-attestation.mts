/**
 * Verifies downloaded Capture Runtime release assets against GitHub artifact
 * attestations before a desktop release bundles them.
 *
 * The full Capture release attests `capture-release-manifest-v1.json`, which
 * lists the SHA-256 of every runtime and desktop asset. This script verifies
 * that manifest's attestation, requires the exact signer workflow (gh's
 * `--signer-workflow` is only a prefix match), then checks each downloaded
 * asset against the manifest. An asset the manifest does not list must carry
 * its own attestation from `--unlisted-signer-workflow`, or verification fails.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const WORKFLOW_PATTERN =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const FILE_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u;
const GITHUB = 'https://github.com/';

export type GhResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

/** Runs `gh` with the given arguments; injected so tests need no network. */
export type GhRunner = (args: readonly string[]) => GhResult;

export type VerifyCaptureReleaseOptions = {
  readonly repo: string;
  readonly tag: string;
  readonly signerWorkflow: string;
  readonly releaseManifest: string;
  readonly directory: string;
  readonly assets: readonly string[];
  readonly unlistedSignerWorkflow?: string;
};

export type VerifiedAsset = {
  readonly name: string;
  readonly sha256: string;
  readonly evidence: 'release-manifest' | 'own-attestation';
};

function runGh(args: readonly string[]): GhResult {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function parseArguments(
  args: readonly string[],
): VerifyCaptureReleaseOptions {
  const values = new Map<string, string>();
  const assets: string[] = [];
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error('Arguments must be --name value pairs.');
    }
    if (name === '--asset') {
      assets.push(value);
      continue;
    }
    if (values.has(name)) throw new Error(`Duplicate argument: ${name}.`);
    values.set(name, value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`Missing required argument: ${name}.`);
    values.delete(name);
    return value;
  };
  const options = {
    repo: required('--repo'),
    tag: required('--tag'),
    signerWorkflow: required('--signer-workflow'),
    releaseManifest: resolve(required('--release-manifest')),
    directory: resolve(required('--directory')),
    assets,
    unlistedSignerWorkflow: values.get('--unlisted-signer-workflow'),
  };
  values.delete('--unlisted-signer-workflow');
  if (values.size > 0) {
    throw new Error(`Unknown argument: ${[...values.keys()].join(', ')}.`);
  }
  return options;
}

function assertOptions(options: VerifyCaptureReleaseOptions): void {
  if (!REPOSITORY_PATTERN.test(options.repo))
    throw new Error('--repo must be <owner>/<repo>.');
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(options.tag))
    throw new Error('--tag must be a v-prefixed SemVer tag.');
  for (const workflow of [
    options.signerWorkflow,
    options.unlistedSignerWorkflow,
  ]) {
    if (workflow === undefined) continue;
    if (
      !WORKFLOW_PATTERN.test(workflow) ||
      !workflow.startsWith(`${options.repo}/`)
    ) {
      throw new Error(
        `Signer workflow must be ${options.repo}/.github/workflows/<file>.yml: ${workflow}.`,
      );
    }
  }
  if (options.assets.length === 0)
    throw new Error('At least one --asset is required.');
  const seen = new Set<string>();
  for (const asset of options.assets) {
    if (!FILE_NAME_PATTERN.test(asset))
      throw new Error(`Asset must be a plain file name: ${asset}.`);
    if (seen.has(asset)) throw new Error(`Duplicate asset: ${asset}.`);
    seen.add(asset);
  }
}

async function sha256File(path: string, label: string): Promise<string> {
  let details: Awaited<ReturnType<typeof lstat>>;
  try {
    details = await lstat(path);
  } catch {
    throw new Error(`${label} is missing.`);
  }
  if (!details.isFile()) throw new Error(`${label} must be a regular file.`);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Verifies `path` with `gh attestation verify` and fails closed unless an
 * attestation was signed by exactly `signerWorkflow` for `repo`.
 */
function verifyAttestation(
  gh: GhRunner,
  path: string,
  repo: string,
  signerWorkflow: string,
): void {
  const label = basename(path);
  const result = gh([
    'attestation',
    'verify',
    path,
    '--repo',
    repo,
    '--signer-workflow',
    signerWorkflow,
    '--deny-self-hosted-runners',
    '--format',
    'json',
  ]);
  if (result.status !== 0) {
    throw new Error(
      `${label} has no attestation from ${signerWorkflow}: ${result.stderr.trim() || `gh exited with ${result.status}`}`,
    );
  }
  let verified: unknown;
  try {
    verified = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `gh attestation verify returned invalid JSON for ${label}.`,
    );
  }
  const signer = `${GITHUB}${signerWorkflow}@`;
  const exact =
    Array.isArray(verified) &&
    verified.some((entry: unknown) => {
      if (!isRecord(entry) || !isRecord(entry.verificationResult)) return false;
      const signature = entry.verificationResult.signature;
      if (!isRecord(signature) || !isRecord(signature.certificate))
        return false;
      const certificate = signature.certificate;
      return (
        typeof certificate.buildSignerURI === 'string' &&
        certificate.buildSignerURI.startsWith(signer) &&
        certificate.sourceRepositoryURI === `${GITHUB}${repo}`
      );
    });
  if (!exact) {
    throw new Error(
      `${label} is not attested by exactly ${signerWorkflow} in ${repo}.`,
    );
  }
}

/** Maps each asset file name to the SHA-256 the attested manifest records. */
function attestedDigests(manifest: unknown, tag: string): Map<string, string> {
  if (
    !isRecord(manifest) ||
    manifest.schemaVersion !== '1' ||
    manifest.status !== 'released' ||
    manifest.releaseTag !== tag ||
    manifest.releaseVersion !== tag.slice(1) ||
    !Array.isArray(manifest.runtimeAssets) ||
    !isRecord(manifest.components)
  ) {
    throw new Error(
      `Capture release manifest is not the released manifest for ${tag}.`,
    );
  }
  const digests = new Map<string, string>();
  const add = (name: unknown, sha256: unknown): void => {
    if (
      typeof name !== 'string' ||
      !FILE_NAME_PATTERN.test(name) ||
      typeof sha256 !== 'string' ||
      !SHA256_PATTERN.test(sha256)
    ) {
      throw new Error('Capture release manifest has an invalid asset entry.');
    }
    if (digests.has(name))
      throw new Error(`Capture release manifest lists ${name} twice.`);
    digests.set(name, sha256);
  };
  for (const entry of manifest.runtimeAssets) {
    if (!isRecord(entry) || typeof entry.path !== 'string')
      throw new Error('Capture release manifest has an invalid asset entry.');
    const match = /^(?:runtime|desktop)\/([^/]+)$/u.exec(entry.path);
    if (!match)
      throw new Error(`Unexpected release manifest asset path: ${entry.path}.`);
    add(match[1], entry.sha256);
  }
  add('candidate-manifest.json', manifest.components.candidateManifestSha256);
  add(
    manifest.components.contractSnapshotAssetName,
    manifest.components.contractSnapshotSha256,
  );
  return digests;
}

export async function verifyCaptureReleaseAttestation(
  options: VerifyCaptureReleaseOptions,
  gh: GhRunner = runGh,
): Promise<readonly VerifiedAsset[]> {
  assertOptions(options);
  await sha256File(options.releaseManifest, 'Capture release manifest');
  verifyAttestation(
    gh,
    options.releaseManifest,
    options.repo,
    options.signerWorkflow,
  );
  const digests = attestedDigests(
    JSON.parse(await readFile(options.releaseManifest, 'utf8')),
    options.tag,
  );
  const verified: VerifiedAsset[] = [];
  for (const name of options.assets) {
    const path = join(options.directory, name);
    const sha256 = await sha256File(path, name);
    const expected = digests.get(name);
    if (expected !== undefined) {
      if (sha256 !== expected) {
        throw new Error(
          `${name} does not match the attested release manifest (expected ${expected}, found ${sha256}).`,
        );
      }
      verified.push({ name, sha256, evidence: 'release-manifest' });
      continue;
    }
    if (!options.unlistedSignerWorkflow) {
      throw new Error(
        `${name} is not listed in the attested release manifest.`,
      );
    }
    verifyAttestation(gh, path, options.repo, options.unlistedSignerWorkflow);
    verified.push({ name, sha256, evidence: 'own-attestation' });
  }
  return verified;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const verified = await verifyCaptureReleaseAttestation(options);
  for (const asset of verified) {
    process.stdout.write(
      `verified ${asset.name} sha256:${asset.sha256} (${asset.evidence})\n`,
    );
  }
  process.stdout.write(
    `All ${verified.length} Capture ${options.tag} assets are attested by ${options.repo}.\n`,
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
