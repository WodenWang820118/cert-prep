import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import {
  BACKEND_RUNTIME_PREFIX,
  DEFAULT_BACKEND_RUNTIME_ENTRYPOINT,
  DEFAULT_BACKEND_RUNTIME_MANIFEST,
  DEFAULT_BACKEND_RUNTIME_ROOT,
  DEFAULT_BUNDLE_ROOT,
  DEFAULT_DATA_DIR,
  DEFAULT_LLM_MODEL,
  DEFAULT_WINDOWSML_OCR_RUNTIME_MANIFEST,
  DEFAULT_WINDOWSML_OCR_RUNTIME_ROOT,
  DEFAULT_TARGET_TRIPLE,
  WINDOWSML_OCR_RUNTIME_PREFIX,
  defaultWorkspaceRoot,
} from './constants.mts';
import {
  collectBackendRuntimeArtifacts,
  collectBundleArtifacts,
  collectOcrRuntimeArtifacts,
  normalizePath,
  publicFileRecord,
} from './files.mts';
import { collectRuntimeHealth } from './health.mts';
import { validateRuntimeManifest } from './manifest.mts';
import { initialInstallerSizeGate } from './size-gate.mts';
import type { PackageQaOptions, PackageQaReport } from './types.mts';

/** Creates the package QA JSON report without writing it to disk. */
export async function createPackageQaReport(
  options: PackageQaOptions = {},
): Promise<PackageQaReport> {
  const workspaceRoot = resolve(options.workspaceRoot ?? defaultWorkspaceRoot);
  const bundleRoot = resolve(
    workspaceRoot,
    options.bundleRoot ?? DEFAULT_BUNDLE_ROOT,
  );
  const backendRuntimeRoot = resolve(
    workspaceRoot,
    options.backendRuntimeRoot ?? DEFAULT_BACKEND_RUNTIME_ROOT,
  );
  const backendRuntimeManifest = resolve(
    workspaceRoot,
    options.backendRuntimeManifest ?? DEFAULT_BACKEND_RUNTIME_MANIFEST,
  );
  const backendRuntimeEntrypoint = resolve(
    workspaceRoot,
    options.backendRuntimeEntrypoint ?? DEFAULT_BACKEND_RUNTIME_ENTRYPOINT,
  );
  const windowsmlOcrRuntimeRoot = resolve(
    workspaceRoot,
    options.windowsmlOcrRuntimeRoot ?? DEFAULT_WINDOWSML_OCR_RUNTIME_ROOT,
  );
  const windowsmlOcrRuntimeManifest = resolve(
    workspaceRoot,
    options.windowsmlOcrRuntimeManifest ?? DEFAULT_WINDOWSML_OCR_RUNTIME_MANIFEST,
  );
  const expectedTargetTriple =
    options.expectedTargetTriple ?? DEFAULT_TARGET_TRIPLE;

  const bundleArtifacts = collectBundleArtifacts(bundleRoot, workspaceRoot);
  if (bundleArtifacts.length === 0) {
    throw new Error(`No bundle artifacts found under ${bundleRoot}`);
  }

  const backendRuntimeArtifacts = collectBackendRuntimeArtifacts(
    backendRuntimeRoot,
    workspaceRoot,
  );
  const backendRuntimeManifestSummary = validateRuntimeManifest({
    manifestPath: backendRuntimeManifest,
    runtimeRoot: backendRuntimeRoot,
    workspaceRoot,
    expectedKind: 'python_backend',
    artifactPrefix: BACKEND_RUNTIME_PREFIX,
  });
  const windowsmlOcrRuntimeArtifacts = collectOcrRuntimeArtifacts(
    windowsmlOcrRuntimeRoot,
    workspaceRoot,
  );
  const windowsmlOcrRuntimeManifestSummary = validateRuntimeManifest({
    manifestPath: windowsmlOcrRuntimeManifest,
    runtimeRoot: windowsmlOcrRuntimeRoot,
    workspaceRoot,
    expectedKind: 'windowsml_ocr',
    artifactPrefix: WINDOWSML_OCR_RUNTIME_PREFIX,
  });
  const targetTriple = backendRuntimeManifestSummary.target;
  if (targetTriple !== expectedTargetTriple) {
    throw new Error(
      `Expected ${expectedTargetTriple} backend runtime, found ${targetTriple}`,
    );
  }
  if (windowsmlOcrRuntimeManifestSummary.target !== expectedTargetTriple) {
    throw new Error(
      `Expected ${expectedTargetTriple} WindowsML OCR runtime, found ${windowsmlOcrRuntimeManifestSummary.target}`,
    );
  }
  if (!existsSync(backendRuntimeEntrypoint)) {
    throw new Error(
      `Backend runtime entrypoint was not built: ${backendRuntimeEntrypoint}`,
    );
  }

  const runtime = await collectRuntimeHealth({
    backendRuntimeEntrypoint,
    workspaceRoot,
    timeoutMs: options.healthTimeoutMs,
    dataDir: resolve(workspaceRoot, options.dataDir ?? DEFAULT_DATA_DIR),
    llmModel: options.llmModel ?? DEFAULT_LLM_MODEL,
    windowsmlOcrRuntimeManifest,
    ocrProvider: options.ocrProvider,
    ocrPageWorkers: options.ocrPageWorkers,
  });
  const sizeGate = initialInstallerSizeGate(bundleArtifacts);
  if (sizeGate.status === 'failed') {
    throw new Error(sizeGate.detail);
  }

  return {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    target: {
      rust_triple: targetTriple,
      platform: process.platform,
      arch: process.arch,
    },
    package: {
      bundle_root: normalizePath(relative(workspaceRoot, bundleRoot)),
      bundle_artifacts: bundleArtifacts.map(publicFileRecord),
      backend_runtime_root: normalizePath(
        relative(workspaceRoot, backendRuntimeRoot),
      ),
      backend_runtime_manifest: backendRuntimeManifestSummary,
      backend_runtime_artifacts: backendRuntimeArtifacts.map(publicFileRecord),
      windowsml_ocr_runtime_root: normalizePath(
        relative(workspaceRoot, windowsmlOcrRuntimeRoot),
      ),
      windowsml_ocr_runtime_manifest: windowsmlOcrRuntimeManifestSummary,
      windowsml_ocr_runtime_artifacts:
        windowsmlOcrRuntimeArtifacts.map(publicFileRecord),
      size_gate: sizeGate,
    },
    runtime,
  };
}

/** Writes a package QA report with the stable pretty-printed JSON format. */
export function writeReport(report: unknown, outputPath: string): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}
