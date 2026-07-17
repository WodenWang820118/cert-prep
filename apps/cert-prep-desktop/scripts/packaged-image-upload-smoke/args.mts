import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PackagedImageUploadSmokeOptions {
  readonly workspaceRoot: string;
  readonly exePath: string;
  readonly outDir: string;
  readonly appDataDir: string;
  readonly cdpPort: number;
  readonly timeoutMs: number;
  readonly ocrProvider: string;
}

const DEFAULT_TARGET_TRIPLE = 'x86_64-pc-windows-msvc';
const DEFAULT_OUT_ROOT =
  'tmp/cert-prep-desktop/packaged-image-upload-smoke';
const DEFAULT_CDP_PORT = 9492;
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_OCR_PROVIDER = 'windowsml';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = resolve(scriptDir, '../../../..');

export function parsePackagedImageUploadSmokeArgs(
  args: readonly string[],
  workspaceRoot = defaultWorkspaceRoot,
  now: () => Date = () => new Date(),
): PackagedImageUploadSmokeOptions {
  const timestamp = now().toISOString().replace(/[:.]/g, '-');
  let outDir = resolve(workspaceRoot, DEFAULT_OUT_ROOT, timestamp);
  let exePath = resolve(
    workspaceRoot,
    'apps/cert-prep-desktop/src-tauri/target',
    DEFAULT_TARGET_TRIPLE,
    'release/cert-prep-desktop.exe',
  );
  let cdpPort = DEFAULT_CDP_PORT;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let ocrProvider = DEFAULT_OCR_PROVIDER;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const readValue = (): string => {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`${argument} requires a value.`);
      }
      index += 1;
      return value;
    };

    if (argument === '--exe') {
      exePath = resolve(workspaceRoot, readValue());
    } else if (argument === '--out-dir') {
      outDir = resolve(workspaceRoot, readValue());
    } else if (argument === '--out-root') {
      outDir = resolve(workspaceRoot, readValue(), timestamp);
    } else if (argument === '--cdp-port') {
      cdpPort = positiveInteger(readValue(), argument);
    } else if (argument === '--timeout-ms') {
      timeoutMs = positiveInteger(readValue(), argument);
    } else if (argument === '--ocr-provider') {
      ocrProvider = nonEmptyString(readValue(), argument);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return {
    workspaceRoot,
    exePath,
    outDir,
    appDataDir: join(outDir, 'app-data'),
    cdpPort,
    timeoutMs,
    ocrProvider,
  };
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function nonEmptyString(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${name} must not be empty.`);
  }
  return trimmed;
}
