import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import {
  collectPackagedResourceArtifacts,
  publicFileRecord,
  sha256File,
} from './files.mts';
import type { PackagedResourceContract, RuntimeManifest } from './types.mts';
import {
  ALPHA_VERSION,
  BACKEND_RUNTIME_PREFIX,
  DEFAULT_TARGET_TRIPLE,
  PYTHON_RUNTIME_VERSION,
  WINDOWSML_OCR_RUNTIME_PREFIX,
  WINDOWS_MSI_VERSION,
} from './constants.mts';

interface ValidateResourceContractOptions {
  readonly resourceRoot: string;
  readonly tauriConfig: string;
  readonly workspaceRoot: string;
  readonly expectedTargetTriple?: string;
}

/** Proves the hybrid distribution shape copied beside the packaged executable. */
export function validatePackagedResourceContract({
  resourceRoot,
  tauriConfig,
  workspaceRoot,
  expectedTargetTriple = DEFAULT_TARGET_TRIPLE,
}: ValidateResourceContractOptions): PackagedResourceContract {
  if (!existsSync(resourceRoot)) {
    throw new Error(
      `Packaged resource directory was not found: ${resourceRoot}`,
    );
  }
  validateTauriResourceMapping(tauriConfig);
  const backendManifestPath = join(
    resourceRoot,
    'backend-runtime-manifest.json',
  );
  const windowsmlManifestPath = join(
    resourceRoot,
    'windowsml-ocr-runtime-manifest.json',
  );
  const backendManifest = loadAndValidateManifest(
    backendManifestPath,
    'python_backend',
    BACKEND_RUNTIME_PREFIX,
  );
  const windowsmlManifest = loadAndValidateManifest(
    windowsmlManifestPath,
    'windowsml_ocr',
    WINDOWSML_OCR_RUNTIME_PREFIX,
  );
  if (
    backendManifest.target !== expectedTargetTriple ||
    windowsmlManifest.target !== expectedTargetTriple
  ) {
    throw new Error(
      `Packaged runtime target must be ${expectedTargetTriple}; found backend=${backendManifest.target}, windowsml=${windowsmlManifest.target}.`,
    );
  }
  validateDistributionPolicy(backendManifest, windowsmlManifest);
  const files = collectPackagedResourceArtifacts(resourceRoot, workspaceRoot);
  const names = new Set(files.map((file) => basename(file.absolutePath)));
  for (const required of [
    'backend-runtime-manifest.json',
    backendManifest.artifact.file_name,
    'windowsml-ocr-runtime-manifest.json',
    'release-metadata.json',
  ]) {
    if (!names.has(required)) {
      throw new Error(`Packaged runtime resource is missing: ${required}`);
    }
  }
  if (names.has(windowsmlManifest.artifact.file_name)) {
    throw new Error(
      `WindowsML OCR runtime must not be bundled: ${windowsmlManifest.artifact.file_name}`,
    );
  }
  const bundledZipNames = [...names].filter((name) => name.endsWith('.zip'));
  if (
    bundledZipNames.length !== 1 ||
    bundledZipNames[0] !== backendManifest.artifact.file_name
  ) {
    throw new Error(
      `Packaged resources must contain exactly the declared backend ZIP; found: ${bundledZipNames.join(', ') || 'none'}.`,
    );
  }
  validateBundledBackendArtifact(resourceRoot, backendManifest);
  const metadata = loadReleaseMetadata(
    join(resourceRoot, 'release-metadata.json'),
  );
  validateReleaseMetadata(metadata, backendManifest, windowsmlManifest);
  const legalFiles = validateLegalResources(
    dirname(resourceRoot),
    workspaceRoot,
  );
  rejectDevelopmentReferences(
    resourceRoot,
    files.map((file) => file.absolutePath),
    workspaceRoot,
  );
  return {
    evidence_scope: 'static_tauri_release_resources',
    installer_contents_verified: false,
    fresh_install_verified: false,
    alpha_release_gate: 'blocked_pending_clean_install',
    backend_bundled: true,
    windowsml_ocr_bundled: false,
    release_urls_only: true,
    version: ALPHA_VERSION,
    windows_msi_version: WINDOWS_MSI_VERSION,
    python_runtime_version: PYTHON_RUNTIME_VERSION,
    channel: 'unsigned_public_alpha',
    signed: false,
    target: backendManifest.target,
    tauri_resource_mapping: 'generated-resources/* -> resources/ plus legal/*',
    resource_files: files.map(publicFileRecord),
    legal_files: legalFiles,
  };
}

function loadAndValidateManifest(
  path: string,
  expectedKind: string,
  artifactPrefix: string,
): RuntimeManifest {
  if (!existsSync(path)) {
    throw new Error(`Packaged runtime manifest is missing: ${basename(path)}`);
  }
  const manifest = JSON.parse(
    readFileSync(path, 'utf8'),
  ) as Partial<RuntimeManifest>;
  const artifact = manifest.artifact;
  if (
    manifest.kind !== expectedKind ||
    manifest.version !== ALPHA_VERSION ||
    typeof manifest.target !== 'string' ||
    manifest.target.trim() === '' ||
    typeof manifest.entrypoint !== 'string' ||
    manifest.entrypoint.trim() === '' ||
    !artifact ||
    typeof artifact.file_name !== 'string' ||
    basename(artifact.file_name) !== artifact.file_name ||
    artifact.file_name !== `${artifactPrefix}${manifest.target}.zip` ||
    typeof artifact.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.bytes) ||
    artifact.bytes < 1
  ) {
    throw new Error(`Invalid packaged ${expectedKind} runtime manifest.`);
  }
  return manifest as RuntimeManifest;
}

function validateDistributionPolicy(
  backendManifest: RuntimeManifest,
  windowsmlManifest: RuntimeManifest,
): void {
  if (backendManifest.artifact.url !== null) {
    throw new Error('Bundled backend manifest must use artifact.url: null.');
  }
  const rawUrl = windowsmlManifest.artifact.url;
  if (typeof rawUrl !== 'string') {
    throw new Error('WindowsML OCR manifest must use a GitHub Release URL.');
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(
      'WindowsML OCR manifest must use a valid GitHub Release URL.',
    );
  }
  const expectedSuffix = `/releases/download/cert-prep-v${ALPHA_VERSION}/${encodeURIComponent(
    windowsmlManifest.artifact.file_name,
  )}`;
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'github.com' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/[^/]+\/[^/]+\/releases\/download\//.test(url.pathname) ||
    !url.pathname.endsWith(expectedSuffix)
  ) {
    throw new Error(
      'WindowsML OCR manifest must use the versioned GitHub Release URL.',
    );
  }
}

function validateBundledBackendArtifact(
  resourceRoot: string,
  manifest: RuntimeManifest,
): void {
  const artifactPath = join(resourceRoot, manifest.artifact.file_name);
  if (!existsSync(artifactPath) || !statSync(artifactPath).isFile()) {
    throw new Error('Declared bundled backend artifact is missing.');
  }
  if (statSync(artifactPath).size !== manifest.artifact.bytes) {
    throw new Error(
      'Bundled backend artifact byte count does not match its manifest.',
    );
  }
  if (sha256File(artifactPath) !== manifest.artifact.sha256.toLowerCase()) {
    throw new Error(
      'Bundled backend artifact checksum does not match its manifest.',
    );
  }
}

function validateTauriResourceMapping(path: string): void {
  if (!existsSync(path)) {
    throw new Error(`Tauri config was not found: ${path}`);
  }
  const config = JSON.parse(readFileSync(path, 'utf8')) as {
    bundle?: {
      resources?: unknown;
      windows?: { wix?: { version?: string } };
    };
  };
  const resources = config.bundle?.resources;
  if (
    !resources ||
    Array.isArray(resources) ||
    typeof resources !== 'object' ||
    (resources as Record<string, unknown>)['generated-resources/*'] !==
      'resources/' ||
    (resources as Record<string, unknown>)['../../../LICENSE'] !==
      'legal/LICENSE' ||
    (resources as Record<string, unknown>)['../../../PRIVACY.md'] !==
      'legal/PRIVACY.md' ||
    (resources as Record<string, unknown>)['../../../CHANGELOG.md'] !==
      'legal/CHANGELOG.md' ||
    (resources as Record<string, unknown>)[
      '../../../THIRD_PARTY_NOTICES.md'
    ] !== 'legal/THIRD_PARTY_NOTICES.md' ||
    config.bundle?.windows?.wix?.version !== WINDOWS_MSI_VERSION
  ) {
    throw new Error(
      'Tauri must map generated runtime resources and legal documents into packaged resource paths.',
    );
  }
}

interface ReleaseMetadata {
  readonly schema_version: number;
  readonly version: string;
  readonly windows_msi_version: string;
  readonly python_runtime_version: string;
  readonly release_tag: string;
  readonly channel: string;
  readonly distribution_mode: string;
  readonly signed: boolean;
  readonly warnings?: {
    readonly smartscreen?: string;
    readonly production_ready?: boolean;
  };
  readonly sha256_verification?: {
    readonly required?: boolean;
    readonly algorithm?: string;
  };
  readonly runtime_assets?: {
    readonly backend?: {
      readonly file_name?: string;
      readonly sha256?: string;
      readonly bytes?: number;
    };
    readonly windowsml_ocr?: {
      readonly file_name?: string;
      readonly sha256?: string;
      readonly bytes?: number;
    };
  };
}

function loadReleaseMetadata(path: string): ReleaseMetadata {
  return JSON.parse(readFileSync(path, 'utf8')) as ReleaseMetadata;
}

function validateReleaseMetadata(
  metadata: ReleaseMetadata,
  backend: RuntimeManifest,
  windowsml: RuntimeManifest,
): void {
  if (
    metadata.schema_version !== 1 ||
    backend.version !== ALPHA_VERSION ||
    windowsml.version !== ALPHA_VERSION ||
    metadata.version !== ALPHA_VERSION ||
    metadata.windows_msi_version !== WINDOWS_MSI_VERSION ||
    metadata.python_runtime_version !== PYTHON_RUNTIME_VERSION ||
    metadata.release_tag !== `cert-prep-v${ALPHA_VERSION}` ||
    metadata.channel !== 'unsigned_public_alpha' ||
    metadata.distribution_mode !== 'release' ||
    metadata.signed !== false ||
    metadata.warnings?.production_ready !== false ||
    !metadata.warnings.smartscreen ||
    metadata.sha256_verification?.required !== true ||
    metadata.sha256_verification.algorithm !== 'SHA-256'
  ) {
    throw new Error(
      'Release metadata does not declare the unsigned public Alpha contract.',
    );
  }
  for (const [name, actual, expected] of [
    ['backend', metadata.runtime_assets?.backend, backend.artifact],
    [
      'windowsml_ocr',
      metadata.runtime_assets?.windowsml_ocr,
      windowsml.artifact,
    ],
  ] as const) {
    if (
      actual?.file_name !== expected.file_name ||
      actual.sha256?.toLowerCase() !== expected.sha256.toLowerCase() ||
      actual.bytes !== expected.bytes
    ) {
      throw new Error(
        `Release metadata ${name} asset does not match its manifest.`,
      );
    }
  }
}

function validateLegalResources(
  releaseRoot: string,
  workspaceRoot: string,
): ReturnType<typeof publicFileRecord>[] {
  return [
    'LICENSE',
    'PRIVACY.md',
    'CHANGELOG.md',
    'THIRD_PARTY_NOTICES.md',
  ].map((name) => {
    const path = join(releaseRoot, 'legal', name);
    if (!existsSync(path)) {
      throw new Error(`Packaged legal resource is missing: legal/${name}`);
    }
    return publicFileRecord({
      absolutePath: path,
      path: path.slice(resolve(workspaceRoot).length + 1).replaceAll('\\', '/'),
      bytes: readFileSync(path).byteLength,
      mb: Number((readFileSync(path).byteLength / 1024 / 1024).toFixed(2)),
    });
  });
}

function rejectDevelopmentReferences(
  resourceRoot: string,
  files: readonly string[],
  workspaceRoot: string,
): void {
  const forbiddenText = [
    'file://',
    resolve(workspaceRoot).replaceAll('\\', '/').toLowerCase(),
    resolve(workspaceRoot).replaceAll('/', '\\').toLowerCase(),
    'c:/software-dev/',
    'c:\\software-dev\\',
  ];
  for (const path of files) {
    const content = readFileSync(path).toString('latin1').toLowerCase();
    const match = forbiddenText.find(
      (needle) => needle && content.includes(needle),
    );
    if (match) {
      throw new Error(
        `Packaged runtime resource contains a development path or file URL: ${basename(path)}`,
      );
    }
  }
  if (files.length === 0) {
    throw new Error(
      `No packaged runtime resources found under ${resourceRoot}`,
    );
  }
}
