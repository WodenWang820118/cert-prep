import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ALPHA_VERSION,
  PYTHON_RUNTIME_VERSION,
} from './package-qa/constants.mts';

const WINDOWSML_RELEASE_BASE_URL_ENV = 'CERT_PREP_WINDOWSML_OCR_ASSET_BASE_URL';
const ALPHA_RELEASE_TAG = `cert-prep-v${ALPHA_VERSION}`;

type RuntimeResourceMode = 'dev' | 'release';

interface RuntimeManifest {
  readonly schema_version?: number;
  readonly kind: string;
  readonly version: string;
  readonly target: string;
  readonly entrypoint: string;
  readonly artifact: {
    readonly file_name: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly url?: string | null;
  };
}

interface PrepareRuntimeResourcesOptions {
  readonly workspaceRoot: string;
  readonly mode: RuntimeResourceMode;
  readonly outputDir?: string;
  readonly backendRuntimeRoot?: string;
  readonly windowsmlRuntimeRoot?: string;
  readonly windowsmlReleaseBaseUrl?: string;
}

interface PreparedRuntimeResources {
  readonly outputDir: string;
  readonly backendManifestPath: string;
  readonly backendArtifactPath: string;
  readonly windowsmlManifestPath: string;
  readonly releaseMetadataPath: string;
}

/**
 * Produces the only resource directory consumed by Tauri.
 *
 * Release mode is fail-closed: the backend is bundled and the OCR URL must be
 * an HTTPS GitHub Release URL. Dev mode is deliberately separate and may use a
 * local file URL for the large OCR artifact.
 */
export async function prepareRuntimeResources({
  workspaceRoot,
  mode,
  outputDir = join(
    workspaceRoot,
    'apps/cert-prep-desktop/src-tauri/generated-resources',
  ),
  backendRuntimeRoot = join(
    workspaceRoot,
    'apps/cert-prep-backend/dist/backend-runtime',
  ),
  windowsmlRuntimeRoot = join(
    workspaceRoot,
    'apps/cert-prep-backend/dist/ocr-windowsml-runtime',
  ),
  windowsmlReleaseBaseUrl,
}: PrepareRuntimeResourcesOptions): Promise<PreparedRuntimeResources> {
  const backendSourceManifest = join(
    backendRuntimeRoot,
    'backend-runtime-manifest.json',
  );
  const windowsmlSourceManifest = join(
    windowsmlRuntimeRoot,
    'windowsml-ocr-runtime-manifest.json',
  );
  const backendManifest = await loadAndVerifyManifest(
    backendSourceManifest,
    backendRuntimeRoot,
    'python_backend',
  );
  const windowsmlManifest = await loadAndVerifyManifest(
    windowsmlSourceManifest,
    windowsmlRuntimeRoot,
    'windowsml_ocr',
  );

  const backendSourceArtifact = join(
    backendRuntimeRoot,
    backendManifest.artifact.file_name,
  );
  const windowsmlSourceArtifact = join(
    windowsmlRuntimeRoot,
    windowsmlManifest.artifact.file_name,
  );
  const windowsmlUrl =
    mode === 'release'
      ? releaseAssetUrl(
          windowsmlReleaseBaseUrl ??
            process.env[WINDOWSML_RELEASE_BASE_URL_ENV],
          windowsmlManifest.artifact.file_name,
        )
      : pathToFileURL(windowsmlSourceArtifact).href;

  mkdirSync(outputDir, { recursive: true });
  for (const entry of readdirSync(outputDir, { withFileTypes: true })) {
    if (entry.name !== '.gitkeep') {
      rmSync(join(outputDir, entry.name), { recursive: true, force: true });
    }
  }

  const backendArtifactPath = join(
    outputDir,
    backendManifest.artifact.file_name,
  );
  copyFileSync(backendSourceArtifact, backendArtifactPath);
  const backendManifestPath = join(outputDir, 'backend-runtime-manifest.json');
  writeManifest(backendManifestPath, {
    ...backendManifest,
    artifact: { ...backendManifest.artifact, url: null },
  });

  const windowsmlManifestPath = join(
    outputDir,
    'windowsml-ocr-runtime-manifest.json',
  );
  writeManifest(windowsmlManifestPath, {
    ...windowsmlManifest,
    artifact: { ...windowsmlManifest.artifact, url: windowsmlUrl },
  });
  const releaseMetadataPath = join(outputDir, 'release-metadata.json');
  writeFileSync(
    releaseMetadataPath,
    `${JSON.stringify(
      releaseMetadata(mode, backendManifest, windowsmlManifest),
      null,
      2,
    )}\n`,
    'utf8',
  );

  return {
    outputDir,
    backendManifestPath,
    backendArtifactPath,
    windowsmlManifestPath,
    releaseMetadataPath,
  };
}

async function loadAndVerifyManifest(
  manifestPath: string,
  runtimeRoot: string,
  expectedKind: string,
): Promise<RuntimeManifest> {
  if (!existsSync(manifestPath)) {
    throw new Error(`Runtime manifest was not built: ${manifestPath}`);
  }
  const manifest = JSON.parse(
    readFileSync(manifestPath, 'utf8'),
  ) as Partial<RuntimeManifest>;
  if (
    manifest.kind !== expectedKind ||
    typeof manifest.version !== 'string' ||
    typeof manifest.target !== 'string' ||
    typeof manifest.entrypoint !== 'string' ||
    !manifest.artifact ||
    typeof manifest.artifact.file_name !== 'string' ||
    typeof manifest.artifact.sha256 !== 'string' ||
    typeof manifest.artifact.bytes !== 'number'
  ) {
    throw new Error(
      `Invalid ${expectedKind} runtime manifest: ${manifestPath}`,
    );
  }
  if (manifest.version !== ALPHA_VERSION) {
    throw new Error(
      `${expectedKind} runtime version must be ${ALPHA_VERSION}, found ${manifest.version}.`,
    );
  }
  if (
    basename(manifest.artifact.file_name) !== manifest.artifact.file_name ||
    !manifest.artifact.file_name.endsWith('.zip')
  ) {
    throw new Error(
      `${expectedKind} artifact file_name must be a plain ZIP file name.`,
    );
  }
  const expectedArtifactName = `${
    expectedKind === 'python_backend'
      ? 'cert-prep-backend-runtime'
      : 'cert-prep-ocr-windowsml-runtime'
  }-${ALPHA_VERSION}-${manifest.target}.zip`;
  if (manifest.artifact.file_name !== expectedArtifactName) {
    throw new Error(
      `${expectedKind} artifact name must be ${expectedArtifactName}.`,
    );
  }
  const artifactPath = join(runtimeRoot, manifest.artifact.file_name);
  if (!existsSync(artifactPath)) {
    throw new Error(`Runtime artifact was not built: ${artifactPath}`);
  }
  const actualBytes = statSync(artifactPath).size;
  if (actualBytes !== manifest.artifact.bytes) {
    throw new Error(
      `${expectedKind} artifact size mismatch: expected ${manifest.artifact.bytes}, found ${actualBytes}.`,
    );
  }
  const actualHash = await sha256File(artifactPath);
  if (actualHash !== manifest.artifact.sha256.toLowerCase()) {
    throw new Error(`${expectedKind} artifact checksum mismatch.`);
  }
  return manifest as RuntimeManifest;
}

function releaseAssetUrl(
  baseUrlValue: string | undefined,
  fileName: string,
): string {
  const value = baseUrlValue?.trim();
  if (!value) {
    throw new Error(
      `${WINDOWSML_RELEASE_BASE_URL_ENV} is required in release mode.`,
    );
  }
  let url: URL;
  try {
    url = new URL(value.endsWith('/') ? value : `${value}/`);
  } catch {
    throw new Error(`${WINDOWSML_RELEASE_BASE_URL_ENV} must be a valid URL.`);
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'github.com' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/$/.test(url.pathname) ||
    !url.pathname.endsWith(`/releases/download/${ALPHA_RELEASE_TAG}/`)
  ) {
    throw new Error(
      `${WINDOWSML_RELEASE_BASE_URL_ENV} must use the ${ALPHA_RELEASE_TAG} GitHub Release URL.`,
    );
  }
  return new URL(encodeURIComponent(fileName), url).href;
}

function writeManifest(path: string, manifest: RuntimeManifest): void {
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function releaseMetadata(
  mode: RuntimeResourceMode,
  backend: RuntimeManifest,
  windowsml: RuntimeManifest,
): object {
  const localNonpublishable = mode === 'dev';
  return {
    schema_version: 1,
    version: ALPHA_VERSION,
    python_runtime_version: PYTHON_RUNTIME_VERSION,
    release_tag: localNonpublishable
      ? `cert-prep-local-v${ALPHA_VERSION}`
      : ALPHA_RELEASE_TAG,
    channel: localNonpublishable
      ? 'local_nonpublishable'
      : 'unsigned_public_alpha',
    distribution_profile: localNonpublishable
      ? 'local_nonpublishable'
      : 'public_unsigned_alpha',
    publishable: !localNonpublishable,
    distribution_mode: mode,
    signed: false,
    platform: {
      os: 'windows',
      minimum_version: 'Windows 11',
      arch: 'x86_64',
      target: backend.target,
    },
    warnings: {
      smartscreen: localNonpublishable
        ? 'This local acceptance build is unsigned and cannot be published.'
        : 'This public Alpha is unsigned. Windows SmartScreen is expected to warn before installation.',
      production_ready: false,
    },
    sha256_verification: {
      required: true,
      algorithm: 'SHA-256',
      instruction: localNonpublishable
        ? 'Compare the local WindowsML OCR ZIP with the SHA-256 value in its bundled manifest.'
        : 'Compare Get-FileHash -Algorithm SHA256 output with the SHA256SUMS.txt value published on the same GitHub Release.',
    },
    runtime_assets: {
      backend: {
        distribution: 'bundled',
        file_name: backend.artifact.file_name,
        sha256: backend.artifact.sha256,
        bytes: backend.artifact.bytes,
      },
      windowsml_ocr: {
        distribution: localNonpublishable
          ? 'local_file'
          : 'github_release_download',
        file_name: windowsml.artifact.file_name,
        sha256: windowsml.artifact.sha256,
        bytes: windowsml.artifact.bytes,
      },
    },
    legal_resources: {
      license: 'legal/LICENSE',
      privacy: 'legal/PRIVACY.md',
      changelog: 'legal/CHANGELOG.md',
      third_party_notices: 'legal/THIRD_PARTY_NOTICES.md',
    },
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolvePromise);
  });
  return hash.digest('hex');
}

interface ParsedArgs {
  readonly mode: RuntimeResourceMode;
  readonly windowsmlReleaseBaseUrl?: string;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  let mode: RuntimeResourceMode | undefined;
  let windowsmlReleaseBaseUrl: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = (): string => {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a value.`);
      index += 1;
      return value;
    };
    if (arg === '--mode') {
      const value = next();
      if (value !== 'dev' && value !== 'release') {
        throw new Error('--mode must be dev or release.');
      }
      mode = value;
    } else if (arg === '--ocr-release-base-url') {
      windowsmlReleaseBaseUrl = next();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!mode) throw new Error('--mode is required.');
  return { mode, windowsmlReleaseBaseUrl };
}

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const workspaceRoot = resolve(scriptDir, '../../..');
  const args = parseArgs(process.argv.slice(2));
  const result = await prepareRuntimeResources({
    workspaceRoot,
    mode: args.mode,
    windowsmlReleaseBaseUrl: args.windowsmlReleaseBaseUrl,
  });
  console.log(
    `Prepared ${args.mode} runtime resources under ${result.outputDir}`,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
