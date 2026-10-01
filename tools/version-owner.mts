import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import {
  assertVersion,
  parseVersionJson,
  readCaptureVersion,
} from './capture-version-source.mts';
export {
  assertVersion,
  parseVersionJson,
  readCaptureVersion,
} from './capture-version-source.mts';

export type VersionScope = 'capture' | 'product';
type Field = Readonly<{
  path: string;
  field: string;
  pattern: RegExp;
  declarationPattern?: RegExp;
  section?: string;
  yamlSection?: string;
  array?: string;
}>;
export type VersionChange = Readonly<{
  path: string;
  field: string;
  before: string;
  after: string;
}>;
export type VersionPlan = Readonly<{
  scope: VersionScope;
  version: string;
  changes: readonly VersionChange[];
  pending: readonly string[];
  files: readonly Readonly<{ path: string; before: string; after: string }>[];
}>;

const CAPTURE_FIELDS: readonly Field[] = [
  {
    path: 'tools/capture-runtime-version.json',
    field: 'runtimeVersion',
    pattern: /("runtimeVersion"\s*:\s*")([^"]+)(")/gu,
  },
  {
    path: 'package.json',
    field: 'dependencies.@gx-capture/capture-workbench-ui',
    pattern: /("@gx-capture\/capture-workbench-ui"\s*:\s*")([^"]+)(")/gu,
  },
  {
    path: 'pnpm-workspace.yaml',
    field: 'minimumReleaseAgeExclude.workbenchUi',
    yamlSection: 'minimumReleaseAgeExclude',
    pattern: /(^[ \t]*- '@gx-capture\/capture-workbench-ui@)([^']+)(')/gmu,
  },
  {
    path: 'pnpm-workspace.yaml',
    field: 'minimumReleaseAgeExclude.runtimeClient',
    yamlSection: 'minimumReleaseAgeExclude',
    pattern: /(^[ \t]*- '@gx-capture\/capture-runtime-client@)([^']+)(')/gmu,
  },
  {
    path: 'apps/cert-prep-backend/pyproject.toml',
    field: 'project.dependencies.capture-runtime-client',
    section: 'project',
    array: 'dependencies',
    pattern: /("capture-runtime-client==)([^"\s]+)(")/gu,
  },
  {
    path: 'apps/cert-prep-desktop/src-tauri/Cargo.toml',
    field: 'dependencies.capture-sidecar-launcher',
    section: 'dependencies',
    declarationPattern: /^capture-sidecar-launcher[ \t]*=/gmu,
    pattern: /(^capture-sidecar-launcher\s*=\s*"=)([^"]+)(")/gmu,
  },
];

// The existing Tauri product manifest owns Cert's independent alpha version.
const PRODUCT_FIELDS: readonly Field[] = [
  {
    path: 'apps/cert-prep-desktop/src-tauri/tauri.conf.json',
    field: 'version',
    pattern: /("version"\s*:\s*")([^"]+)(")/gu,
  },
  {
    path: 'apps/cert-prep-desktop/src-tauri/Cargo.toml',
    field: 'package.version',
    section: 'package',
    pattern: /(^version\s*=\s*")([^"]+)(")/gmu,
  },
  ...[
    'apps/cert-prep-backend',
    'packages/cert-prep-contracts',
    'packages/cert-prep-ollama',
  ].map(
    (root): Field => ({
      path: `${root}/pyproject.toml`,
      field: 'project.version',
      section: 'project',
      pattern: /(^version\s*=\s*")([^"]+)(")/gmu,
    }),
  ),
  {
    path: 'apps/cert-prep-backend/src/cert_prep_backend/__init__.py',
    field: '__version__',
    pattern: /(^__version__\s*=\s*")([^"]+)(")/gmu,
  },
];

function workspaceFile(root: string, path: string): string {
  const file = realpathSync(join(root, path));
  const rel = relative(realpathSync(root), file);
  if (
    isAbsolute(rel) ||
    rel === '..' ||
    rel.startsWith(`..\\`) ||
    rel.startsWith('../')
  ) {
    throw new Error(`Version owner escapes workspace: ${path}`);
  }
  return file;
}

export function planVersions(
  root: string,
  scope: VersionScope,
  requested?: string,
): VersionPlan {
  if (scope !== 'capture' && scope !== 'product')
    throw new Error(`Unknown version scope: ${scope}`);
  const fields = scope === 'capture' ? CAPTURE_FIELDS : PRODUCT_FIELDS;
  const source = readFileSync(workspaceFile(root, fields[0].path), 'utf8');
  const current =
    scope === 'capture'
      ? readCaptureVersion(source)
      : (parseVersionJson(source) as { version?: unknown }).version;
  assertVersion(current);
  const version = requested ?? current;
  assertVersion(version);
  if (scope === 'product' && !/^\d+\.\d+\.\d+-alpha\.\d+$/u.test(version)) {
    throw new Error(
      'Cert product version must match the existing alpha release policy.',
    );
  }
  const files = new Map<
    string,
    { path: string; before: string; after: string }
  >();
  const changes: VersionChange[] = [];
  for (const field of fields) {
    let file = files.get(field.path);
    if (!file) {
      const before = readFileSync(workspaceFile(root, field.path), 'utf8');
      file = { path: field.path, before, after: before };
      files.set(field.path, file);
    }
    let ownerText = file.after;
    let sectionStart = 0;
    if (field.section) {
      const sections = [
        ...file.after.matchAll(/^\[([^\r\n]+)\][ \t]*(?:#[^\r\n]*)?\r?$/gmu),
      ];
      const owning = sections.filter((match) => match[1] === field.section);
      if (owning.length !== 1)
        throw new Error(`${field.path}:${field.section} requires one section.`);
      sectionStart = owning[0].index + owning[0][0].length;
      const sectionEnd =
        sections.find((match) => match.index >= sectionStart)?.index ??
        file.after.length;
      ownerText = file.after.slice(sectionStart, sectionEnd);
    }
    if (field.yamlSection) {
      const sections = [
        ...file.after.matchAll(/^([^\s][^:\r\n]*):[^\r\n]*\r?$/gmu),
      ];
      const owning = sections.filter((match) => match[1] === field.yamlSection);
      if (owning.length !== 1)
        throw new Error(
          `${field.path}:${field.yamlSection} requires one section.`,
        );
      sectionStart = owning[0].index + owning[0][0].length;
      const sectionEnd =
        sections.find((match) => match.index >= sectionStart)?.index ??
        file.after.length;
      ownerText = file.after.slice(sectionStart, sectionEnd);
    }
    let dependencyValues: unknown;
    if (field.array) {
      const arrays = [...ownerText.matchAll(/^dependencies[ \t]*=[ \t]*\[/gmu)];
      if (arrays.length !== 1)
        throw new Error(
          `${field.path}:project.dependencies requires one array.`,
        );
      const start = arrays[0].index + arrays[0][0].length - 1;
      let end = start + 1;
      let quoted = false;
      let escaped = false;
      let comment = false;
      let arrayJson = '[';
      for (; end < ownerText.length; end++) {
        const char = ownerText[end];
        if (comment) {
          if (char === '\n') {
            comment = false;
            arrayJson += char;
          }
          continue;
        }
        if (!quoted && char === '#') {
          comment = true;
          continue;
        }
        if (!quoted && char === ']') {
          arrayJson += ']';
          break;
        }
        arrayJson += char;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (quoted && char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '"') quoted = !quoted;
      }
      dependencyValues = JSON.parse(arrayJson.replace(/,\s*\]$/u, ']'));
      if (
        !Array.isArray(dependencyValues) ||
        !dependencyValues.every((value) => typeof value === 'string')
      )
        throw new Error(
          `${field.path}:project.dependencies must be a string array.`,
        );
      ownerText = ownerText.slice(start, end + 1);
      sectionStart += start;
    }
    if (field.declarationPattern) {
      const declarations = [...ownerText.matchAll(field.declarationPattern)];
      if (declarations.length !== 1)
        throw new Error(
          `${field.path}:${field.field} requires one owner; found ${declarations.length}.`,
        );
    }
    const matches = [...ownerText.matchAll(field.pattern)];
    if (matches.length !== 1)
      throw new Error(
        `${field.path}:${field.field} requires one owner; found ${matches.length}.`,
      );
    const before = matches[0][2];
    assertVersion(before);
    if (
      field.array &&
      !(dependencyValues as string[]).includes(
        `capture-runtime-client==${before}`,
      )
    ) {
      throw new Error(
        `${field.path}: Capture pin is not a project dependency.`,
      );
    }
    if (field.path.endsWith('.json')) {
      const parsed = parseVersionJson(file.after) as Record<string, unknown>;
      if (field.path === 'package.json') {
        const dependencies = parsed.dependencies as
          | Record<string, unknown>
          | undefined;
        if (
          dependencies?.['@gx-capture/capture-workbench-ui'] !== before ||
          [...file.after.matchAll(/"dependencies"\s*:/gu)].length !== 1
        ) {
          throw new Error(
            'package.json Capture dependency must have one dependencies owner.',
          );
        }
      } else if (
        field.field === 'runtimeVersion' ||
        field.field === 'version'
      ) {
        if (parsed[field.field] !== before)
          throw new Error(
            `${field.path}:${field.field} is not the root owner.`,
          );
      }
    }
    if (before !== version) {
      changes.push({
        path: field.path,
        field: field.field,
        before,
        after: version,
      });
      const updatedOwner = ownerText.replace(
        field.pattern,
        (_whole, prefix: string, _old: string, suffix: string) =>
          `${prefix}${version}${suffix}`,
      );
      file.after =
        file.after.slice(0, sectionStart) +
        updatedOwner +
        file.after.slice(sectionStart + ownerText.length);
    }
  }
  const pending =
    scope === 'capture'
      ? [
          'Resolve pnpm-lock.yaml using the selected published/candidate npm packages.',
          'Resolve apps/cert-prep-backend/uv.lock and desktop Cargo.lock using their package managers.',
          'Run cert-prep-backend:generate-openapi-client with the adopted Python SDK.',
          'Run Capture consumer inventory, candidate/contract identity gates and installed acceptance.',
        ]
      : [
          'Refresh local Cert package entries in Python and Cargo lockfiles with their package managers.',
          'Run the existing release assertWorkspaceVersions and release candidate verification.',
        ];
  return { scope, version, changes, pending, files: [...files.values()] };
}

/** Applies only declared owners. Locks, generated bytes and release evidence are never fabricated. */
export function applyVersionPlan(
  root: string,
  plan: VersionPlan,
  write: (path: string, content: string) => void = writeFileSync,
): void {
  const expected = planVersions(root, plan.scope, plan.version);
  if (JSON.stringify(expected) !== JSON.stringify(plan)) {
    throw new Error(
      'Version source changed after planning or plan contains undeclared edits.',
    );
  }
  const written: (typeof plan.files)[number][] = [];
  try {
    for (const file of plan.files) {
      if (file.before === file.after) continue;
      written.push(file);
      write(workspaceFile(root, file.path), file.after);
    }
  } catch (error) {
    const restoreErrors: Error[] = [];
    for (const file of written.reverse()) {
      try {
        write(workspaceFile(root, file.path), file.before);
      } catch (restoreError) {
        restoreErrors.push(
          new Error(`Rollback failed for ${file.path}`, {
            cause: restoreError,
          }),
        );
      }
    }
    if (restoreErrors.length)
      throw new AggregateError(
        [error, ...restoreErrors],
        'Version apply failed; rollback is incomplete. Inspect the listed files.',
      );
    throw error;
  }
}

/** Resolve the client from the declared UI package, as its loader does under pnpm. */
export function readInstalledCaptureContract(
  root: string,
  expectedVersion: string,
) {
  const uiManifestPath = realpathSync(
    join(root, 'node_modules/@gx-capture/capture-workbench-ui/package.json'),
  );
  const ui = JSON.parse(readFileSync(uiManifestPath, 'utf8')) as {
    version: unknown;
  };
  if (ui.version !== expectedVersion)
    throw new Error(
      `Installed capture-workbench-ui ${String(ui.version)} does not match adopted ${expectedVersion}.`,
    );
  const clientManifestPath = createRequire(uiManifestPath).resolve(
    '@gx-capture/capture-runtime-client/package.json',
  );
  const client = JSON.parse(readFileSync(clientManifestPath, 'utf8')) as {
    version: unknown;
    contractSetSha256: string;
  };
  if (client.version !== expectedVersion)
    throw new Error(
      `Installed capture-runtime-client ${String(client.version)} does not match adopted ${expectedVersion}.`,
    );
  return {
    source: 'installed UI-resolved Capture SDK contract asset',
    bytes: readFileSync(
      join(dirname(clientManifestPath), 'private/assets/contract-set.json'),
    ),
    declaredSha256: client.contractSetSha256,
  };
}

export async function runVersionCommand(
  args: readonly string[],
  root = resolve('.'),
): Promise<number> {
  const [mode, ...options] = args;
  if (!['plan', 'check', 'apply'].includes(mode))
    throw new Error(
      'Usage: version-owner.mts plan|check|apply [--scope capture|product] [--version VERSION]',
    );
  let scope: VersionScope = 'capture';
  let version: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < options.length; index += 2) {
    const key = options[index];
    const value = options[index + 1];
    if (seen.has(key) || !value || !['--scope', '--version'].includes(key))
      throw new Error(`Invalid or duplicate option: ${key}`);
    seen.add(key);
    if (key === '--scope') scope = value as VersionScope;
    else version = value;
  }
  const plan = planVersions(root, scope, version);
  if (mode === 'apply') applyVersionPlan(root, plan);
  let verificationError: string | undefined;
  if (mode === 'check' && plan.changes.length === 0) {
    try {
      if (scope === 'capture') {
        const {
          assertCaptureRuntimeConsumerVersions,
          assertCaptureRuntimeConsumerInventory,
          readCaptureRuntimeConsumerInventory,
        } = await import('./capture-runtime-version-check.mts');
        assertCaptureRuntimeConsumerVersions(root);
        assertCaptureRuntimeConsumerInventory(
          readCaptureRuntimeConsumerInventory(
            root,
            readInstalledCaptureContract(root, plan.version),
          ),
        );
      } else {
        const { assertWorkspaceVersions } =
          await import('./release/release-lib.ts');
        assertWorkspaceVersions(root, plan.version);
      }
    } catch (error) {
      verificationError = String(error);
    }
  }
  console.log(
    JSON.stringify(
      {
        scope,
        version: plan.version,
        status:
          mode === 'check'
            ? plan.changes.length || verificationError
              ? 'blocked'
              : 'checked-declarations'
            : mode === 'apply'
              ? 'source-prepared'
              : 'planned',
        changes: plan.changes,
        pending:
          mode === 'check' &&
          scope === 'capture' &&
          !plan.changes.length &&
          !verificationError
            ? []
            : plan.pending,
        ...(verificationError ? { verificationError } : {}),
        releaseAcceptance: 'not-performed',
      },
      null,
      2,
    ),
  );
  return mode === 'check' && (plan.changes.length > 0 || verificationError)
    ? 1
    : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = await runVersionCommand(process.argv.slice(2));
}
