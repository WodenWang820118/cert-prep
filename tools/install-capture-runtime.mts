import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validateCaptureArtifactBytes } from '../apps/cert-prep-desktop/scripts/capture-runtime-contract.mts';
import {
  CAPTURE_RUNTIME_RELEASE_BASE_URL,
  CAPTURE_RUNTIME_VERSION,
} from './capture-runtime-version.mts';
import {
  CAPTURE_DOCUMENT_SCHEMA_FILE,
  CAPTURE_DOCUMENT_SCHEMA_SHA256,
  CAPTURE_DOCUMENT_SCHEMA_VERSION,
  CAPTURE_RUNTIME_API_VERSION,
  CAPTURE_RUNTIME_FILE,
  CAPTURE_RUNTIME_MANIFEST_VERSION,
} from '../apps/cert-prep-desktop/scripts/package-qa/constants.mts';

export { CAPTURE_RUNTIME_FILE, CAPTURE_RUNTIME_VERSION };

export const CAPTURE_RUNTIME_RELEASE_BASE_URL_ENV =
  'CERT_PREP_CAPTURE_RUNTIME_RELEASE_BASE_URL';
export const CAPTURE_RUNTIME_RELEASE_DIRECTORY_ENV =
  'CERT_PREP_CAPTURE_RUNTIME_RELEASE_DIRECTORY';
export const DEFAULT_CAPTURE_RUNTIME_RELEASE_BASE_URL =
  CAPTURE_RUNTIME_RELEASE_BASE_URL;
export const CAPTURE_RUNTIME_ROOT_ENV = 'CERT_PREP_CAPTURE_RUNTIME_ROOT';
export const CAPTURE_RUNTIME_CHECKSUM_FILE = `${CAPTURE_RUNTIME_FILE}.sha256`;
export const CAPTURE_RUNTIME_RELEASE_ASSETS = Object.freeze([
  CAPTURE_RUNTIME_FILE,
  CAPTURE_RUNTIME_CHECKSUM_FILE,
  'capture-runtime-manifest.json',
  CAPTURE_DOCUMENT_SCHEMA_FILE,
]);

const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/u;
const GITHUB_RELEASE_ASSET_HOSTS = new Set([
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);

export interface CaptureRuntimeReleaseManifest {
  readonly manifestVersion: string;
  readonly runtimeVersion: string;
  readonly apiVersion: string;
  readonly captureDocumentSchemaVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly schemaFileName: string;
  readonly schemaSha256: string;
}

export interface InstallCaptureRuntimeOptions {
  readonly workspaceRoot: string;
  readonly baseUrl?: string;
  readonly releaseDirectory?: string;
  readonly outputRoot?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly retryDelays?: readonly number[];
  readonly githubToken?: string;
}

export interface DownloadAssetOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly retryDelays?: readonly number[];
  readonly githubToken?: string;
}

export function defaultCaptureRuntimeRoot(workspaceRoot: string): string {
  return join(
    workspaceRoot,
    'tmp',
    'cert-prep',
    'capture-runtime',
    CAPTURE_RUNTIME_VERSION,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertLowercaseSha256(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || !LOWERCASE_SHA256.test(value)) {
    throw new Error(`${label} must be 64 lowercase SHA-256 characters.`);
  }
}

function assertRequiredString(
  manifest: Record<string, unknown>,
  field: string,
  expected: string,
): void {
  if (manifest[field] !== expected) {
    throw new Error(
      `Capture runtime ${field} must be ${expected}, found ${String(manifest[field])}.`,
    );
  }
}

export function validateCaptureRuntimeReleaseManifest(
  raw: unknown,
  expectedVersion = CAPTURE_RUNTIME_VERSION,
): CaptureRuntimeReleaseManifest {
  if (!isRecord(raw)) {
    throw new Error('Capture runtime release manifest must be an object.');
  }
  assertRequiredString(
    raw,
    'manifestVersion',
    CAPTURE_RUNTIME_MANIFEST_VERSION,
  );
  assertRequiredString(raw, 'runtimeVersion', expectedVersion);
  assertRequiredString(raw, 'apiVersion', CAPTURE_RUNTIME_API_VERSION);
  assertRequiredString(
    raw,
    'captureDocumentSchemaVersion',
    CAPTURE_DOCUMENT_SCHEMA_VERSION,
  );
  assertRequiredString(raw, 'platform', 'windows');
  assertRequiredString(raw, 'arch', 'x86_64');
  assertRequiredString(raw, 'fileName', CAPTURE_RUNTIME_FILE);
  assertRequiredString(raw, 'schemaFileName', CAPTURE_DOCUMENT_SCHEMA_FILE);

  if (
    typeof raw.fileName !== 'string' ||
    raw.fileName.includes('/') ||
    raw.fileName.includes('\\')
  ) {
    throw new Error('Capture runtime fileName must be a plain file name.');
  }
  if (
    typeof raw.schemaFileName !== 'string' ||
    raw.schemaFileName.includes('/') ||
    raw.schemaFileName.includes('\\')
  ) {
    throw new Error(
      'Capture runtime schemaFileName must be a plain file name.',
    );
  }
  validateCaptureArtifactBytes(raw.bytes, 'Capture runtime executable');
  assertLowercaseSha256(raw.sha256, 'Capture runtime sha256');
  assertRequiredString(raw, 'schemaSha256', CAPTURE_DOCUMENT_SCHEMA_SHA256);
  assertLowercaseSha256(raw.schemaSha256, 'Capture runtime schemaSha256');

  return {
    manifestVersion: raw.manifestVersion as string,
    runtimeVersion: raw.runtimeVersion as string,
    apiVersion: raw.apiVersion as string,
    captureDocumentSchemaVersion: raw.captureDocumentSchemaVersion as string,
    platform: raw.platform as string,
    arch: raw.arch as string,
    fileName: raw.fileName as string,
    bytes: raw.bytes as number,
    sha256: raw.sha256 as string,
    schemaFileName: raw.schemaFileName as string,
    schemaSha256: raw.schemaSha256 as string,
  };
}

export function validateCaptureRuntimeReleaseBaseUrl(
  raw: string,
  expectedVersion = CAPTURE_RUNTIME_VERSION,
): string {
  const value = raw.trim();
  if (value !== raw || !value) {
    throw new Error(
      `${CAPTURE_RUNTIME_RELEASE_BASE_URL_ENV} must be a versioned URL.`,
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `${CAPTURE_RUNTIME_RELEASE_BASE_URL_ENV} must be a valid versioned URL.`,
    );
  }
  const expectedPath = `v${expectedVersion}`;
  const segments = url.pathname.split('/').filter(Boolean);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    value.includes('%') ||
    value.includes('\\') ||
    segments.at(-1) !== expectedPath
  ) {
    throw new Error(
      `${CAPTURE_RUNTIME_RELEASE_BASE_URL_ENV} must end in /${expectedPath} and contain no credentials, query, fragment, encoding, or path separators.`,
    );
  }
  if (url.protocol === 'http:' && url.hostname !== '127.0.0.1') {
    throw new Error(
      `${CAPTURE_RUNTIME_RELEASE_BASE_URL_ENV} may use HTTP only on 127.0.0.1.`,
    );
  }
  return value.replace(/\/+$/u, '');
}

function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  return new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

async function verifyRegularFile(path: string, label: string): Promise<number> {
  const details = await stat(path);
  if (!details.isFile()) throw new Error(`${label} must be a regular file.`);
  return details.size;
}

export async function verifyCaptureRuntimeReleaseDirectory(
  directory: string,
  expectedVersion = CAPTURE_RUNTIME_VERSION,
): Promise<CaptureRuntimeReleaseManifest> {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  const expectedNames = [...CAPTURE_RUNTIME_RELEASE_ASSETS].sort();
  if (
    names.length !== expectedNames.length ||
    names.some((name, index) => name !== expectedNames[index]) ||
    entries.some((entry) => !entry.isFile())
  ) {
    throw new Error(
      'Capture runtime release contains non-canonical artifacts.',
    );
  }

  const manifest = validateCaptureRuntimeReleaseManifest(
    JSON.parse(
      await readFile(join(directory, 'capture-runtime-manifest.json'), 'utf8'),
    ),
    expectedVersion,
  );
  const executablePath = join(directory, manifest.fileName);
  const executableBytes = await verifyRegularFile(
    executablePath,
    'Capture runtime executable',
  );
  if (executableBytes !== manifest.bytes) {
    throw new Error(
      `Capture runtime executable bytes mismatch: expected ${manifest.bytes}, found ${executableBytes}.`,
    );
  }
  if ((await sha256File(executablePath)) !== manifest.sha256) {
    throw new Error('Capture runtime executable checksum mismatch.');
  }

  const schemaPath = join(directory, manifest.schemaFileName);
  await verifyRegularFile(schemaPath, 'Capture document schema');
  if ((await sha256File(schemaPath)) !== CAPTURE_DOCUMENT_SCHEMA_SHA256) {
    throw new Error('Capture document schema checksum mismatch.');
  }
  const checksum = (
    await readFile(join(directory, CAPTURE_RUNTIME_CHECKSUM_FILE), 'utf8')
  ).trim();
  const checksumMatch = checksum.match(/^([0-9a-f]{64})\s+(.+)$/u);
  if (
    !checksumMatch ||
    checksumMatch[1] !== manifest.sha256 ||
    checksumMatch[2] !== manifest.fileName
  ) {
    throw new Error(
      'Capture runtime checksum file does not match the manifest.',
    );
  }
  return manifest;
}

class TerminalError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'TerminalError';
    this.status = status;
  }
}

class RetryableHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'RetryableHttpError';
    this.status = status;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function withRetry<T>(
  operation: () => Promise<T>,
  delays: readonly number[],
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  const maxAttempts = delays.length + 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) {
      await sleep(delays[attempt - 1]);
    }
    try {
      return await operation();
    } catch (error) {
      if (error instanceof TerminalError) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError;
}

function validateRedirectUrl(
  sourceUrl: string,
  location: string | null,
  allowedSourceHost: string,
  name: string,
): URL {
  let redirectedUrl: URL;
  try {
    redirectedUrl = new URL(location ?? '', sourceUrl);
  } catch {
    throw new TerminalError(
      `Capture runtime artifact ${name} returned an invalid redirect.`,
    );
  }
  const source = new URL(sourceUrl);
  if (
    source.protocol !== 'https:' ||
    source.hostname !== allowedSourceHost ||
    redirectedUrl.protocol !== 'https:' ||
    redirectedUrl.username ||
    redirectedUrl.password ||
    redirectedUrl.port ||
    !GITHUB_RELEASE_ASSET_HOSTS.has(redirectedUrl.hostname)
  ) {
    throw new TerminalError(
      `Capture runtime artifact ${name} returned an untrusted redirect.`,
    );
  }
  return redirectedUrl;
}

function parseGitHubReleaseCoordinates(baseUrl: string): {
  readonly owner: string;
  readonly repo: string;
  readonly tag: string;
} {
  for (const candidate of [baseUrl, DEFAULT_CAPTURE_RUNTIME_RELEASE_BASE_URL]) {
    try {
      const parsed = new URL(candidate);
      if (parsed.hostname === 'github.com') {
        const segments = parsed.pathname.split('/').filter(Boolean);
        if (
          segments.length >= 5 &&
          segments[2] === 'releases' &&
          segments[3] === 'download'
        ) {
          return {
            owner: segments[0],
            repo: segments[1],
            tag: segments[4],
          };
        }
      }
    } catch {
      // Continue to next candidate
    }
  }
  throw new Error(
    `Cannot derive GitHub release coordinates from base URL: ${baseUrl}`,
  );
}

async function downloadFromPublicUrl(
  baseUrl: string,
  name: string,
  destination: string,
  options: DownloadAssetOptions,
): Promise<void> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const sourceUrl = `${baseUrl}/${name}`;
  let response = await fetchFn(sourceUrl, {
    redirect: 'manual',
    headers: { Connection: 'close' },
  });
  if (response.status >= 500 && response.status < 600) {
    throw new RetryableHttpError(
      `Capture runtime artifact ${name} download failed with HTTP ${response.status}.`,
      response.status,
    );
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    const redirectedUrl = validateRedirectUrl(
      sourceUrl,
      location,
      'github.com',
      name,
    );
    response = await fetchFn(redirectedUrl, {
      redirect: 'error',
      headers: { Connection: 'close' },
    });
    if (response.status >= 500 && response.status < 600) {
      throw new RetryableHttpError(
        `Capture runtime artifact ${name} download failed with HTTP ${response.status}.`,
        response.status,
      );
    }
  }
  if (!response.ok || !response.body) {
    throw new TerminalError(
      `Capture runtime artifact ${name} download failed with HTTP ${response.status}.`,
      response.status,
    );
  }
  await writeFile(destination, new Uint8Array(await response.arrayBuffer()), {
    flag: 'wx',
  });
}

async function downloadFromApi(
  baseUrl: string,
  name: string,
  destination: string,
  options: DownloadAssetOptions,
): Promise<void> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const coordinates = parseGitHubReleaseCoordinates(baseUrl);
  const tag = coordinates.tag.startsWith('v')
    ? coordinates.tag
    : `v${coordinates.tag}`;
  const releaseApiUrl = `https://api.github.com/repos/${coordinates.owner}/${coordinates.repo}/releases/tags/${tag}`;

  const token = options.githubToken ?? process.env.GITHUB_TOKEN?.trim();
  const apiHeaders: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'cert-prep-install-capture-runtime',
  };
  if (token) {
    apiHeaders.Authorization = `Bearer ${token}`;
  }

  const releaseResponse = await fetchFn(releaseApiUrl, {
    headers: apiHeaders,
  });

  if (releaseResponse.status >= 500 && releaseResponse.status < 600) {
    throw new RetryableHttpError(
      `Capture runtime artifact ${name} download failed with HTTP ${releaseResponse.status}.`,
      releaseResponse.status,
    );
  }
  if (!releaseResponse.ok) {
    throw new TerminalError(
      `Capture runtime artifact ${name} download failed with HTTP ${releaseResponse.status}.`,
      releaseResponse.status,
    );
  }

  const releaseData = (await releaseResponse.json()) as {
    readonly assets?: ReadonlyArray<{
      readonly name?: string;
      readonly url?: string;
    }>;
  };
  const matchingAsset = releaseData.assets?.find(
    (asset) => asset.name === name,
  );
  if (!matchingAsset?.url) {
    throw new TerminalError(
      `Capture runtime artifact ${name} not found in GitHub release ${tag}.`,
      404,
    );
  }

  const assetHeaders: Record<string, string> = {
    Accept: 'application/octet-stream',
    'User-Agent': 'cert-prep-install-capture-runtime',
  };
  if (token) {
    assetHeaders.Authorization = `Bearer ${token}`;
  }

  let assetResponse = await fetchFn(matchingAsset.url, {
    redirect: 'manual',
    headers: assetHeaders,
  });

  if (assetResponse.status >= 500 && assetResponse.status < 600) {
    throw new RetryableHttpError(
      `Capture runtime artifact ${name} download failed with HTTP ${assetResponse.status}.`,
      assetResponse.status,
    );
  }

  if (assetResponse.status >= 300 && assetResponse.status < 400) {
    const location = assetResponse.headers.get('location');
    const redirectedUrl = validateRedirectUrl(
      matchingAsset.url,
      location,
      'api.github.com',
      name,
    );
    assetResponse = await fetchFn(redirectedUrl, {
      redirect: 'error',
      headers: { Connection: 'close' },
    });
  }
  // The asset endpoint may also answer 200 with the bytes itself; those are
  // written below and verified against the manifest like any other download.

  if (assetResponse.status >= 500 && assetResponse.status < 600) {
    throw new RetryableHttpError(
      `Capture runtime artifact ${name} download failed with HTTP ${assetResponse.status}.`,
      assetResponse.status,
    );
  }
  if (!assetResponse.ok || !assetResponse.body) {
    throw new TerminalError(
      `Capture runtime artifact ${name} download failed with HTTP ${assetResponse.status}.`,
      assetResponse.status,
    );
  }

  await writeFile(
    destination,
    new Uint8Array(await assetResponse.arrayBuffer()),
    { flag: 'wx' },
  );
}

export async function downloadAsset(
  baseUrl: string,
  name: string,
  destination: string,
  options: DownloadAssetOptions = {},
): Promise<void> {
  const delays = options.retryDelays ?? [1000, 2000];
  const sleepFn = options.sleep ?? defaultSleep;

  let publicError: unknown;
  try {
    await withRetry(
      () => downloadFromPublicUrl(baseUrl, name, destination, options),
      delays,
      sleepFn,
    );
    return;
  } catch (error) {
    if (error instanceof TerminalError) {
      throw error;
    }
    publicError = error;
  }

  try {
    await withRetry(
      () => downloadFromApi(baseUrl, name, destination, options),
      delays,
      sleepFn,
    );
  } catch (apiError) {
    if (
      apiError instanceof TerminalError &&
      apiError.message.includes('redirect')
    ) {
      throw apiError;
    }

    const status =
      (apiError as { status?: number }).status ??
      (publicError as { status?: number }).status;

    if (status) {
      throw new Error(
        `Capture runtime artifact ${name} download failed with HTTP ${status} (public URL and API).`,
      );
    }

    const message =
      apiError instanceof Error ? apiError.message : String(apiError);
    throw new Error(
      `Capture runtime artifact ${name} download failed: ${message} (public URL and API).`,
    );
  }
}

async function copyReleaseAsset(
  sourceDirectory: string,
  name: string,
  destination: string,
): Promise<void> {
  await copyFile(join(sourceDirectory, name), destination);
}

export async function installCaptureRuntime(
  options: InstallCaptureRuntimeOptions,
): Promise<{
  readonly outputRoot: string;
  readonly manifest: CaptureRuntimeReleaseManifest;
}> {
  const {
    workspaceRoot,
    baseUrl = process.env[CAPTURE_RUNTIME_RELEASE_BASE_URL_ENV] ??
      DEFAULT_CAPTURE_RUNTIME_RELEASE_BASE_URL,
    releaseDirectory = process.env[CAPTURE_RUNTIME_RELEASE_DIRECTORY_ENV],
    outputRoot = process.env[CAPTURE_RUNTIME_ROOT_ENV] ||
      defaultCaptureRuntimeRoot(workspaceRoot),
    fetch: customFetch,
    sleep,
    retryDelays,
    githubToken,
  } = options;
  if (!baseUrl && !releaseDirectory) {
    throw new Error(
      `${CAPTURE_RUNTIME_RELEASE_BASE_URL_ENV} or ${CAPTURE_RUNTIME_RELEASE_DIRECTORY_ENV} is required; install the versioned release before preparing Tauri resources.`,
    );
  }
  const validatedBaseUrl = releaseDirectory
    ? undefined
    : validateCaptureRuntimeReleaseBaseUrl(baseUrl as string);
  const resolvedReleaseDirectory = releaseDirectory
    ? resolve(workspaceRoot, releaseDirectory)
    : undefined;
  const resolvedOutputRoot = resolve(workspaceRoot, outputRoot);
  const parent = dirname(resolvedOutputRoot);
  await mkdir(parent, { recursive: true });

  try {
    const existing =
      await verifyCaptureRuntimeReleaseDirectory(resolvedOutputRoot);
    return { outputRoot: resolvedOutputRoot, manifest: existing };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(
        `Existing Capture Runtime staging is not the pinned ${CAPTURE_RUNTIME_VERSION} release; refusing to overwrite ${resolvedOutputRoot}.`,
        { cause: error },
      );
    }
  }

  const temporaryRoot = await mkdtemp(
    join(parent, `.capture-runtime-${CAPTURE_RUNTIME_VERSION}-`),
  );
  try {
    for (const name of CAPTURE_RUNTIME_RELEASE_ASSETS) {
      if (resolvedReleaseDirectory) {
        await copyReleaseAsset(
          resolvedReleaseDirectory,
          name,
          join(temporaryRoot, name),
        );
      } else {
        await downloadAsset(
          validatedBaseUrl as string,
          name,
          join(temporaryRoot, name),
          {
            fetch: customFetch,
            sleep,
            retryDelays,
            githubToken,
          },
        );
      }
    }
    const manifest = await verifyCaptureRuntimeReleaseDirectory(temporaryRoot);
    try {
      await rename(temporaryRoot, resolvedOutputRoot);
    } catch (error) {
      try {
        const raced =
          await verifyCaptureRuntimeReleaseDirectory(resolvedOutputRoot);
        return { outputRoot: resolvedOutputRoot, manifest: raced };
      } catch {
        throw new Error(
          `Capture Runtime staging could not be installed atomically at ${resolvedOutputRoot}.`,
          { cause: error },
        );
      }
    }
    return { outputRoot: resolvedOutputRoot, manifest };
  } finally {
    await rm(temporaryRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}

interface ParsedArgs {
  readonly baseUrl?: string;
  readonly releaseDirectory?: string;
  readonly outputRoot?: string;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  let baseUrl: string | undefined;
  let releaseDirectory: string | undefined;
  let outputRoot: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const next = (): string => {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a value.`);
      index += 1;
      return value;
    };
    if (argument === '--base-url') baseUrl = next();
    else if (argument === '--release-directory') releaseDirectory = next();
    else if (argument === '--output-root') outputRoot = next();
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return { baseUrl, releaseDirectory, outputRoot };
}

async function main(): Promise<void> {
  const scriptPath = fileURLToPath(import.meta.url);
  const workspaceRoot = resolve(dirname(scriptPath), '..');
  const args = parseArgs(process.argv.slice(2));
  const result = await installCaptureRuntime({
    workspaceRoot,
    baseUrl: args.baseUrl,
    releaseDirectory: args.releaseDirectory,
    outputRoot: args.outputRoot,
  });
  console.log(
    `Installed capture-runtime@${result.manifest.runtimeVersion} under ${result.outputRoot}`,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
