import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SmokeOptions } from './types.mts';

const DEFAULT_TARGET_TRIPLE = 'x86_64-pc-windows-msvc';
const DEFAULT_OUT_ROOT = 'tmp/cert-prep-desktop/packaged-flow-smoke';
const DEFAULT_BASELINE_OUT_ROOT =
  'tmp/cert-prep-desktop/packaged-question-generation-baseline';
const DEFAULT_PRODUCTION_OUT_ROOT =
  'tmp/cert-prep-desktop/packaged-question-generation-production';
const DEFAULT_PDF_PATH =
  'pdfs/\u30101\u30112025\u5e7407\u6708N1 \u771f\u9898.pdf';
const DEFAULT_CDP_PORT = 9491;
const DEFAULT_LLM_PROVIDER = 'auto';
const DEFAULT_QUESTION_JOBS_COMPLETE_TIMEOUT_MS = 1_200_000;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = resolve(scriptDir, '../../../..');

/** Parses packaged smoke CLI/env knobs without changing runtime side effects. */
export function parsePackagedFlowSmokeArgs(
  args: readonly string[],
  workspaceRoot = defaultWorkspaceRoot,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
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
    llmProvider:
      environment.CERT_PREP_PACKAGE_SMOKE_LLM_PROVIDER?.trim() ||
      DEFAULT_LLM_PROVIDER,
    questionJobsChunkLimit: optionalPositiveInteger(
      environment.CERT_PREP_PACKAGE_SMOKE_QUESTION_JOBS_CHUNK_LIMIT,
      'CERT_PREP_PACKAGE_SMOKE_QUESTION_JOBS_CHUNK_LIMIT',
    ),
    questionJobWorkers: optionalPositiveInteger(
      environment.CERT_PREP_PACKAGE_SMOKE_QUESTION_JOB_WORKERS,
      'CERT_PREP_PACKAGE_SMOKE_QUESTION_JOB_WORKERS',
    ),
    waitForQuestionJobs: false,
    questionJobsCompleteTimeoutMs:
      optionalPositiveInteger(
        environment.CERT_PREP_PACKAGE_SMOKE_QUESTION_JOBS_COMPLETE_TIMEOUT_MS,
        'CERT_PREP_PACKAGE_SMOKE_QUESTION_JOBS_COMPLETE_TIMEOUT_MS',
      ) ?? DEFAULT_QUESTION_JOBS_COMPLETE_TIMEOUT_MS,
    skipGpuSampling: false,
    productionSummary: false,
    allowCaptureChunkVariance: false,
    verifyGeneratedQuestionsPracticeReady: false,
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
      // --out-root is timestamped here, so question generation defaults must not replace it.
      outDirExplicit = true;
      parsed.outDir = resolve(workspaceRoot, readValue(arg), timestamp);
    } else if (arg === '--app-data-dir') {
      appDataDirExplicit = true;
      parsed.appDataDir = resolve(workspaceRoot, readValue(arg));
    } else if (arg === '--cdp-port') {
      parsed.cdpPort = positiveInteger(Number(readValue(arg)), arg);
    } else if (arg === '--llm-provider') {
      parsed.llmProvider = nonEmptyString(readValue(arg), arg).toLowerCase();
    } else if (arg === '--question-jobs-chunk-limit') {
      parsed.questionJobsChunkLimit = positiveInteger(
        Number(readValue(arg)),
        arg,
      );
    } else if (arg === '--question-job-workers') {
      parsed.questionJobWorkers = positiveInteger(
        Number(readValue(arg)),
        arg,
      );
    } else if (arg === '--wait-for-question-jobs') {
      parsed.waitForQuestionJobs = true;
    } else if (arg === '--question-jobs-complete-timeout-ms') {
      parsed.questionJobsCompleteTimeoutMs = positiveInteger(
        Number(readValue(arg)),
        arg,
      );
    } else if (arg === '--skip-gpu-sampling') {
      parsed.skipGpuSampling = true;
    } else if (arg === '--production-summary') {
      parsed.productionSummary = true;
      parsed.waitForQuestionJobs = true;
    } else if (arg === '--allow-capture-chunk-variance') {
      parsed.allowCaptureChunkVariance = true;
    } else if (arg === '--verify-generated-questions-practice-ready') {
      parsed.verifyGeneratedQuestionsPracticeReady = true;
      parsed.waitForQuestionJobs = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  parsed.llmProvider = nonEmptyString(
    parsed.llmProvider,
    'llmProvider',
  ).toLowerCase();
  parsed.questionJobsCompleteTimeoutMs = positiveInteger(
    parsed.questionJobsCompleteTimeoutMs,
    'questionJobsCompleteTimeoutMs',
  );
  if (parsed.waitForQuestionJobs && !outDirExplicit) {
    const outRoot = parsed.productionSummary
      ? DEFAULT_PRODUCTION_OUT_ROOT
      : DEFAULT_BASELINE_OUT_ROOT;
    parsed.outDir = resolve(workspaceRoot, outRoot, timestamp);
  }
  if (parsed.waitForQuestionJobs && !appDataDirExplicit) {
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
