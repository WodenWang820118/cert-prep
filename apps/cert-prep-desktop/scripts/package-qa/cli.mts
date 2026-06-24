import {
  PACKAGE_QA_LLM_PROVIDER_ENV,
  PACKAGE_QA_OCR_PAGE_WORKERS_ENV,
} from './constants.mts';
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
    } else if (arg === '--windowsml-ocr-runtime-root') {
      parsed.windowsmlOcrRuntimeRoot = readValue(arg);
    } else if (arg === '--windowsml-ocr-runtime-manifest') {
      parsed.windowsmlOcrRuntimeManifest = readValue(arg);
    } else if (arg === '--target') {
      parsed.expectedTargetTriple = readValue(arg);
    } else if (arg === '--health-timeout-ms') {
      parsed.healthTimeoutMs = Number(readValue(arg));
    } else if (arg === '--llm-provider') {
      parsed.llmProvider = nonEmptyString(readValue(arg), arg).toLowerCase();
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
): Pick<ParsedArgs, 'llmProvider' | 'ocrPageWorkers'> {
  const parsed: Pick<ParsedArgs, 'llmProvider' | 'ocrPageWorkers'> = {};
  const llmProvider = env[PACKAGE_QA_LLM_PROVIDER_ENV];
  if (llmProvider !== undefined && llmProvider.trim() !== '') {
    parsed.llmProvider = llmProvider.trim().toLowerCase();
  }
  const pageWorkers = env[PACKAGE_QA_OCR_PAGE_WORKERS_ENV];
  if (pageWorkers !== undefined && pageWorkers.trim() !== '') {
    parsed.ocrPageWorkers = positiveInteger(
      Number(pageWorkers),
      PACKAGE_QA_OCR_PAGE_WORKERS_ENV,
    );
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
