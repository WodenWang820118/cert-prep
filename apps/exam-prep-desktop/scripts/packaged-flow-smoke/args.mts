import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SmokeOptions } from './types.mts';

const DEFAULT_TARGET_TRIPLE = 'x86_64-pc-windows-msvc';
const DEFAULT_OUT_ROOT = 'tmp/exam-prep-desktop/packaged-flow-smoke';
const DEFAULT_BASELINE_OUT_ROOT =
  'tmp/exam-prep-desktop/packaged-streaming-baseline';
const DEFAULT_PDF_PATH = 'pdfs/\u30101\u30112025\u5e7407\u6708N1 \u771f\u9898.pdf';
const DEFAULT_CDP_PORT = 9491;
const DEFAULT_OCR_PAGE_WORKERS = 1;
const DEFAULT_OLLAMA_MODEL = 'qwen3:14b';
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
      'apps/exam-prep-desktop/src-tauri/target',
      DEFAULT_TARGET_TRIPLE,
      'release/exam-prep-desktop.exe',
    ),
    pdfPath: resolve(workspaceRoot, DEFAULT_PDF_PATH),
    outDir: resolve(workspaceRoot, DEFAULT_OUT_ROOT, timestamp),
    cdpPort: DEFAULT_CDP_PORT,
    ocrPageWorkers: Number(
      process.env.EXAM_PREP_PACKAGE_SMOKE_OCR_PAGE_WORKERS ??
        DEFAULT_OCR_PAGE_WORKERS,
    ),
    ollamaModel:
      process.env.EXAM_PREP_PACKAGE_SMOKE_OLLAMA_MODEL?.trim() ||
      DEFAULT_OLLAMA_MODEL,
    streamingDraftPageLimit: optionalPositiveInteger(
      process.env.EXAM_PREP_PACKAGE_SMOKE_STREAMING_DRAFT_PAGE_LIMIT,
      'EXAM_PREP_PACKAGE_SMOKE_STREAMING_DRAFT_PAGE_LIMIT',
    ),
    streamingDraftWorkers: optionalPositiveInteger(
      process.env.EXAM_PREP_PACKAGE_SMOKE_STREAMING_DRAFT_WORKERS,
      'EXAM_PREP_PACKAGE_SMOKE_STREAMING_DRAFT_WORKERS',
    ),
    waitForStreamingComplete: false,
    streamingCompleteTimeoutMs:
      optionalPositiveInteger(
        process.env.EXAM_PREP_PACKAGE_SMOKE_STREAMING_COMPLETE_TIMEOUT_MS,
        'EXAM_PREP_PACKAGE_SMOKE_STREAMING_COMPLETE_TIMEOUT_MS',
      ) ?? DEFAULT_STREAMING_COMPLETE_TIMEOUT_MS,
    skipGpuSampling: false,
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
    } else if (arg === '--app-data-dir') {
      appDataDirExplicit = true;
      parsed.appDataDir = resolve(workspaceRoot, readValue(arg));
    } else if (arg === '--cdp-port') {
      parsed.cdpPort = positiveInteger(Number(readValue(arg)), arg);
    } else if (arg === '--ocr-page-workers') {
      parsed.ocrPageWorkers = positiveInteger(Number(readValue(arg)), arg);
    } else if (arg === '--ollama-model') {
      parsed.ollamaModel = nonEmptyString(readValue(arg), arg);
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
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  parsed.ocrPageWorkers = positiveInteger(
    parsed.ocrPageWorkers,
    'ocrPageWorkers',
  );
  parsed.ollamaModel = nonEmptyString(parsed.ollamaModel, 'ollamaModel');
  parsed.streamingCompleteTimeoutMs = positiveInteger(
    parsed.streamingCompleteTimeoutMs,
    'streamingCompleteTimeoutMs',
  );
  if (parsed.waitForStreamingComplete && !outDirExplicit) {
    parsed.outDir = resolve(workspaceRoot, DEFAULT_BASELINE_OUT_ROOT, timestamp);
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
