import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  type GhRunner,
  parseArguments,
  verifyCaptureReleaseAttestation,
} from './verify-capture-release-attestation.mts';

const REPO = 'gx-capture/capture-workbench';
const FULL = `${REPO}/.github/workflows/_publish-github-release.yml`;
const ROUTE_A = `${REPO}/.github/workflows/_publish-runtime-github-release.yml`;
const TAG = 'v0.8.0';
const RUNTIME = 'capture-runtime-x86_64-pc-windows-msvc.exe';
const SCHEMA = 'capture-document-v2.schema.json';
const RUNTIME_CANDIDATE = 'capture-runtime-candidate-manifest.json';

const sha256 = (bytes: string | Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

/** A fake `gh` that, like the real one, matches --signer-workflow as a prefix. */
function fakeGh(attestations: Map<string, readonly string[]>): {
  gh: GhRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const gh: GhRunner = (args) => {
    calls.push([...args]);
    const path = args[2] as string;
    const signer = args[args.indexOf('--signer-workflow') + 1] as string;
    const repo = args[args.indexOf('--repo') + 1] as string;
    const digest = sha256(readFileSync(path));
    const signers = attestations.get(digest);
    if (!signers) {
      return { status: 1, stdout: '', stderr: 'HTTP 404: Not Found' };
    }
    const matching = signers.filter((workflow) => workflow.startsWith(signer));
    if (matching.length === 0) {
      return {
        status: 1,
        stdout: '',
        stderr: 'expected SubjectAlternativeName to match',
      };
    }
    return {
      status: 0,
      stderr: '',
      stdout: JSON.stringify(
        matching.map((workflow) => ({
          verificationResult: {
            signature: {
              certificate: {
                buildSignerURI: `https://github.com/${workflow}@refs/heads/main`,
                sourceRepositoryURI: `https://github.com/${repo}`,
              },
            },
          },
        })),
      ),
    };
  };
  return { gh, calls };
}

async function withRelease(
  run: (fixture: {
    directory: string;
    manifest: string;
    manifestSha256: string;
    digests: Record<string, string>;
  }) => Promise<void>,
  manifestOverrides: Record<string, unknown> = {},
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'cert-capture-attestation-'));
  try {
    const files: Record<string, string> = {
      [RUNTIME]: 'runtime-bytes',
      [SCHEMA]: '{"schema":true}\n',
      [RUNTIME_CANDIDATE]: '{"candidateKind":"runtime"}\n',
    };
    const digests: Record<string, string> = {};
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(directory, name), content);
      digests[name] = sha256(content);
    }
    const manifest = join(directory, 'capture-release-manifest-v1.json');
    const manifestBody = JSON.stringify({
      schemaVersion: '1',
      status: 'released',
      releaseTag: TAG,
      releaseVersion: '0.8.0',
      components: {
        candidateManifestSha256: 'a'.repeat(64),
        contractSnapshotSha256: 'b'.repeat(64),
        contractSnapshotAssetName: 'capture-contract-snapshot.json',
      },
      runtimeAssets: [
        { path: `runtime/${RUNTIME}`, sha256: digests[RUNTIME] },
        { path: `runtime/${SCHEMA}`, sha256: digests[SCHEMA] },
      ],
      ...manifestOverrides,
    });
    await writeFile(manifest, manifestBody);
    await run({
      directory,
      manifest,
      manifestSha256: sha256(manifestBody),
      digests,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const options = (
  directory: string,
  releaseManifest: string,
  assets: readonly string[],
  unlistedSignerWorkflow?: string,
) => ({
  repo: REPO,
  tag: TAG,
  signerWorkflow: FULL,
  releaseManifest,
  directory,
  assets,
  unlistedSignerWorkflow,
});

test('accepts assets listed in the attested manifest and unlisted assets with their own attestation', async () => {
  await withRelease(
    async ({ directory, manifest, manifestSha256, digests }) => {
      const { gh, calls } = fakeGh(
        new Map([
          [manifestSha256, [FULL]],
          [digests[RUNTIME_CANDIDATE] as string, [ROUTE_A]],
        ]),
      );
      const verified = await verifyCaptureReleaseAttestation(
        options(
          directory,
          manifest,
          [RUNTIME, SCHEMA, RUNTIME_CANDIDATE],
          ROUTE_A,
        ),
        gh,
      );
      assert.deepEqual(
        verified.map(({ name, evidence }) => [name, evidence]),
        [
          [RUNTIME, 'release-manifest'],
          [SCHEMA, 'release-manifest'],
          [RUNTIME_CANDIDATE, 'own-attestation'],
        ],
      );
      assert.equal(calls.length, 2);
      assert.ok(calls[0]?.includes('--deny-self-hosted-runners'));
    },
  );
});

test('rejects an asset whose SHA-256 differs from the attested manifest', async () => {
  await withRelease(async ({ directory, manifest, manifestSha256 }) => {
    await writeFile(join(directory, RUNTIME), 'tampered-runtime-bytes');
    const { gh } = fakeGh(new Map([[manifestSha256, [FULL]]]));
    await assert.rejects(
      verifyCaptureReleaseAttestation(
        options(directory, manifest, [RUNTIME]),
        gh,
      ),
      /capture-runtime-x86_64-pc-windows-msvc\.exe does not match the attested release manifest/u,
    );
  });
});

test('rejects a release manifest without an attestation', async () => {
  await withRelease(async ({ directory, manifest }) => {
    const { gh } = fakeGh(new Map());
    await assert.rejects(
      verifyCaptureReleaseAttestation(
        options(directory, manifest, [RUNTIME]),
        gh,
      ),
      /has no attestation from .*_publish-github-release\.yml: HTTP 404/u,
    );
  });
});

test('rejects a manifest attested only by another workflow', async () => {
  await withRelease(async ({ directory, manifest, manifestSha256 }) => {
    const { gh } = fakeGh(new Map([[manifestSha256, [ROUTE_A]]]));
    await assert.rejects(
      verifyCaptureReleaseAttestation(
        options(directory, manifest, [RUNTIME]),
        gh,
      ),
      /has no attestation from/u,
    );
  });
});

test('rejects a signer workflow that only shares the expected prefix', async () => {
  await withRelease(async ({ directory, manifest, manifestSha256 }) => {
    const lookalike = `${REPO}/.github/workflows/_publish-github-release.yml-copy.yml`;
    const { gh } = fakeGh(new Map([[manifestSha256, [lookalike]]]));
    await assert.rejects(
      verifyCaptureReleaseAttestation(
        options(directory, manifest, [RUNTIME]),
        gh,
      ),
      /is not attested by exactly .*_publish-github-release\.yml/u,
    );
  });
});

test('rejects an unlisted asset unless its own attestation has the unlisted signer', async () => {
  await withRelease(
    async ({ directory, manifest, manifestSha256, digests }) => {
      const { gh } = fakeGh(
        new Map([
          [manifestSha256, [FULL]],
          [digests[RUNTIME_CANDIDATE] as string, [FULL]],
        ]),
      );
      await assert.rejects(
        verifyCaptureReleaseAttestation(
          options(directory, manifest, [RUNTIME_CANDIDATE]),
          gh,
        ),
        /is not listed in the attested release manifest/u,
      );
      await assert.rejects(
        verifyCaptureReleaseAttestation(
          options(directory, manifest, [RUNTIME_CANDIDATE], ROUTE_A),
          gh,
        ),
        /capture-runtime-candidate-manifest\.json has no attestation from .*_publish-runtime-github-release\.yml/u,
      );
    },
  );
});

test('rejects an attested manifest for another release', async () => {
  await withRelease(
    async ({ directory, manifest, manifestSha256 }) => {
      const { gh } = fakeGh(new Map([[manifestSha256, [FULL]]]));
      await assert.rejects(
        verifyCaptureReleaseAttestation(
          options(directory, manifest, [RUNTIME]),
          gh,
        ),
        /not the released manifest for v0\.8\.0/u,
      );
    },
    { releaseTag: 'v0.7.2', releaseVersion: '0.7.2' },
  );
});

test('parses repeated assets and rejects unknown or path-like arguments', async () => {
  const parsed = parseArguments([
    '--repo',
    REPO,
    '--tag',
    TAG,
    '--signer-workflow',
    FULL,
    '--release-manifest',
    'manifest.json',
    '--directory',
    'runtime',
    '--asset',
    RUNTIME,
    '--asset',
    SCHEMA,
  ]);
  assert.deepEqual(parsed.assets, [RUNTIME, SCHEMA]);
  assert.equal(parsed.unlistedSignerWorkflow, undefined);
  assert.throws(
    () => parseArguments(['--repo', REPO, '--bogus', 'x']),
    /Missing required argument|Unknown argument/u,
  );
  await assert.rejects(
    verifyCaptureReleaseAttestation(
      { ...parsed, assets: ['../escape.exe'] },
      fakeGh(new Map()).gh,
    ),
    /Asset must be a plain file name/u,
  );
});
