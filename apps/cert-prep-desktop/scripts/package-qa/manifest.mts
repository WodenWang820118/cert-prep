import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { defaultWorkspaceRoot } from './constants.mts';
import { fileRecord, publicFileRecord, sha256File } from './files.mts';
import type {
  RuntimeManifest,
  RuntimeManifestSummary,
  RuntimeManifestValidationOptions,
} from './types.mts';

/** Extracts the target triple encoded in a runtime artifact file name. */
export function targetTripleFromRuntimeArtifactName(
  fileName: string,
  prefix: string,
): string {
  if (!fileName.startsWith(prefix) || !fileName.endsWith('.zip')) {
    throw new Error(`Not a cert-prep runtime artifact name: ${fileName}`);
  }
  return fileName.slice(prefix.length, -'.zip'.length);
}

/** Validates a runtime manifest against its artifact size, checksum, and target. */
export function validateRuntimeManifest({
  manifestPath,
  runtimeRoot,
  workspaceRoot = defaultWorkspaceRoot,
  expectedKind,
  artifactPrefix,
}: RuntimeManifestValidationOptions): RuntimeManifestSummary {
  if (!existsSync(manifestPath)) {
    throw new Error(`Runtime manifest was not found: ${manifestPath}`);
  }
  const manifest = JSON.parse(
    readFileSync(manifestPath, 'utf8'),
  ) as RuntimeManifest;
  if (manifest.kind !== expectedKind) {
    throw new Error(
      `Expected ${expectedKind} manifest, found ${manifest.kind}`,
    );
  }
  const targetFromName = targetTripleFromRuntimeArtifactName(
    manifest.artifact.file_name,
    artifactPrefix,
  );
  if (targetFromName !== manifest.target) {
    throw new Error(
      `${manifest.kind} artifact target ${targetFromName} does not match manifest target ${manifest.target}`,
    );
  }
  const artifactPath = join(runtimeRoot, manifest.artifact.file_name);
  if (!existsSync(artifactPath)) {
    throw new Error(`Runtime artifact was not found: ${artifactPath}`);
  }
  const artifact = fileRecord(artifactPath, workspaceRoot);
  if (artifact.bytes !== manifest.artifact.bytes) {
    throw new Error(
      `${manifest.kind} artifact size mismatch: expected ${manifest.artifact.bytes}, found ${artifact.bytes}`,
    );
  }
  const actualHash = sha256File(artifactPath);
  if (actualHash.toLowerCase() !== manifest.artifact.sha256.toLowerCase()) {
    throw new Error(`${manifest.kind} artifact checksum mismatch.`);
  }

  return {
    kind: manifest.kind,
    version: manifest.version,
    target: manifest.target,
    entrypoint: manifest.entrypoint,
    url: manifest.artifact.url ?? null,
    manifest: publicFileRecord(fileRecord(manifestPath, workspaceRoot)),
    artifact: publicFileRecord(artifact),
  };
}
