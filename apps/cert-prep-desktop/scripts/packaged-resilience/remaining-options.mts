import {
  existsSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';

import {
  loadDocumentCancellationOptions,
  type DocumentCancellationRunnerOptions,
} from './args.mts';

const DEFAULT_OLLAMA_PORT = 11_434;

export interface RemainingResilienceOptions
  extends DocumentCancellationRunnerOptions {
  readonly ollamaExePath: string;
  readonly ollamaHost: string;
  readonly ollamaModelsRoot: string;
}

export type DocumentCancellationOptionsLoader = (
  environment?: Readonly<NodeJS.ProcessEnv>,
  workspaceRoot?: string,
) => Promise<DocumentCancellationRunnerOptions>;

/**
 * Extends the exact-candidate document options with an explicitly isolated
 * Ollama endpoint and model store. The model store is deliberately not created
 * here: the runner creates its diagnostics parent, then the isolation helper
 * atomically creates the fresh model directory immediately before startup.
 */
export async function loadRemainingResilienceOptions(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  workspaceRoot?: string,
  baseLoader: DocumentCancellationOptionsLoader =
    loadDocumentCancellationOptions,
): Promise<RemainingResilienceOptions> {
  const baseOptions = await baseLoader(environment, workspaceRoot);
  const ollamaExePath = requiredCanonicalOllamaExecutable(environment);
  const ollamaPort = requiredOllamaPort(environment);
  if (baseOptions.cdpPort > 65_533) {
    throw new Error(
      'The remaining resilience CDP port must leave room for two crash restarts.',
    );
  }
  const reservedCdpPorts = new Set([
    baseOptions.cdpPort,
    baseOptions.cdpPort + 1,
    baseOptions.cdpPort + 2,
  ]);
  if (reservedCdpPorts.has(ollamaPort)) {
    throw new Error(
      'CERT_PREP_RESILIENCE_OLLAMA_PORT must not equal any initial or restart CDP port.',
    );
  }

  const ollamaModelsRoot = `${baseOptions.diagnosticsRoot}/ollama-models`;
  if (existsSync(ollamaModelsRoot)) {
    throw new Error(
      'The derived Ollama models root must not exist before the resilience runner starts.',
    );
  }

  return {
    ...baseOptions,
    ollamaExePath,
    ollamaHost: `127.0.0.1:${ollamaPort}`,
    ollamaModelsRoot,
  };
}

function requiredCanonicalOllamaExecutable(
  environment: Readonly<NodeJS.ProcessEnv>,
): string {
  const name = 'CERT_PREP_RESILIENCE_OLLAMA_EXE_PATH';
  const value = requiredString(environment, name);
  if (!isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path to ollama.exe.`);
  }

  const requestedPath = resolve(value);
  if (basename(requestedPath).toLowerCase() !== 'ollama.exe') {
    throw new Error(`${name} must identify ollama.exe.`);
  }
  if (!existsSync(requestedPath)) {
    throw new Error(`${name} does not exist.`);
  }

  const stat = lstatSync(requestedPath);
  const canonicalPath = realpathSync.native(requestedPath);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    !samePath(canonicalPath, requestedPath)
  ) {
    throw new Error(
      `${name} must identify a canonical non-symlink, non-reparse ollama.exe file.`,
    );
  }
  return canonicalPath;
}

function requiredOllamaPort(
  environment: Readonly<NodeJS.ProcessEnv>,
): number {
  const name = 'CERT_PREP_RESILIENCE_OLLAMA_PORT';
  const value = requiredString(environment, name);
  if (!/^[1-9]\d{0,4}$/.test(value)) {
    throw new Error(`${name} must be an integer from 1 through 65535.`);
  }
  const port = Number(value);
  if (port > 65_535) {
    throw new Error(`${name} must be an integer from 1 through 65535.`);
  }
  if (port === DEFAULT_OLLAMA_PORT) {
    throw new Error(
      `${name} must not use Ollama's inherited/default port 11434.`,
    );
  }
  return port;
}

function requiredString(
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
