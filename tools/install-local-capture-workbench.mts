import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPTURE_RUNTIME_CLIENT_PACKAGE_NAME,
  CAPTURE_RUNTIME_PACKAGE_NAME,
  CAPTURE_RUNTIME_VERSION,
} from './capture-runtime-version.mts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registry = (
  process.env.CAPTURE_WORKBENCH_LOCAL_REGISTRY ?? 'http://127.0.0.1:4873'
).replace(/\/$/, '');
const packageName = CAPTURE_RUNTIME_PACKAGE_NAME;
const runtimeClientPackageName = CAPTURE_RUNTIME_CLIENT_PACKAGE_NAME;
const packageVersion = CAPTURE_RUNTIME_VERSION;
const captureWorkbenchRoot = resolve(
  process.env.CAPTURE_WORKBENCH_REPO ??
    join(repoRoot, '..', 'capture-workbench'),
);
const corepackCli = join(
  dirname(process.execPath),
  'node_modules',
  'corepack',
  'dist',
  'corepack.js',
);

function runPnpm(args: readonly string[], cwd = repoRoot): Promise<void> {
  if (!existsSync(corepackCli)) {
    throw new Error('Node 24 Corepack is required to run the pnpm 11 install.');
  }

  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [corepackCli, 'pnpm', ...args], {
      cwd,
      env: {
        ...process.env,
        CAPTURE_WORKBENCH_LOCAL_REGISTRY: registry,
        CI: 'true',
      },
      shell: false,
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
          `pnpm ${args.join(' ')} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`,
        ),
      );
    });
  });
}

async function registryIsReachable(): Promise<boolean> {
  try {
    await fetch(registry, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

function startRegistry(): void {
  if (!existsSync(captureWorkbenchRoot)) {
    throw new Error(
      `Capture Workbench repo was not found at ${captureWorkbenchRoot}. Set CAPTURE_WORKBENCH_REPO to override it.`,
    );
  }
  const child = spawn(
    process.execPath,
    [corepackCli, 'pnpm', 'run', 'local-registry:start'],
    {
      cwd: captureWorkbenchRoot,
      detached: true,
      env: {
        ...process.env,
        CAPTURE_WORKBENCH_LOCAL_REGISTRY: registry,
        CI: 'true',
      },
      shell: false,
      stdio: 'ignore',
    },
  );
  child.unref();
}

async function waitForRegistry(): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await registryIsReachable()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`Local registry did not become reachable at ${registry}.`);
}

function packageMetadataUrl(name: string): string {
  return `${registry}/${name.replace('/', '%2f')}`;
}

async function packageIsPublished(name: string): Promise<boolean> {
  try {
    const response = await fetch(packageMetadataUrl(name), {
      signal: AbortSignal.timeout(1_500),
    });
    if (response.status === 404) return false;
    if (!response.ok) {
      throw new Error(
        `Registry metadata request failed with HTTP ${response.status}.`,
      );
    }
    const metadata = (await response.json()) as {
      name?: string;
      versions?: Record<string, unknown>;
    };
    return metadata.name === name && !!metadata.versions?.[packageVersion];
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return false;
    throw error;
  }
}

async function ensureLocalPackage(): Promise<void> {
  if (!(await registryIsReachable())) {
    startRegistry();
    await waitForRegistry();
  }
  if (
    !(await packageIsPublished(packageName)) ||
    !(await packageIsPublished(runtimeClientPackageName))
  ) {
    await runPnpm(['run', 'local-registry:publish'], captureWorkbenchRoot);
  }
}

async function assertPublishedPackage(name: string): Promise<void> {
  const response = await fetch(packageMetadataUrl(name));
  if (!response.ok) {
    throw new Error(
      `${name}@${packageVersion} is unavailable from ${registry} (HTTP ${response.status}).`,
    );
  }
  const metadata = (await response.json()) as {
    name?: string;
    versions?: Record<string, unknown>;
  };
  if (metadata.name !== name || !metadata.versions?.[packageVersion]) {
    throw new Error(
      `${name}@${packageVersion} is unavailable from ${registry}.`,
    );
  }
}

async function main(): Promise<void> {
  await ensureLocalPackage();
  await assertPublishedPackage(packageName);
  await assertPublishedPackage(runtimeClientPackageName);
  const userConfigPath = join(repoRoot, '.npmrc');
  if (existsSync(userConfigPath)) {
    throw new Error(
      `Refusing to overwrite an existing temporary npm config: ${userConfigPath}`,
    );
  }
  writeFileSync(
    userConfigPath,
    `registry=${registry}\n@${packageName.split('/')[0].slice(1)}:registry=${registry}\n`,
    'utf8',
  );

  try {
    await runPnpm(['install', '--no-frozen-lockfile']);
    for (const name of [packageName]) {
      const installedManifestPath = join(
        repoRoot,
        `node_modules/${name}/package.json`,
      );
      if (!existsSync(installedManifestPath)) {
        throw new Error(
          `pnpm install completed but ${name} was not linked into node_modules.`,
        );
      }
      const installedManifest = JSON.parse(
        readFileSync(installedManifestPath, 'utf8'),
      ) as { name?: string; version?: string };
      if (
        installedManifest.name !== name ||
        installedManifest.version !== packageVersion
      ) {
        throw new Error(
          `Unexpected installed package: ${installedManifest.name}@${installedManifest.version}.`,
        );
      }
    }
    process.stdout.write(
      `Installed ${packageName}@${packageVersion} from ${registry}.\n`,
    );
  } finally {
    rmSync(userConfigPath, { force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
