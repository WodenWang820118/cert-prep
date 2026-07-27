import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const captureWorkbenchRoot = resolve(
  process.env.CAPTURE_WORKBENCH_CI_ROOT ??
    join(repoRoot, '..', 'capture-workbench-ci'),
);
const packageName = '@gx/capture-workbench';
const packageVersion = '0.3.0';

function runPnpm(args: readonly string[], cwd: string): void {
  const pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const managedPnpm = process.env.PNPM_HOME
    ? join(process.env.PNPM_HOME, pnpmExecutable)
    : undefined;
  const executable =
    managedPnpm && existsSync(managedPnpm)
      ? managedPnpm
      : process.platform === 'win32'
        ? 'corepack.cmd'
        : 'corepack';
  const commandArgs = executable === managedPnpm ? args : ['pnpm', ...args];
  const result = spawnSync(executable, [...commandArgs], {
    cwd,
    shell: true,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `pnpm ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}.`,
    );
  }
}

runPnpm(['install', '--frozen-lockfile'], captureWorkbenchRoot);
runPnpm(
  ['nx', 'run', 'capture-angular:pack', '--skip-nx-cache'],
  captureWorkbenchRoot,
);

const packageRoot = join(
  captureWorkbenchRoot,
  'dist',
  'packages',
  'capture-angular',
);
const packageManifest = JSON.parse(
  readFileSync(join(packageRoot, 'package.json'), 'utf8'),
) as { name?: string; version?: string };
if (
  packageManifest.name !== packageName ||
  packageManifest.version !== packageVersion
) {
  throw new Error(
    `Expected ${packageName}@${packageVersion}, found ${packageManifest.name ?? 'unknown'}@${packageManifest.version ?? 'unknown'}.`,
  );
}

const packageArchiveName = 'gx-capture-workbench-0.3.0.tgz';
const archivePath = join(
  captureWorkbenchRoot,
  'dist',
  'packs',
  packageArchiveName,
);
if (!existsSync(archivePath)) {
  throw new Error(
    `Capture Workbench package archive is missing: ${archivePath}.`,
  );
}
const archiveSpec = `file:${relative(repoRoot, archivePath).replaceAll('\\', '/')}`;
const rootPackagePath = join(repoRoot, 'package.json');
const rootPackage = JSON.parse(readFileSync(rootPackagePath, 'utf8')) as {
  dependencies?: Record<string, string>;
};
if (!rootPackage.dependencies?.[packageName]) {
  throw new Error(`The root package manifest does not declare ${packageName}.`);
}
rootPackage.dependencies[packageName] = archiveSpec;
writeFileSync(
  rootPackagePath,
  `${JSON.stringify(rootPackage, null, 2)}\n`,
  'utf8',
);

runPnpm(['install', '--no-frozen-lockfile'], repoRoot);
