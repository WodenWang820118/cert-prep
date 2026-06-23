import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_OUTPUT,
  defaultWorkspaceRoot,
} from './package-qa/constants.mts';
import { parsePackageQaArgs } from './package-qa/cli.mts';
import {
  createPackageQaReport,
  writeReport,
} from './package-qa/report.mts';

async function main(): Promise<void> {
  const args = parsePackageQaArgs(process.argv.slice(2));
  const workspaceRoot = defaultWorkspaceRoot;
  const outputPath = resolve(workspaceRoot, args.output ?? DEFAULT_OUTPUT);
  const report = await createPackageQaReport({ ...args, workspaceRoot });
  writeReport(report, outputPath);
  console.log(`Wrote package QA report to ${outputPath}`);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
