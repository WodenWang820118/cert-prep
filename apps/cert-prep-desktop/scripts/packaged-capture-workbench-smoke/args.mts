import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface PackagedCaptureWorkbenchSmokeOptions {
  readonly workspaceRoot: string;
  readonly exePath: string;
  readonly outDir: string;
  readonly appDataDir: string;
  readonly cdpPort: number;
}

export function parsePackagedCaptureWorkbenchSmokeArgs(
  args: readonly string[],
  workspaceRoot = process.cwd(),
): PackagedCaptureWorkbenchSmokeOptions {
  let exePath: string | undefined;
  let outDir: string | undefined;
  let appDataDir: string | undefined;
  let cdpPort: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`${argument} requires a value.`);
    index += 1;
    if (argument === '--exe') exePath = resolve(workspaceRoot, value);
    else if (argument === '--out-dir') outDir = resolve(workspaceRoot, value);
    else if (argument === '--app-data-dir') appDataDir = resolve(workspaceRoot, value);
    else if (argument === '--cdp-port') cdpPort = Number(value);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!exePath) throw new Error('--exe is required.');
  if (!outDir) throw new Error('--out-dir is required.');
  if (!appDataDir) throw new Error('--app-data-dir is required.');
  if (
    cdpPort === undefined ||
    !Number.isInteger(cdpPort) ||
    cdpPort < 1 ||
    cdpPort > 65_535
  ) {
    throw new Error('--cdp-port must be a valid positive port.');
  }
  const child = relative(outDir, appDataDir);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child) || dirnameSegments(child) !== 1) {
    throw new Error('--app-data-dir must be a direct child of --out-dir.');
  }
  return { workspaceRoot, exePath, outDir, appDataDir, cdpPort };
}

function dirnameSegments(value: string): number {
  return value.split(/[\\/]+/).filter(Boolean).length;
}
