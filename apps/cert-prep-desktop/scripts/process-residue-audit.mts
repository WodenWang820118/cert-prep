import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyProcessForAudit,
  snapshotWindowsProcesses,
  type ProcessClassification,
  type ProcessRecord,
  type RecommendedProcessAction,
} from './process-lifecycle/processes.mts';

interface ProcessResidueAuditRecord {
  readonly pid: number;
  readonly parentPid: number;
  readonly name: string;
  readonly executablePath: string;
  readonly commandLine: string;
  readonly workingSetBytes: number | null;
  readonly classification: ProcessClassification;
  readonly recommendedAction: RecommendedProcessAction;
  readonly protected: boolean;
  readonly evidence: string[];
}

interface ProcessResidueAuditReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly platform: NodeJS.Platform;
  readonly workspaceRoot: string;
  readonly unsupportedReason: string | null;
  readonly processes: ProcessResidueAuditRecord[];
}

interface ProcessResidueAuditOptions {
  readonly workspaceRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly generatedAt?: string;
  readonly processes?: readonly ProcessRecord[];
}

interface ParsedArgs {
  readonly output: string;
  readonly workspaceRoot: string;
}

const DEFAULT_OUTPUT = resolve(
  process.cwd(),
  'tmp',
  'cert-prep-desktop',
  'process-residue-audit',
  'processes.json',
);

export function buildProcessResidueAuditReport({
  workspaceRoot,
  platform = process.platform,
  generatedAt = new Date().toISOString(),
  processes = platform === 'win32' ? snapshotWindowsProcesses() : [],
}: ProcessResidueAuditOptions): ProcessResidueAuditReport {
  if (platform !== 'win32') {
    return {
      schemaVersion: 1,
      generatedAt,
      platform,
      workspaceRoot,
      unsupportedReason:
        'Process residue audit is currently implemented for Windows only.',
      processes: [],
    };
  }

  return {
    schemaVersion: 1,
    generatedAt,
    platform,
    workspaceRoot,
    unsupportedReason: null,
    processes: processes.map((record) => {
      const classification = classifyProcessForAudit(record, { workspaceRoot });
      return {
        pid: record.pid,
        parentPid: record.parentPid,
        name: record.name,
        executablePath: record.executablePath,
        commandLine: record.commandLine,
        workingSetBytes: record.workingSetBytes,
        classification: classification.classification,
        recommendedAction: classification.recommendedAction,
        protected: classification.protected,
        evidence: classification.evidence,
      };
    }),
  };
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let output = DEFAULT_OUTPUT;
  let workspaceRoot = process.cwd();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--output requires a path value');
      }
      output = resolve(value);
      index += 1;
    } else if (arg === '--workspace-root') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--workspace-root requires a path value');
      }
      workspaceRoot = resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { output, workspaceRoot: resolve(workspaceRoot) };
}

async function main(): Promise<void> {
  const { output, workspaceRoot } = parseArgs(process.argv.slice(2));
  const report = buildProcessResidueAuditReport({ workspaceRoot });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const counts = report.processes.reduce<Record<string, number>>((acc, processRecord) => {
    acc[processRecord.classification] =
      (acc[processRecord.classification] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    JSON.stringify(
      {
        output,
        platform: report.platform,
        unsupportedReason: report.unsupportedReason,
        processCount: report.processes.length,
        counts,
      },
      null,
      2,
    ),
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
