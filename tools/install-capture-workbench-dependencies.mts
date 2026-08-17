import { spawn } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CAPTURE_RUNTIME_VERSION } from './capture-runtime-version.mts';

const repoRoot = resolve(import.meta.dirname, '..');
const packageJsonPath = join(repoRoot, 'package.json');
const lockfilePath = join(repoRoot, 'pnpm-lock.yaml');
const workspaceFilePath = join(repoRoot, 'pnpm-workspace.yaml');
const nodeModulesLockfilePath = join(
  repoRoot,
  'node_modules',
  '.pnpm',
  'lock.yaml',
);
const workbenchPackageName = '@gx-capture/capture-workbench-ui';
const runtimeClientPackageName = '@gx-capture/capture-runtime-client';
type InstallMode =
  | { readonly kind: 'published' }
  | { readonly kind: 'candidate'; readonly packageDirectory: string };

function argumentValue(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function parseMode(args: readonly string[]): InstallMode {
  const packageDirectory = argumentValue(args, '--candidate-package-dir');
  if (packageDirectory === null) return { kind: 'published' };
  return {
    kind: 'candidate',
    packageDirectory: resolve(repoRoot, packageDirectory!),
  };
}

async function runPnpm(args: readonly string[]): Promise<void> {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `pnpm ${args.join(' ')} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}.`,
        ),
      );
    });
  });
}

function packageArchive(
  packageDirectory: string,
  packageName: string,
  version: string,
): string {
  const expected = `${packageName.replace(/^@/u, '').replace('/', '-')}-${version}.tgz`;
  const path = resolve(packageDirectory, expected);
  if (!isAbsolute(path) || basename(path) !== expected) {
    throw new Error(`Invalid candidate package path for ${packageName}.`);
  }
  return path;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

function setWorkbenchDependency(
  packageJson: Record<string, unknown>,
  value: string,
): void {
  const dependencies = packageJson.dependencies;
  if (!dependencies || typeof dependencies !== 'object') {
    throw new Error('package.json dependencies are missing.');
  }
  (dependencies as Record<string, unknown>)[workbenchPackageName] = value;
}

async function install(mode: InstallMode): Promise<void> {
  const originalPackageJson = await readFile(packageJsonPath);
  const originalLockfile = await readFile(lockfilePath);
  const originalWorkspaceFile = await readFile(workspaceFilePath);
  let originalNodeModulesLockfile: Buffer | null = null;
  const preserveInstallFiles =
    process.env.CAPTURE_PRESERVE_INSTALL_FILES === 'true';
  try {
    const packageJson = JSON.parse(originalPackageJson.toString('utf8')) as Record<
      string,
      unknown
    >;
    if (mode.kind === 'published') {
      process.stdout.write(
        `Installing published ${workbenchPackageName}@${CAPTURE_RUNTIME_VERSION} and ${runtimeClientPackageName}@${CAPTURE_RUNTIME_VERSION}.\n`,
      );
      await runPnpm(['install', '--frozen-lockfile']);
      return;
    }

    const manifest = await readJson(
      join(mode.packageDirectory, 'package.json'),
    ).catch(() => null);
    if (manifest !== null) {
      throw new Error(
        'The candidate package directory must contain archives, not a package manifest.',
      );
    }
    const workbenchArchive = packageArchive(
      mode.packageDirectory,
      workbenchPackageName,
      process.env.RELEASE_VERSION ?? CAPTURE_RUNTIME_VERSION,
    );
    const runtimeClientArchive = packageArchive(
      mode.packageDirectory,
      runtimeClientPackageName,
      process.env.RELEASE_VERSION ?? CAPTURE_RUNTIME_VERSION,
    );
    const candidatePackageJson = { ...packageJson };
    const workbenchOverride = workbenchArchive.replaceAll('\\', '/');
    setWorkbenchDependency(candidatePackageJson, `file:${workbenchOverride}`);
    const candidateDependencies = candidatePackageJson.dependencies;
    if (!candidateDependencies || typeof candidateDependencies !== 'object') {
      throw new Error('package.json dependencies are missing.');
    }
    const runtimeClientOverride = runtimeClientArchive.replaceAll('\\', '/');
    (candidateDependencies as Record<string, unknown>)[runtimeClientPackageName] =
      `file:${runtimeClientOverride}`;
    await writeFile(
      packageJsonPath,
      `${JSON.stringify(candidatePackageJson, null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      workspaceFilePath,
      `${originalWorkspaceFile.toString('utf8').trimEnd()}\noverrides:\n  '${runtimeClientPackageName}': file:${runtimeClientOverride}\n`,
      'utf8',
    );
    await unlink(lockfilePath);
    try {
      originalNodeModulesLockfile = await readFile(nodeModulesLockfilePath);
      await unlink(nodeModulesLockfilePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    process.stdout.write(
      `Installing ${workbenchPackageName} and ${runtimeClientPackageName} from the immutable candidate archives.\n`,
    );
    await runPnpm([
      'install',
      '--no-frozen-lockfile',
      '--lockfile=false',
      '--ignore-scripts',
    ]);
  } finally {
    if (!preserveInstallFiles) {
      await writeFile(packageJsonPath, originalPackageJson);
      await writeFile(lockfilePath, originalLockfile);
      await writeFile(workspaceFilePath, originalWorkspaceFile);
      if (originalNodeModulesLockfile !== null) {
        await writeFile(nodeModulesLockfilePath, originalNodeModulesLockfile);
      }
    }
  }
}

async function main(): Promise<void> {
  await install(parseMode(process.argv.slice(2)));
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
