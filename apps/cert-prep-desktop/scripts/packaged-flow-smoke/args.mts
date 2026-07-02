import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_LLM_MODEL } from '../package-qa/constants.mts';
import type { SmokeOptions } from './types.mts';

const DEFAULT_TARGET_TRIPLE = 'x86_64-pc-windows-msvc';
const DEFAULT_OUT_ROOT = 'tmp/cert-prep-desktop/packaged-flow-smoke';
const DEFAULT_BASELINE_OUT_ROOT =
  'tmp/cert-prep-desktop/packaged-streaming-baseline';
const DEFAULT_PRODUCTION_OUT_ROOT =
  'tmp/cert-prep-desktop/packaged-streaming-production';
const DEFAULT_PDF_PATH = 'pdfs/\u30101\u30112025\u5e7407\u6708N1 \u771f\u9898.pdf';
const DEFAULT_CDP_PORT = 9491;
const DEFAULT_OCR_PROVIDER = 'windowsml';
const DEFAULT_OCR_PAGE_WORKERS = 1;
const DEFAULT_LLM_PROVIDER = 'fastflowlm';
const DEFAULT_OLLAMA_FALLBACK_MODELS = ['qwen3.5:2b'];
const DEFAULT_STREAMING_COMPLETE_TIMEOUT_MS = 1_200_000;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = resolve(scriptDir, '../../../..');

/** Parses packaged smoke CLI/env knobs without changing runtime side effects. */
export function parsePackagedFlowSmokeArgs(
  args: readonly string[],
  workspaceRoot = defaultWorkspaceRoot,
): SmokeOptions {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  let outDirExplicit = false;
  let appDataDirExplicit = false;
  const parsed: SmokeOptions = {
    workspaceRoot,
    exePath: resolve(
      workspaceRoot,
      'apps/cert-prep-desktop/src-tauri/target',
      DEFAULT_TARGET_TRIPLE,
      'release/cert-prep-desktop.exe',
    ),
    pdfPath: resolve(workspaceRoot, DEFAULT_PDF_PATH),
    outDir: resolve(workspaceRoot, DEFAULT_OUT_ROOT, timestamp),
    cdpPort: DEFAULT_CDP_PORT,
    ocrProvider:
      process.env.CERT_PREP_PACKAGE_SMOKE_OCR_PROVIDER?.trim() ||
      DEFAULT_OCR_PROVIDER,
    ocrPageWorkers: Number(
      process.env.CERT_PREP_PACKAGE_SMOKE_OCR_PAGE_WORKERS ??
        DEFAULT_OCR_PAGE_WORKERS,
    ),
    llmProvider:
      process.env.CERT_PREP_PACKAGE_SMOKE_LLM_PROVIDER?.trim() ||
      DEFAULT_LLM_PROVIDER,
    ollamaModel:
      process.env.CERT_PREP_PACKAGE_SMOKE_LLM_MODEL?.trim() ||
      process.env.CERT_PREP_PACKAGE_SMOKE_OLLAMA_MODEL?.trim() ||
      DEFAULT_LLM_MODEL,
    ollamaFallbackModels: stringList(
      process.env.CERT_PREP_PACKAGE_SMOKE_LLM_FALLBACK_MODELS ??
        process.env.CERT_PREP_PACKAGE_SMOKE_OLLAMA_FALLBACK_MODELS,
      DEFAULT_OLLAMA_FALLBACK_MODELS,
    ),
    streamingDraftPageLimit: optionalPositiveInteger(
      process.env.CERT_PREP_PACKAGE_SMOKE_STREAMING_DRAFT_PAGE_LIMIT,
      'CERT_PREP_PACKAGE_SMOKE_STREAMING_DRAFT_PAGE_LIMIT',
    ),
    streamingDraftWorkers: optionalPositiveInteger(
      process.env.CERT_PREP_PACKAGE_SMOKE_STREAMING_DRAFT_WORKERS,
      'CERT_PREP_PACKAGE_SMOKE_STREAMING_DRAFT_WORKERS',
    ),
    waitForStreamingComplete: false,
    streamingCompleteTimeoutMs:
      optionalPositiveInteger(
        process.env.CERT_PREP_PACKAGE_SMOKE_STREAMING_COMPLETE_TIMEOUT_MS,
        'CERT_PREP_PACKAGE_SMOKE_STREAMING_COMPLETE_TIMEOUT_MS',
      ) ?? DEFAULT_STREAMING_COMPLETE_TIMEOUT_MS,
    skipGpuSampling: false,
    productionSummary: false,
    allowOcrChunkVariance: false,
    verifyStreamingPracticeReady: false,
    recordVideo: booleanEnv(process.env.CERT_PREP_PACKAGE_SMOKE_RECORD_VIDEO),
  };

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

    if (arg === '--exe') {
      parsed.exePath = resolve(workspaceRoot, readValue(arg));
    } else if (arg === '--pdf') {
      parsed.pdfPath = resolve(workspaceRoot, readValue(arg));
    } else if (arg === '--out-dir') {
      outDirExplicit = true;
      parsed.outDir = resolve(workspaceRoot, readValue(arg));
    } else if (arg === '--out-root') {
      // --out-root is timestamped here, so streaming defaults must not replace it.
      outDirExplicit = true;
      parsed.outDir = resolve(workspaceRoot, readValue(arg), timestamp);
    } else if (arg === '--app-data-dir') {
      appDataDirExplicit = true;
      parsed.appDataDir = resolve(workspaceRoot, readValue(arg));
    } else if (arg === '--cdp-port') {
      parsed.cdpPort = positiveInteger(Number(readValue(arg)), arg);
    } else if (arg === '--ocr-provider') {
      parsed.ocrProvider = nonEmptyString(readValue(arg), arg);
    } else if (arg === '--ocr-page-workers') {
      parsed.ocrPageWorkers = positiveInteger(Number(readValue(arg)), arg);
    } else if (arg === '--llm-provider') {
      parsed.llmProvider = nonEmptyString(readValue(arg), arg).toLowerCase();
    } else if (arg === '--llm-model') {
      parsed.ollamaModel = nonEmptyString(readValue(arg), arg);
    } else if (arg === '--llm-fallback-models') {
      parsed.ollamaFallbackModels = stringList(readValue(arg), []);
    } else if (arg === '--ollama-model') {
      parsed.ollamaModel = nonEmptyString(readValue(arg), arg);
    } else if (arg === '--ollama-fallback-models') {
      parsed.ollamaFallbackModels = stringList(readValue(arg), []);
    } else if (arg === '--streaming-draft-page-limit') {
      parsed.streamingDraftPageLimit = positiveInteger(Number(readValue(arg)), arg);
    } else if (arg === '--streaming-draft-workers') {
      parsed.streamingDraftWorkers = positiveInteger(Number(readValue(arg)), arg);
    } else if (arg === '--wait-for-streaming-complete') {
      parsed.waitForStreamingComplete = true;
    } else if (arg === '--streaming-complete-timeout-ms') {
      parsed.streamingCompleteTimeoutMs = positiveInteger(
        Number(readValue(arg)),
        arg,
      );
    } else if (arg === '--skip-gpu-sampling') {
      parsed.skipGpuSampling = true;
    } else if (arg === '--production-summary') {
      parsed.productionSummary = true;
      parsed.waitForStreamingComplete = true;
    } else if (arg === '--allow-ocr-chunk-variance') {
      parsed.allowOcrChunkVariance = true;
    } else if (arg === '--verify-streaming-practice-ready') {
      parsed.verifyStreamingPracticeReady = true;
      parsed.waitForStreamingComplete = true;
    } else if (arg === '--record-video') {
      parsed.recordVideo = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  parsed.ocrPageWorkers = positiveInteger(
    parsed.ocrPageWorkers,
    'ocrPageWorkers',
  );
  parsed.ocrProvider = nonEmptyString(parsed.ocrProvider, 'ocrProvider');
  parsed.llmProvider = nonEmptyString(parsed.llmProvider, 'llmProvider').toLowerCase();
  parsed.ollamaModel = nonEmptyString(parsed.ollamaModel, 'ollamaModel');
  parsed.ollamaFallbackModels = nonEmptyStringList(
    parsed.ollamaFallbackModels,
    'ollamaFallbackModels',
  );
  parsed.streamingCompleteTimeoutMs = positiveInteger(
    parsed.streamingCompleteTimeoutMs,
    'streamingCompleteTimeoutMs',
  );
  if (parsed.waitForStreamingComplete && !outDirExplicit) {
    const outRoot = parsed.productionSummary
      ? DEFAULT_PRODUCTION_OUT_ROOT
      : DEFAULT_BASELINE_OUT_ROOT;
    parsed.outDir = resolve(workspaceRoot, outRoot, timestamp);
  }
  if (parsed.waitForStreamingComplete && !appDataDirExplicit) {
    parsed.appDataDir = resolve(parsed.outDir, 'app-data');
  }
  return parsed;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function optionalPositiveInteger(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  return positiveInteger(Number(value), name);
}

function nonEmptyString(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${name} must not be empty.`);
  }
  return trimmed;
}

function stringList(
  value: string | undefined,
  defaultValues: readonly string[],
): string[] {
  const source = value === undefined ? defaultValues.join(',') : value;
  return source
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function nonEmptyStringList(values: readonly string[], name: string): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const trimmed = nonEmptyString(value, name);
    unique.add(trimmed);
  }
  return [...unique];
}

function booleanEnv(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}
