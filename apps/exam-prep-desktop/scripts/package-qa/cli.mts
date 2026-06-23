import { PACKAGE_QA_OCR_PAGE_WORKERS_ENV } from './constants.mts';
import type { ParsedArgs } from './types.mts';
import { positiveInteger } from './validation.mts';

/** Parses package QA CLI flags while preserving env-derived defaults. */
export function parsePackageQaArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ParsedArgs {
  const parsed: ParsedArgs = parsePackageQaEnv(env);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const readValue = (name: string): string => {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`${name} requires a value.`);
      }
      index += 1;
      return value;
    };

    if (arg === '--output') {
      parsed.output = readValue(arg);
    } else if (arg === '--bundle-root') {
      parsed.bundleRoot = readValue(arg);
    } else if (arg === '--backend-runtime-root') {
      parsed.backendRuntimeRoot = readValue(arg);
    } else if (arg === '--backend-runtime-manifest') {
      parsed.backendRuntimeManifest = readValue(arg);
    } else if (arg === '--backend-runtime-entrypoint') {
      parsed.backendRuntimeEntrypoint = readValue(arg);
    } else if (arg === '--ocr-runtime-root') {
      parsed.ocrRuntimeRoot = readValue(arg);
    } else if (arg === '--ocr-runtime-manifest') {
      parsed.ocrRuntimeManifest = readValue(arg);
    } else if (arg === '--windowsml-ocr-runtime-root') {
      parsed.windowsmlOcrRuntimeRoot = readValue(arg);
    } else if (arg === '--windowsml-ocr-runtime-manifest') {
      parsed.windowsmlOcrRuntimeManifest = readValue(arg);
    } else if (arg === '--target') {
      parsed.expectedTargetTriple = readValue(arg);
    } else if (arg === '--health-timeout-ms') {
      parsed.healthTimeoutMs = Number(readValue(arg));
    } else if (arg === '--ocr-page-workers') {
      parsed.ocrPageWorkers = positiveInteger(Number(readValue(arg)), arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

/** Parses QA-specific environment defaults for package QA. */
export function parsePackageQaEnv(
  env: NodeJS.ProcessEnv,
): Pick<ParsedArgs, 'ocrPageWorkers'> {
  const value = env[PACKAGE_QA_OCR_PAGE_WORKERS_ENV];
  if (value === undefined || value.trim() === '') {
    return {};
  }
  return {
    ocrPageWorkers: positiveInteger(
      Number(value),
      PACKAGE_QA_OCR_PAGE_WORKERS_ENV,
    ),
  };
}
