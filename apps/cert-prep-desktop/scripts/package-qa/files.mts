import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { defaultWorkspaceRoot } from './constants.mts';
import type { FileRecord, PublicFileRecord } from './types.mts';

/** Collects sorted Tauri bundle artifacts beneath the bundle root. */
export function collectBundleArtifacts(
  bundleRoot: string,
  workspaceRoot = defaultWorkspaceRoot,
): FileRecord[] {
  if (!existsSync(bundleRoot)) {
    return [];
  }
  return collectFiles(bundleRoot, workspaceRoot);
}

/** Collects sorted files beneath the packaged resource root. */
export function collectPackagedResourceArtifacts(
  resourceRoot: string,
  workspaceRoot = defaultWorkspaceRoot,
): FileRecord[] {
  if (!existsSync(resourceRoot)) {
    return [];
  }
  return collectFiles(resourceRoot, workspaceRoot);
}

/** Converts bytes to a two-decimal MiB value for report fields. */
export function bytesToMb(bytes: number): number {
  return Number((bytes / 1024 / 1024).toFixed(2));
}

/** Builds a workspace-relative file record with byte and MiB sizes. */
function fileRecord(
  filePath: string,
  workspaceRoot: string,
): FileRecord {
  const bytes = statSync(filePath).size;
  return {
    absolutePath: filePath,
    path: normalizePath(relative(workspaceRoot, filePath)),
    bytes,
    mb: bytesToMb(bytes),
  };
}

/** Drops absolute paths before records enter the public JSON report. */
export function publicFileRecord(record: FileRecord): PublicFileRecord {
  return {
    path: record.path,
    bytes: record.bytes,
    mb: record.mb,
  };
}

/** Hashes an artifact for manifest validation. */
export function sha256File(filePath: string): string {
  const hash = createHash('sha256');
  const content = readFileSync(filePath);
  hash.update(content);
  return hash.digest('hex');
}

/** Normalizes workspace-relative paths to slash separators in reports. */
export function normalizePath(path: string): string {
  return path.split(sep).join('/');
}

function collectFiles(root: string, workspaceRoot: string): FileRecord[] {
  const files: FileRecord[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(path, workspaceRoot));
    } else if (entry.isFile()) {
      files.push(fileRecord(path, workspaceRoot));
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
