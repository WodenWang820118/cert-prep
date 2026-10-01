import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * The closed physical source set used by the consumer inventory. Multiple
 * logical owners may intentionally read the same physical source file.
 */
export const CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS = Object.freeze([
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'tools/capture-runtime-version.mts',
  'tools/capture-runtime-version.json',
  'tools/capture-version-source.mts',
  'apps/cert-prep-desktop/src-tauri/build.rs',
  'apps/cert-prep-backend/pyproject.toml',
  'apps/cert-prep-backend/uv.lock',
  'apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/runtime_policy.py',
  'apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/mapping.py',
  'apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/client.py',
  'apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/runtime_provenance.py',
  'apps/cert-prep-desktop/src-tauri/src/constants.rs',
  'apps/cert-prep-desktop/src-tauri/Cargo.toml',
  'apps/cert-prep-desktop/src-tauri/Cargo.lock',
  'apps/cert-prep-desktop/project.json',
  'apps/cert-prep-desktop/src-tauri/src/capture_manifest.rs',
  'apps/cert-prep-desktop/src-tauri/src/manifests.rs',
  'apps/cert-prep-desktop/src-tauri/src/backend_process.rs',
  'apps/cert-prep-desktop/src-tauri/src/capture_runtime.rs',
  'apps/cert-prep-desktop/scripts/package-qa/constants.mts',
  'tools/install-capture-runtime.mts',
  'tools/capture-runtime-consumer-smoke.mts',
  'apps/cert-prep/src/app/pages/capture-workbench-trial/cert-prep-capture-client.ts',
  'libs/cert-prep-api/src/lib/cert-prep-api.generated.ts',
] as const);

export type CaptureRuntimeConsumerSourcePath =
  (typeof CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS)[number];

export type CaptureRuntimeConsumerSourceFile = {
  readonly kind: 'file' | 'symlink' | 'missing' | 'other';
  readonly bytes?: Uint8Array;
};

export type CaptureRuntimeConsumerSource = {
  readonly readFile: (
    relativePath: CaptureRuntimeConsumerSourcePath,
  ) => CaptureRuntimeConsumerSourceFile;
};

export type CaptureRuntimeConsumerSnapshotFile = {
  readonly path: CaptureRuntimeConsumerSourcePath;
  readonly bytes: Uint8Array;
  readonly sha256: string;
};

export type CaptureRuntimeConsumerSnapshot = {
  /** Source-tree bytes only; this is not installed-package identity proof. */
  readonly version: '1';
  readonly sourceHead: string;
  readonly files: readonly CaptureRuntimeConsumerSnapshotFile[];
  readonly aggregateSha256: string;
};

function assertCanonicalPath(
  relativePath: string,
): asserts relativePath is CaptureRuntimeConsumerSourcePath {
  if (
    isAbsolute(relativePath) ||
    relativePath.includes('\\') ||
    relativePath.split('/').some((part) => part === '..' || part === '') ||
    !CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS.includes(
      relativePath as CaptureRuntimeConsumerSourcePath,
    )
  ) {
    throw new Error(
      `Capture Runtime consumer source path is outside the canonical registry: ${relativePath}`,
    );
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameFilesystemPath(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    resolve(value).replaceAll('\\', '/');
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function aggregateSha256(
  sourceHead: string,
  files: readonly CaptureRuntimeConsumerSnapshotFile[],
): string {
  const hash = createHash('sha256');
  hash.update('capture-runtime-consumer-snapshot-v1\0', 'utf8');
  hash.update(sourceHead, 'utf8');
  hash.update('\0', 'utf8');
  for (const file of files) {
    hash.update(file.path, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(String(file.bytes.byteLength), 'utf8');
    hash.update('\0', 'utf8');
    hash.update(file.bytes);
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex');
}

function requireRegularSourceFile(
  source: CaptureRuntimeConsumerSource,
  relativePath: CaptureRuntimeConsumerSourcePath,
): Uint8Array {
  const result = source.readFile(relativePath);
  if (result.kind !== 'file' || result.bytes === undefined) {
    throw new Error(
      `Capture Runtime consumer source ${relativePath} is ${result.kind}; expected a regular file.`,
    );
  }
  return Uint8Array.from(result.bytes);
}

export function createCaptureRuntimeConsumerDiskSource(
  workspaceRoot: string,
): CaptureRuntimeConsumerSource {
  const root = realpathSync(resolve(workspaceRoot));
  return {
    readFile(relativePath) {
      assertCanonicalPath(relativePath);
      const absolutePath = resolve(root, relativePath);
      const resolvedRelativePath: string = relative(
        root,
        absolutePath,
      ).replaceAll('\\', '/');
      if (
        resolvedRelativePath !== relativePath ||
        resolvedRelativePath.startsWith('../') ||
        isAbsolute(resolvedRelativePath) ||
        !absolutePath.startsWith(`${root}${sep}`)
      ) {
        throw new Error(
          `Capture Runtime consumer source path escaped the workspace: ${relativePath}`,
        );
      }
      try {
        const parts = relativePath.split('/');
        let currentPath = root;
        for (const [index, part] of parts.entries()) {
          currentPath = join(currentPath, part);
          const stats = lstatSync(currentPath);
          if (stats.isSymbolicLink()) return { kind: 'symlink' };
          if (index < parts.length - 1 && !stats.isDirectory()) {
            return { kind: 'other' };
          }
          if (!sameFilesystemPath(realpathSync(currentPath), currentPath)) {
            return { kind: 'symlink' };
          }
        }
        const actualPath = realpathSync(absolutePath);
        const actualRelativePath = relative(root, actualPath).replaceAll(
          '\\',
          '/',
        );
        if (
          actualRelativePath === '..' ||
          actualRelativePath.startsWith('../') ||
          isAbsolute(actualRelativePath)
        ) {
          return { kind: 'symlink' };
        }
        const stats = lstatSync(absolutePath);
        if (!stats.isFile()) return { kind: 'other' };
        return {
          kind: 'file',
          bytes: Uint8Array.from(readFileSync(absolutePath)),
        };
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          return { kind: 'missing' };
        }
        throw error;
      }
    },
  };
}

export function captureRuntimeConsumerSnapshot(
  source: CaptureRuntimeConsumerSource,
  sourceHead: string,
): CaptureRuntimeConsumerSnapshot {
  if (sourceHead.length === 0 || sourceHead.includes('\0')) {
    throw new Error(
      'Capture Runtime consumer snapshot sourceHead must be non-empty.',
    );
  }
  const files = CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS.map((path) => {
    const bytes = requireRegularSourceFile(source, path);
    return { path, bytes, sha256: sha256(bytes) };
  });
  return {
    version: '1',
    sourceHead,
    files,
    aggregateSha256: aggregateSha256(sourceHead, files),
  };
}

function validateSnapshot(
  snapshot: CaptureRuntimeConsumerSnapshot,
): readonly CaptureRuntimeConsumerSnapshotFile[] {
  if (snapshot.version !== '1') {
    throw new Error(
      `Unsupported Capture Runtime consumer snapshot version: ${snapshot.version}.`,
    );
  }
  if (snapshot.sourceHead.length === 0 || snapshot.sourceHead.includes('\0')) {
    throw new Error(
      'Capture Runtime consumer snapshot sourceHead must be non-empty.',
    );
  }
  if (snapshot.files.length !== CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS.length) {
    throw new Error(
      `Capture Runtime consumer snapshot must contain exactly ${CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS.length} files; found ${snapshot.files.length}.`,
    );
  }
  const files = snapshot.files.map((file, index) => {
    assertCanonicalPath(file.path);
    if (file.path !== CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS[index]) {
      throw new Error(
        `Capture Runtime consumer snapshot file order/path is not canonical at index ${index}: ${file.path}.`,
      );
    }
    if (!(file.bytes instanceof Uint8Array)) {
      throw new Error(
        `Capture Runtime consumer snapshot ${file.path} bytes are missing.`,
      );
    }
    const bytes = Uint8Array.from(file.bytes);
    const actualSha256 = sha256(bytes);
    if (file.sha256 !== actualSha256) {
      throw new Error(
        `Capture Runtime consumer snapshot ${file.path} bytes do not match its SHA-256.`,
      );
    }
    return { path: file.path, bytes, sha256: actualSha256 };
  });
  const actualAggregateSha256 = aggregateSha256(snapshot.sourceHead, files);
  if (snapshot.aggregateSha256 !== actualAggregateSha256) {
    throw new Error(
      'Capture Runtime consumer snapshot aggregate SHA-256 does not match its files.',
    );
  }
  return files;
}

export function createCaptureRuntimeConsumerSnapshotSource(
  snapshot: CaptureRuntimeConsumerSnapshot,
): CaptureRuntimeConsumerSource {
  const files = validateSnapshot(snapshot);
  const byPath = new Map(files.map((file) => [file.path, file]));
  return {
    readFile(relativePath) {
      assertCanonicalPath(relativePath);
      const file = byPath.get(relativePath);
      if (!file) return { kind: 'missing' };
      return { kind: 'file', bytes: Uint8Array.from(file.bytes) };
    },
  };
}

export function verifyCaptureRuntimeConsumerSnapshot(
  snapshot: CaptureRuntimeConsumerSnapshot,
  source: CaptureRuntimeConsumerSource,
  currentSourceHead: string,
): void {
  if (snapshot.sourceHead !== currentSourceHead) {
    throw new Error(
      `Capture Runtime consumer snapshot sourceHead is stale: expected ${currentSourceHead}, found ${snapshot.sourceHead}.`,
    );
  }
  const snapshotSource = createCaptureRuntimeConsumerSnapshotSource(snapshot);
  for (const path of CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS) {
    const expected = requireRegularSourceFile(snapshotSource, path);
    const actual = requireRegularSourceFile(source, path);
    if (
      sha256(actual) !== sha256(expected) ||
      actual.length !== expected.length
    ) {
      throw new Error(
        `Capture Runtime consumer source drifted at ${path}; snapshot bytes are no longer current.`,
      );
    }
  }
}

export function readCaptureRuntimeConsumerSnapshot(
  snapshot: CaptureRuntimeConsumerSnapshot,
): CaptureRuntimeConsumerSource {
  return createCaptureRuntimeConsumerSnapshotSource(snapshot);
}
