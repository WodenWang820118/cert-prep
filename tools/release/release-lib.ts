import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateResilienceEvidence,
  validateSessionRestartEvidence,
} from '../../apps/cert-prep-desktop/scripts/packaged-resilience/evidence-contract.mts';

export const ALPHA_VERSION_PATTERN = /^\d+\.\d+\.\d+-alpha\.\d+$/;
export const RELEASE_CHANNEL = 'unsigned_public_alpha';
export const PUBLIC_UNSIGNED_ALPHA_PROFILE = 'public_unsigned_alpha';
export const LOCAL_NONPUBLISHABLE_PROFILE = 'local_nonpublishable';
export const RELEASE_TAG_PREFIX = 'cert-prep-v';
export const TARGET_TRIPLE = 'x86_64-pc-windows-msvc';
export const RELEASE_PYTHON_VERSION = '3.12';

export const HARDWARE_CANCELLATION_CHECKS = [
  'upload',
  'ocr',
  'draft',
  'runtime',
  'model',
  'cancelVsCompleteRace',
  'crashRecovery',
  'partialDataRemoved',
  'ownedProcessesReleased',
];

export function assertSupportedDistributionPlan(plan) {
  const version = String(plan?.version ?? '');
  const commitSha = String(plan?.commitSha ?? '').toLowerCase();
  const repository = String(plan?.repository ?? '');
  const tag = String(plan?.tag ?? '');
  const commonValid =
    ALPHA_VERSION_PATTERN.test(version) &&
    /^[0-9a-f]{40}$/.test(commitSha) &&
    plan?.target === TARGET_TRIPLE &&
    plan?.signed === false;
  const isPublic =
    commonValid &&
    plan?.distributionProfile === PUBLIC_UNSIGNED_ALPHA_PROFILE &&
    plan?.publishable === true &&
    plan?.channel === RELEASE_CHANNEL &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) &&
    tag === `${RELEASE_TAG_PREFIX}${version}` &&
    plan?.assetBaseUrl ===
      `https://github.com/${repository}/releases/download/${tag}`;
  const isLocal =
    commonValid &&
    plan?.distributionProfile === LOCAL_NONPUBLISHABLE_PROFILE &&
    plan?.publishable === false &&
    plan?.channel === LOCAL_NONPUBLISHABLE_PROFILE &&
    repository === 'local/nonpublishable' &&
    tag === `cert-prep-local-v${version}-${commitSha.slice(0, 12)}` &&
    isSafeLocalAssetBaseUrl(plan?.assetBaseUrl);
  if (!isPublic && !isLocal) {
    throw new Error(
      'Release plan must declare an exact supported distribution profile.',
    );
  }
  return plan;
}

function isSafeLocalAssetBaseUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return false;
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === 'file:' &&
      !url.hostname &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function assertPublishableReleasePlan(plan) {
  assertSupportedDistributionPlan(plan);
  if (
    plan.distributionProfile !== PUBLIC_UNSIGNED_ALPHA_PROFILE ||
    plan.publishable !== true
  ) {
    throw new Error(
      'Local nonpublishable candidates cannot be finalized or published.',
    );
  }
  return plan;
}

export function assertCandidateMatchesPlan(candidate, plan) {
  for (const field of [
    'version',
    'tag',
    'repository',
    'commitSha',
    'distributionProfile',
    'publishable',
  ]) {
    if (candidate?.[field] !== plan?.[field]) {
      throw new Error(
        `Candidate identity does not match release plan: ${field}.`,
      );
    }
  }
}

const UNKNOWN_LICENSES = new Set([
  '',
  'unknown',
  'unlicensed',
  'noassertion',
  'none',
  'n/a',
]);

const LICENSE_ALIASES = new Map([
  ['apache 2.0', 'Apache-2.0'],
  ['apache license 2.0', 'Apache-2.0'],
  ['apache license v2.0', 'Apache-2.0'],
  ['apache software license', 'Apache-2.0'],
  ['bsd', 'BSD-3-Clause'],
  ['3-clause bsd license', 'BSD-3-Clause'],
  ['bsd 3-clause', 'BSD-3-Clause'],
  ['bsd license', 'BSD-3-Clause'],
  ['bsd-3-clause license', 'BSD-3-Clause'],
  ['isc license', 'ISC'],
  ['mit license', 'MIT'],
  ['mozilla public license 2.0 (mpl 2.0)', 'MPL-2.0'],
  ['python software foundation license', 'Python-2.0'],
  ['mit/apache-2.0', 'MIT OR Apache-2.0'],
  ['apache-2.0/mit', 'Apache-2.0 OR MIT'],
  ['apache-2.0 / mit', 'Apache-2.0 OR MIT'],
  ['bsd-3-clause/mit', 'BSD-3-Clause OR MIT'],
  ['unlicense/mit', 'Unlicense OR MIT'],
  [
    'bsd-3-clause, apache-2.0, dependency licenses',
    'BSD-3-Clause AND Apache-2.0 AND CC-BY-4.0',
  ],
  [
    'gplv2-or-later with a special exception which allows to use pyinstaller to build and distribute non-free programs (including commercial ones)',
    'GPL-2.0-or-later WITH Bootloader-exception',
  ],
]);

// Public Alpha redistribution is fail-closed: a syntactically valid SPDX
// expression is not sufficient unless every license and exception has been
// reviewed for this release channel. Keep this list intentionally narrower
// than the SPDX catalog and expand it only with an explicit licensing review.
const APPROVED_LICENSE_IDS = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'LGPL-2.1-or-later',
  'LGPL-3.0-or-later',
  'MIT',
  'MIT-0',
  'MIT-CMU',
  'MPL-2.0',
  'PSF-2.0',
  'Python-2.0',
  'TCL',
  'Unicode-3.0',
  'Unlicense',
  'Zlib',
]);
const APPROVED_LICENSE_EXCEPTION_PAIRS = new Set([
  'Apache-2.0 WITH LLVM-exception',
  'GPL-2.0-or-later WITH Bootloader-exception',
]);

const PRIMARY_LICENSE_FILE = /^(?:licen[cs]e|copying)(?:[._-].*)?$/i;
const SUPPLEMENTAL_LICENSE_FILE = /^(?:notice|copyright)(?:[._-].*)?$/i;
const MAX_LICENSE_TEXT_BYTES = 1_000_000;
const RELEASE_TOOL_ROOT = dirname(fileURLToPath(import.meta.url));

export function deriveReleaseIdentity({
  eventName,
  refName,
  requestedVersion,
  repository,
  commitSha,
}) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository ?? '')) {
    throw new Error('repository must be the GitHub OWNER/REPO identifier.');
  }
  if (!/^[0-9a-f]{40}$/i.test(commitSha ?? '')) {
    throw new Error(
      'commit SHA must contain exactly 40 hexadecimal characters.',
    );
  }

  let version = requestedVersion?.trim();
  if (!version && eventName === 'push') {
    if (!refName?.startsWith(RELEASE_TAG_PREFIX)) {
      throw new Error(`tag releases must start with ${RELEASE_TAG_PREFIX}.`);
    }
    version = refName.slice(RELEASE_TAG_PREFIX.length);
  }
  if (!ALPHA_VERSION_PATTERN.test(version ?? '')) {
    throw new Error('version must match MAJOR.MINOR.PATCH-alpha.NUMBER.');
  }
  const tag = `${RELEASE_TAG_PREFIX}${version}`;
  if (eventName === 'push' && refName !== tag) {
    throw new Error(
      `tag ${refName} does not match release version ${version}.`,
    );
  }
  if (!['push', 'workflow_dispatch'].includes(eventName)) {
    throw new Error(
      'alpha releases only support tag push or workflow_dispatch.',
    );
  }

  return {
    schemaVersion: 1,
    channel: RELEASE_CHANNEL,
    distributionProfile: PUBLIC_UNSIGNED_ALPHA_PROFILE,
    publishable: true,
    version,
    tag,
    repository,
    commitSha: commitSha.toLowerCase(),
    target: TARGET_TRIPLE,
    windowsMsiVersion: windowsMsiVersionFor(version),
    pythonRuntimeVersion: RELEASE_PYTHON_VERSION,
    assetBaseUrl: `https://github.com/${repository}/releases/download/${tag}`,
    signed: false,
    smartScreenWarning:
      'This public alpha is unsigned and Windows SmartScreen is expected to warn before installation.',
  };
}

export function assertReleaseInvocationContext({
  eventName,
  ref,
  refName,
  defaultBranch,
  repository,
  expectedRepository,
  tag,
}) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(expectedRepository ?? '')) {
    throw new Error(
      'ALPHA_EXPECTED_REPOSITORY must be the pinned GitHub OWNER/REPO identifier.',
    );
  }
  if (repository !== expectedRepository) {
    throw new Error(
      `GitHub repository ${repository} does not match pinned release repository ${expectedRepository}.`,
    );
  }
  if (
    typeof defaultBranch !== 'string' ||
    defaultBranch.trim() === '' ||
    defaultBranch !== defaultBranch.trim() ||
    defaultBranch.startsWith('refs/') ||
    /\s/.test(defaultBranch)
  ) {
    throw new Error('GitHub default branch is missing or invalid.');
  }

  if (eventName === 'workflow_dispatch') {
    if (ref !== `refs/heads/${defaultBranch}` || refName !== defaultBranch) {
      throw new Error(
        `Manual alpha release must run from default branch ${defaultBranch}.`,
      );
    }
    return;
  }
  if (eventName === 'push') {
    if (ref !== `refs/tags/${tag}` || refName !== tag) {
      throw new Error(
        `Tag alpha release must run from canonical ref refs/tags/${tag}.`,
      );
    }
    return;
  }
  throw new Error('alpha releases only support tag push or workflow_dispatch.');
}

export function assertWorkspaceVersions(workspaceRoot, expectedVersion) {
  const tauriConfig = readJson(
    join(workspaceRoot, 'apps/cert-prep-desktop/src-tauri/tauri.conf.json'),
  );
  const cargoToml = readFileSync(
    join(workspaceRoot, 'apps/cert-prep-desktop/src-tauri/Cargo.toml'),
    'utf8',
  );
  const cargoVersion = packageVersionFromToml(cargoToml);
  const pythonProjects = [
    ['backendProjectVersion', 'apps/cert-prep-backend/pyproject.toml'],
    ['contractsProjectVersion', 'packages/cert-prep-contracts/pyproject.toml'],
    ['ocrProjectVersion', 'packages/cert-prep-ocr-windowsml/pyproject.toml'],
    ['ollamaProjectVersion', 'packages/cert-prep-ollama/pyproject.toml'],
  ];
  const pythonVersions = Object.fromEntries(
    pythonProjects.map(([name, path]) => [
      name,
      projectVersionFromPyproject(
        readFileSync(join(workspaceRoot, path), 'utf8'),
      ),
    ]),
  );
  const backendRuntimeVersion = readFileSync(
    join(
      workspaceRoot,
      'apps/cert-prep-backend/src/cert_prep_backend/__init__.py',
    ),
    'utf8',
  ).match(/^__version__\s*=\s*["']([^"']+)["']/m)?.[1];
  const pythonRuntimeVersion = readFileSync(
    join(workspaceRoot, '.python-version'),
    'utf8',
  ).trim();
  const packageQaConstants = readFileSync(
    join(
      workspaceRoot,
      'apps/cert-prep-desktop/scripts/package-qa/constants.mts',
    ),
    'utf8',
  );
  const packageQaAlphaVersion = packageQaConstants.match(
    /^export const ALPHA_VERSION = ['"]([^'"]+)['"];$/m,
  )?.[1];
  const packageQaWindowsMsiVersion = packageQaConstants.match(
    /^export const WINDOWS_MSI_VERSION = ['"]([^'"]+)['"];$/m,
  )?.[1];
  const packageQaPythonRuntimeVersion = packageQaConstants.match(
    /^export const PYTHON_RUNTIME_VERSION = ['"]([^'"]+)['"];$/m,
  )?.[1];
  const backendProject = readJson(
    join(workspaceRoot, 'apps/cert-prep-backend/project.json'),
  );
  const windowsMsiVersion = tauriConfig.bundle?.windows?.wix?.version;
  const expectedWindowsMsiVersion = windowsMsiVersionFor(expectedVersion);
  if (tauriConfig.version !== expectedVersion) {
    throw new Error(
      `Tauri version ${tauriConfig.version ?? '<missing>'} does not match ${expectedVersion}.`,
    );
  }
  if (cargoVersion !== expectedVersion) {
    throw new Error(
      `Cargo package version ${cargoVersion ?? '<missing>'} does not match ${expectedVersion}.`,
    );
  }
  for (const [name, version] of Object.entries({
    ...pythonVersions,
    backendRuntimeVersion,
  })) {
    if (version !== expectedVersion) {
      throw new Error(
        `${name} ${version ?? '<missing>'} does not match ${expectedVersion}.`,
      );
    }
  }
  if (pythonRuntimeVersion !== RELEASE_PYTHON_VERSION) {
    throw new Error(
      `Python runtime version ${pythonRuntimeVersion || '<missing>'} does not match ${RELEASE_PYTHON_VERSION}.`,
    );
  }
  if (windowsMsiVersion !== expectedWindowsMsiVersion) {
    throw new Error(
      `Windows MSI version ${windowsMsiVersion ?? '<missing>'} does not match ${expectedWindowsMsiVersion}.`,
    );
  }
  if (
    packageQaAlphaVersion !== expectedVersion ||
    packageQaWindowsMsiVersion !== expectedWindowsMsiVersion ||
    packageQaPythonRuntimeVersion !== RELEASE_PYTHON_VERSION
  ) {
    throw new Error(
      'Package QA version constants do not match the release identity.',
    );
  }
  for (const targetName of [
    'build-backend-runtime',
    'build-ocr-runtime-windowsml',
  ]) {
    const command =
      backendProject.targets?.[targetName]?.options?.command ?? '';
    if (
      !command.includes(`--python ${RELEASE_PYTHON_VERSION}`) ||
      !command.includes(`--version ${expectedVersion}`) ||
      !command.includes(`--target ${TARGET_TRIPLE}`)
    ) {
      throw new Error(
        `${targetName} does not pin the release Python, version, and target contract.`,
      );
    }
  }
  return {
    tauriVersion: tauriConfig.version,
    cargoVersion,
    windowsMsiVersion,
    ...pythonVersions,
    backendRuntimeVersion,
    pythonRuntimeVersion,
    packageQaAlphaVersion,
    packageQaWindowsMsiVersion,
    packageQaPythonRuntimeVersion,
  };
}

export function windowsMsiVersionFor(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)-alpha\.(\d+)$/);
  if (!match) {
    throw new Error('Windows MSI mapping requires an alpha release version.');
  }
  const values = match.slice(1).map(Number);
  if (
    values[0] > 255 ||
    values[1] > 255 ||
    values[2] > 65_535 ||
    values[3] > 65_535
  ) {
    throw new Error('Windows MSI mapped version exceeds MSI field limits.');
  }
  return values.join('.');
}

export function assertExternalConfirmations(confirmations) {
  const missing = Object.entries(confirmations)
    .filter(([, value]) => String(value).toLowerCase() !== 'true')
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `Alpha release prerequisite confirmations are missing: ${missing.join(', ')}.`,
    );
  }
}

export function packageVersionFromToml(content) {
  const packageBlock = content.match(/\[package\]([\s\S]*?)(?:\n\[|$)/)?.[1];
  return packageBlock?.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? null;
}

export function projectVersionFromPyproject(content) {
  const projectBlock = content.match(/\[project\]([\s\S]*?)(?:\n\[|$)/)?.[1];
  return projectBlock?.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? null;
}

export function normalizeLicense(rawLicense) {
  const original = String(rawLicense ?? '').trim();
  const alias = LICENSE_ALIASES.get(original.toLowerCase());
  const trimmed = alias ?? original;
  if (UNKNOWN_LICENSES.has(trimmed.toLowerCase())) return null;
  if (/\b(?:proprietary|custom|commercial)\b/i.test(trimmed)) return null;
  if (/^see license in /i.test(trimmed) || /^licenseref-/i.test(trimmed))
    return null;
  if (trimmed.length > 160 || /[\r\n]/.test(trimmed)) return null;
  if (!/^[A-Za-z0-9.+()\-\s]+$/.test(trimmed)) return null;
  const expression = parseLicenseExpression(trimmed);
  if (!expression || !isApprovedLicenseExpression(expression)) return null;
  return trimmed;
}

function parseLicenseExpression(expression) {
  const tokens = [];
  let offset = 0;
  while (offset < expression.length) {
    const whitespace = expression.slice(offset).match(/^\s+/)?.[0];
    if (whitespace) {
      offset += whitespace.length;
      continue;
    }
    const character = expression[offset];
    if (character === '(' || character === ')') {
      tokens.push(character);
      offset += 1;
      continue;
    }
    const identifier = expression
      .slice(offset)
      .match(/^[A-Za-z0-9][A-Za-z0-9.+-]*/)?.[0];
    if (!identifier) return null;
    tokens.push(identifier);
    offset += identifier.length;
  }

  let position = 0;
  const peek = () => tokens[position];
  const consume = () => tokens[position++];
  const parsePrimary = () => {
    if (peek() === '(') {
      consume();
      const node = parseOr();
      if (!node || consume() !== ')') return null;
      return { kind: 'group', expression: node };
    }
    const identifier = consume();
    if (!identifier || [')', 'AND', 'OR', 'WITH'].includes(identifier)) {
      return null;
    }
    return { kind: 'license', id: identifier };
  };
  const parseWith = () => {
    const license = parsePrimary();
    if (!license) return null;
    if (peek() !== 'WITH') return license;
    consume();
    const exception = consume();
    if (
      license.kind !== 'license' ||
      !exception ||
      [')', 'AND', 'OR', 'WITH', '('].includes(exception)
    ) {
      return null;
    }
    return { kind: 'with', license: license.id, exception };
  };
  const parseAnd = () => {
    let left = parseWith();
    if (!left) return null;
    while (peek() === 'AND') {
      consume();
      const right = parseWith();
      if (!right) return null;
      left = { kind: 'and', left, right };
    }
    return left;
  };
  function parseOr() {
    let left = parseAnd();
    if (!left) return null;
    while (peek() === 'OR') {
      consume();
      const right = parseAnd();
      if (!right) return null;
      left = { kind: 'or', left, right };
    }
    return left;
  }

  const parsed = parseOr();
  return parsed && position === tokens.length ? parsed : null;
}

function isApprovedLicenseExpression(node) {
  if (node.kind === 'license') {
    return APPROVED_LICENSE_IDS.has(node.id);
  }
  if (node.kind === 'with') {
    return APPROVED_LICENSE_EXCEPTION_PAIRS.has(
      `${node.license} WITH ${node.exception}`,
    );
  }
  if (node.kind === 'group') {
    return isApprovedLicenseExpression(node.expression);
  }
  if (node.kind === 'and' || node.kind === 'or') {
    return (
      isApprovedLicenseExpression(node.left) &&
      isApprovedLicenseExpression(node.right)
    );
  }
  return false;
}

export function collectLicensedComponents({
  nodeLicenses,
  pythonLicenses,
  cargoMetadata,
  genericComponents,
}) {
  const components = [];
  for (const [groupLicense, packages] of Object.entries(nodeLicenses ?? {})) {
    for (const item of packages ?? []) {
      for (const version of item.versions ?? []) {
        components.push({
          ecosystem: 'npm',
          name: item.name,
          version,
          license: item.license ?? groupLicense,
          purl: `pkg:npm/${encodePurlName(item.name)}@${encodeURIComponent(version)}`,
          licenseTexts: collectPackageLicenseTexts(
            packageRootsForVersion(item, version),
          ),
        });
      }
    }
  }
  for (const item of pythonLicenses ?? []) {
    components.push({
      ecosystem: 'pypi',
      name: item.name,
      version: item.version,
      license: item.license,
      purl: `pkg:pypi/${encodeURIComponent(item.name)}@${encodeURIComponent(item.version)}`,
      licenseTexts: normalizeCollectedLicenseTexts(item.licenseTexts),
    });
  }
  for (const item of cargoMetadata?.packages ?? []) {
    const packageRoot = item.manifest_path ? dirname(item.manifest_path) : null;
    components.push({
      ecosystem: 'cargo',
      name: item.name,
      version: item.version,
      license: item.source ? item.license : item.license || 'MIT',
      purl: `pkg:cargo/${encodeURIComponent(item.name)}@${encodeURIComponent(item.version)}`,
      licenseTexts: collectPackageLicenseTexts(
        packageRoot ? [packageRoot] : [],
        item.license_file ? [item.license_file] : [],
      ),
    });
  }
  for (const item of genericComponents ?? []) {
    components.push({
      ...item,
      ecosystem: 'generic',
      licenseTexts: normalizeCollectedLicenseTexts(item.licenseTexts),
    });
  }

  const unique = new Map();
  for (const component of components) {
    const key = `${component.ecosystem}:${component.name}@${component.version}`;
    const license = normalizeLicense(component.license);
    if (!component.name || !component.version || !component.purl || !license) {
      throw new Error(
        `Release dependency has missing or unsupported license metadata: ${key} (${component.license ?? 'missing'}).`,
      );
    }
    const existing = unique.get(key);
    if (existing && existing.license !== license) {
      throw new Error(`Conflicting licenses found for ${key}.`);
    }
    unique.set(key, { ...component, license });
  }
  return [...unique.values()].sort((left, right) =>
    `${left.ecosystem}:${left.name}@${left.version}`.localeCompare(
      `${right.ecosystem}:${right.name}@${right.version}`,
    ),
  );
}

function packageRootsForVersion(item, version) {
  const paths = [...new Set(item.paths ?? [])];
  const exact = paths.filter((path) => {
    try {
      return readJson(join(path, 'package.json')).version === version;
    } catch {
      return false;
    }
  });
  if (exact.length > 0) return exact;
  return (item.versions ?? []).length === 1 ? paths : [];
}

function collectPackageLicenseTexts(roots, explicitLicenseFiles = []) {
  const candidates = [];
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    for (const explicit of explicitLicenseFiles) {
      const path = resolve(root, explicit);
      if (existsSync(path) && statSync(path).isFile()) {
        candidates.push({ path, name: basename(path), primary: true });
      }
    }
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (
        entry.isFile() &&
        (PRIMARY_LICENSE_FILE.test(entry.name) ||
          SUPPLEMENTAL_LICENSE_FILE.test(entry.name))
      ) {
        candidates.push({
          path,
          name: entry.name,
          primary: PRIMARY_LICENSE_FILE.test(entry.name),
        });
      } else if (
        entry.isDirectory() &&
        /^(?:licenses?|notices?)$/i.test(entry.name)
      ) {
        for (const nested of listFiles(path)) {
          candidates.push({
            path: nested,
            name: `${entry.name}/${relativePosix(path, nested)}`,
            primary: !SUPPLEMENTAL_LICENSE_FILE.test(basename(nested)),
          });
        }
      }
    }
  }

  const texts = [];
  const seen = new Set();
  for (const candidate of candidates) {
    try {
      const bytes = statSync(candidate.path).size;
      if (bytes <= 0 || bytes > MAX_LICENSE_TEXT_BYTES) continue;
      const text = readFileSync(candidate.path, 'utf8').trim();
      if (!text) continue;
      const sha256 = createHash('sha256').update(text).digest('hex');
      if (seen.has(sha256)) continue;
      seen.add(sha256);
      texts.push({
        name: candidate.name,
        text: `${text}\n`,
        primary: candidate.primary,
      });
    } catch {
      // Missing or unreadable files are handled by the fail-closed corpus gate.
    }
  }
  return texts;
}

function normalizeCollectedLicenseTexts(texts) {
  const output = [];
  const seen = new Set();
  for (const item of texts ?? []) {
    const text = String(item?.text ?? '').trim();
    const name = String(item?.name ?? '').trim();
    const bytes = Buffer.byteLength(text, 'utf8');
    if (!name || !text || bytes > MAX_LICENSE_TEXT_BYTES) continue;
    const sha256 = createHash('sha256').update(text).digest('hex');
    if (seen.has(sha256)) continue;
    seen.add(sha256);
    output.push({
      name,
      text: `${text}\n`,
      primary:
        item.primary === true || PRIMARY_LICENSE_FILE.test(basename(name)),
    });
  }
  return output;
}

function licenseTerms(expression) {
  return [
    ...new Set(
      expression
        .replaceAll('(', ' ')
        .replaceAll(')', ' ')
        .split(/\s+/)
        .filter((token) => token && !['AND', 'OR', 'WITH'].includes(token)),
    ),
  ];
}

async function materializeOrValidateLicenseTexts(releaseRoot, components) {
  const hasCollectedTexts = components.some((component) =>
    Object.hasOwn(component, 'licenseTexts'),
  );
  if (!hasCollectedTexts) {
    for (const component of components) {
      await validateLicenseTextRefs(releaseRoot, component);
    }
    return components;
  }

  const records = [];
  const fallbackByTerm = new Map();
  for (const canonical of loadCanonicalLicenseTexts()) {
    const destination = join(
      releaseRoot,
      'legal',
      'licenses',
      'texts',
      `${canonical.sha256}.txt`,
    );
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, canonical.text, 'utf8');
    const ref = {
      path: relativePosix(releaseRoot, destination),
      sha256: canonical.sha256,
      source: canonical.source,
    };
    for (const term of licenseTerms(canonical.license)) {
      fallbackByTerm.set(term, [ref]);
    }
  }
  for (const component of components) {
    const texts = normalizeCollectedLicenseTexts(component.licenseTexts);
    const primaryTexts = texts.filter((item) => item.primary);
    const refs = [];
    if (primaryTexts.length > 0) {
      for (const item of texts) {
        const sha256 = createHash('sha256').update(item.text).digest('hex');
        const destination = join(
          releaseRoot,
          'legal',
          'licenses',
          'texts',
          `${sha256}.txt`,
        );
        if (!existsSync(destination)) {
          mkdirSync(dirname(destination), { recursive: true });
          writeFileSync(destination, item.text, 'utf8');
        }
        refs.push({
          path: relativePosix(releaseRoot, destination),
          sha256,
        });
      }
      for (const term of licenseTerms(component.license)) {
        if (!fallbackByTerm.has(term)) fallbackByTerm.set(term, refs);
      }
    }
    records.push({ component, refs });
  }

  const publicComponents = [];
  for (const { component, refs: directRefs } of records) {
    let refs = directRefs;
    if (refs.length === 0) {
      refs = [];
      for (const term of licenseTerms(component.license)) {
        const fallback = fallbackByTerm.get(term);
        if (!fallback?.length) {
          throw new Error(
            `Release dependency is missing required license text: ${component.ecosystem}:${component.name}@${component.version} (${term}).`,
          );
        }
        refs.push(...fallback);
      }
    }
    const uniqueRefs = [
      ...new Map(refs.map((item) => [item.sha256, item])).values(),
    ];
    const { licenseTexts: _licenseTexts, ...publicComponent } = component;
    publicComponents.push({ ...publicComponent, licenseTextRefs: uniqueRefs });
  }
  return publicComponents;
}

function loadCanonicalLicenseTexts() {
  const root = join(RELEASE_TOOL_ROOT, 'license-texts');
  const manifest = readJson(join(root, 'manifest.json'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.texts)) {
    throw new Error('Canonical license text manifest is invalid.');
  }
  return manifest.texts.map((item) => {
    const license = normalizeLicense(item.license);
    const path = resolve(root, String(item.file ?? ''));
    if (
      !license ||
      !path.startsWith(`${resolve(root)}${sep}`) ||
      !/^https:\/\/raw\.githubusercontent\.com\/spdx\/license-list-data\/v\d+\.\d+\.\d+\//.test(
        item.source ?? '',
      ) ||
      !/^[0-9a-f]{64}$/i.test(item.sha256 ?? '') ||
      !existsSync(path) ||
      !statSync(path).isFile()
    ) {
      throw new Error(
        `Canonical license text entry is invalid: ${item.license}.`,
      );
    }
    const text = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
    const sha256 = createHash('sha256').update(text).digest('hex');
    if (sha256 !== item.sha256.toLowerCase()) {
      throw new Error(
        `Canonical license text digest is invalid: ${item.license}.`,
      );
    }
    return { license, text, sha256, source: item.source };
  });
}

async function validateLicenseTextRefs(releaseRoot, component) {
  if (
    !Array.isArray(component.licenseTextRefs) ||
    component.licenseTextRefs.length === 0
  ) {
    throw new Error(
      `Release dependency is missing required license text references: ${component.ecosystem}:${component.name}@${component.version}.`,
    );
  }
  const licenseRoot = resolve(releaseRoot, 'legal', 'licenses', 'texts');
  for (const ref of component.licenseTextRefs) {
    const path = resolve(releaseRoot, String(ref.path ?? ''));
    if (
      !path.startsWith(`${licenseRoot}${sep}`) ||
      !/^[0-9a-f]{64}$/i.test(ref.sha256 ?? '') ||
      !existsSync(path) ||
      !statSync(path).isFile() ||
      (await sha256File(path)) !== ref.sha256.toLowerCase()
    ) {
      throw new Error(
        `Release dependency has an invalid license text reference: ${component.ecosystem}:${component.name}@${component.version}.`,
      );
    }
  }
}

export async function writeReleaseDocuments({
  releaseRoot,
  plan,
  components,
  artifactDependencies,
  evidence = {},
}) {
  const metadataDir = join(releaseRoot, 'metadata');
  mkdirSync(metadataDir, { recursive: true });
  const licensedComponents = await materializeOrValidateLicenseTexts(
    releaseRoot,
    components,
  );
  const publishableFiles = listFiles(releaseRoot).filter(
    (path) => !isGeneratedReleaseDocument(releaseRoot, path),
  );
  rejectForbiddenReleaseFiles(publishableFiles);
  const artifacts = [];
  for (const path of publishableFiles) {
    artifacts.push({
      path: relativePosix(releaseRoot, path),
      fileName: basename(path),
      bytes: statSync(path).size,
      sha256: await sha256File(path),
    });
  }
  artifacts.sort((left, right) => left.path.localeCompare(right.path));
  const dependencyScopes = validateArtifactDependencies(
    artifactDependencies,
    artifacts,
    licensedComponents,
  );

  const licenseInventory = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    release: {
      version: plan.version,
      tag: plan.tag,
      commitSha: plan.commitSha,
    },
    failClosed: true,
    components: licensedComponents,
    artifactDependencies: dependencyScopes,
  };
  const licenseInventoryPath = join(metadataDir, 'license-inventory.json');
  const spdxPath = join(metadataDir, 'cert-prep-alpha.spdx.json');
  const cycloneDxPath = join(metadataDir, 'cert-prep-alpha.cdx.json');
  const generatedDocumentPaths = [
    licenseInventoryPath,
    spdxPath,
    cycloneDxPath,
  ];
  writeJson(licenseInventoryPath, licenseInventory);
  writeJson(spdxPath, createSpdxDocument(plan, licensedComponents, artifacts));
  writeJson(
    cycloneDxPath,
    createCycloneDxDocument(plan, licensedComponents, artifacts),
  );
  const componentByPurl = new Map(
    licensedComponents.map((component) => [component.purl, component]),
  );
  const artifactByPath = new Map(
    artifacts.map((artifact) => [artifact.path, artifact]),
  );
  for (const scope of dependencyScopes) {
    const scopedComponents = scope.componentPurls.map((purl) =>
      componentByPurl.get(purl),
    );
    const scopedArtifacts = [artifactByPath.get(scope.artifactPath)];
    const scopedSpdxPath = join(
      metadataDir,
      `cert-prep-alpha-${scope.id}.spdx.json`,
    );
    const scopedCycloneDxPath = join(
      metadataDir,
      `cert-prep-alpha-${scope.id}.cdx.json`,
    );
    writeJson(
      scopedSpdxPath,
      createSpdxDocument(plan, scopedComponents, scopedArtifacts, {
        artifactDependencyLinks: true,
        documentName: `cert-prep-${plan.version}-${scope.id}`,
      }),
    );
    writeJson(
      scopedCycloneDxPath,
      createCycloneDxDocument(plan, scopedComponents, scopedArtifacts, {
        artifactDependencyLinks: true,
        documentName: scope.id,
      }),
    );
    generatedDocumentPaths.push(scopedSpdxPath, scopedCycloneDxPath);
  }
  for (const path of generatedDocumentPaths) {
    artifacts.push({
      path: relativePosix(releaseRoot, path),
      fileName: basename(path),
      bytes: statSync(path).size,
      sha256: await sha256File(path),
    });
  }
  artifacts.sort((left, right) => left.path.localeCompare(right.path));
  writeJson(join(metadataDir, 'release-metadata.json'), {
    ...plan,
    generatedAt: new Date().toISOString(),
    evidence,
    artifacts,
  });

  const checksumTargets = listFiles(releaseRoot).filter(
    (path) => basename(path) !== 'SHA256SUMS',
  );
  const checksumLines = [];
  for (const path of checksumTargets.sort()) {
    checksumLines.push(`${await sha256File(path)} *${basename(path)}`);
  }
  writeFileSync(
    join(releaseRoot, 'SHA256SUMS'),
    `${checksumLines.join('\n')}\n`,
    'utf8',
  );
  return { artifacts, checksumLines };
}

function validateArtifactDependencies(
  artifactDependencies,
  artifacts,
  components,
) {
  if (artifactDependencies === undefined) return [];
  if (!Array.isArray(artifactDependencies)) {
    throw new Error('Artifact dependency mapping must be an array.');
  }
  const requiredIds = new Set([
    'msi',
    'nsis',
    'backend-runtime',
    'windowsml-ocr-runtime',
  ]);
  const artifactPatterns = new Map([
    ['msi', /^installers\/.*\.msi$/i],
    ['nsis', /^installers\/.*setup\.exe$/i],
    ['backend-runtime', /^runtimes\/cert-prep-backend-runtime-.*\.zip$/i],
    [
      'windowsml-ocr-runtime',
      /^runtimes\/cert-prep-ocr-windowsml-runtime-.*\.zip$/i,
    ],
  ]);
  const artifactPaths = new Set(artifacts.map((artifact) => artifact.path));
  const componentPurls = new Set(components.map((component) => component.purl));
  const ids = new Set();
  const mappedArtifactPaths = new Set();
  const normalized = artifactDependencies.map((scope) => {
    const id = String(scope?.id ?? '');
    const artifactPath = String(scope?.artifactPath ?? '');
    const purls = [...new Set(scope?.componentPurls ?? [])].sort();
    if (!requiredIds.has(id) || ids.has(id)) {
      throw new Error(`Artifact dependency mapping has an invalid ID: ${id}.`);
    }
    ids.add(id);
    if (!artifactPaths.has(artifactPath)) {
      throw new Error(
        `Artifact dependency mapping references a missing artifact: ${artifactPath}.`,
      );
    }
    if (
      mappedArtifactPaths.has(artifactPath) ||
      !artifactPatterns.get(id).test(artifactPath)
    ) {
      throw new Error(
        `Artifact dependency mapping references the wrong artifact type: ${id}.`,
      );
    }
    mappedArtifactPaths.add(artifactPath);
    if (purls.length === 0 || purls.some((purl) => !componentPurls.has(purl))) {
      throw new Error(
        `Artifact dependency mapping has missing or unknown components: ${id}.`,
      );
    }
    return { id, artifactPath, componentPurls: purls };
  });
  if (
    normalized.length !== requiredIds.size ||
    [...requiredIds].some((id) => !ids.has(id))
  ) {
    throw new Error(
      'Artifact dependency mapping must cover MSI, NSIS, backend, and OCR artifacts.',
    );
  }
  return normalized.sort((left, right) => left.id.localeCompare(right.id));
}

export function createSpdxDocument(
  plan,
  components,
  artifacts,
  { artifactDependencyLinks = false, documentName } = {},
) {
  const packages = components.map((component, index) => ({
    SPDXID: `SPDXRef-Package-${index + 1}`,
    name: component.name,
    versionInfo: component.version,
    downloadLocation: component.purl,
    filesAnalyzed: false,
    licenseConcluded: component.license,
    licenseDeclared: component.license,
    copyrightText: 'Copyright retained by the respective package authors.',
    externalRefs: [
      {
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: component.purl,
      },
    ],
  }));
  const artifactFiles = artifacts.map((artifact, index) => ({
    SPDXID: `SPDXRef-Artifact-${index + 1}`,
    fileName: artifact.path,
    checksums: [{ algorithm: 'SHA256', checksumValue: artifact.sha256 }],
    licenseConcluded: 'NOASSERTION',
    copyrightText: 'Copyright (c) Cert Prep contributors.',
  }));
  const payloadFiles = components.flatMap((component, componentIndex) =>
    (component.files ?? []).map((file, fileIndex) => ({
      SPDXID: `SPDXRef-Payload-${componentIndex + 1}-${fileIndex + 1}`,
      fileName: `${component.name}/${file.path}`,
      checksums: [{ algorithm: 'SHA256', checksumValue: file.sha256 }],
      licenseConcluded: component.license,
      copyrightText: 'Copyright retained by the upstream payload authors.',
    })),
  );
  const payloadRelationships = components.flatMap((component, componentIndex) =>
    (component.files ?? []).map((_file, fileIndex) => ({
      spdxElementId: `SPDXRef-Package-${componentIndex + 1}`,
      relationshipType: 'CONTAINS',
      relatedSpdxElement: `SPDXRef-Payload-${componentIndex + 1}-${fileIndex + 1}`,
    })),
  );
  const files = [...artifactFiles, ...payloadFiles];
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: documentName ?? `cert-prep-${plan.version}`,
    documentNamespace:
      plan?.publishable === false
        ? `https://local.invalid/cert-prep/${plan.tag}/spdx/${randomUUID()}`
        : `https://github.com/${plan.repository}/releases/${plan.tag}/spdx/${randomUUID()}`,
    creationInfo: {
      created: new Date().toISOString(),
      creators: ['Tool: cert-prep-release-tools/1'],
    },
    packages,
    files,
    relationships: [
      ...packages.map((item) => ({
        spdxElementId: 'SPDXRef-DOCUMENT',
        relationshipType: 'DESCRIBES',
        relatedSpdxElement: item.SPDXID,
      })),
      ...files.map((item) => ({
        spdxElementId: 'SPDXRef-DOCUMENT',
        relationshipType: 'DESCRIBES',
        relatedSpdxElement: item.SPDXID,
      })),
      ...payloadRelationships,
      ...(artifactDependencyLinks
        ? artifactFiles.flatMap((file) =>
            packages.map((dependency) => ({
              spdxElementId: file.SPDXID,
              relationshipType: 'DEPENDS_ON',
              relatedSpdxElement: dependency.SPDXID,
            })),
          )
        : []),
    ],
  };
}

export function createCycloneDxDocument(
  plan,
  components,
  artifacts,
  { artifactDependencyLinks = false, documentName } = {},
) {
  const artifactComponents = artifacts.map((artifact) => ({
    type: 'file',
    'bom-ref': `urn:cert-prep:artifact:${artifact.sha256}`,
    name: artifact.path,
    hashes: [{ alg: 'SHA-256', content: artifact.sha256 }],
  }));
  const libraryComponents = components.map((component) => ({
    type: 'library',
    'bom-ref': component.purl,
    group: component.ecosystem,
    name: component.name,
    version: component.version,
    purl: component.purl,
    licenses: [{ expression: component.license }],
  }));
  const payloadComponents = components.flatMap((component) =>
    (component.files ?? []).map((file) => ({
      type: 'file',
      'bom-ref': `${component.purl}#file:${encodeURIComponent(file.path)}`,
      group: component.name,
      name: file.path,
      hashes: [{ alg: 'SHA-256', content: file.sha256 }],
      licenses: [{ expression: component.license }],
      properties: [
        { name: 'cert-prep:payload-bytes', value: String(file.bytes) },
      ],
    })),
  );
  const dependencies = [
    ...(artifactDependencyLinks
      ? artifactComponents.map((artifact) => ({
          ref: artifact['bom-ref'],
          dependsOn: components.map((component) => component.purl),
        }))
      : []),
    ...components
      .filter((component) => (component.files ?? []).length > 0)
      .map((component) => ({
        ref: component.purl,
        dependsOn: component.files.map(
          (file) => `${component.purl}#file:${encodeURIComponent(file.path)}`,
        ),
      })),
  ];
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: {
        type: 'application',
        'bom-ref': `pkg:generic/cert-prep@${encodeURIComponent(plan.version)}`,
        name: documentName ?? 'cert-prep',
        version: plan.version,
        licenses: [{ license: { id: 'MIT' } }],
      },
    },
    components: [
      ...libraryComponents,
      ...payloadComponents,
      ...artifactComponents,
    ],
    ...(dependencies.length > 0 ? { dependencies } : {}),
  };
}

export function validateHardwareResult(result, plan, expectedCandidateId) {
  const requiredChecks = {
    candidateShaVerified: true,
    cleanSnapshot: true,
    windowsMlProvider: 'windowsml',
    configuredProvider: 'ollama',
    effectiveProvider: 'ollama',
    configuredModel: 'qwen3.5:4b',
    effectiveModel: 'qwen3.5:4b',
    providerFallback: false,
    modelFallback: false,
    generationReadyAtStart: true,
    resourcesReleasedAtEnd: true,
    fullExamQuestionCountPositive: true,
    sessionRestartPassed: true,
    processResidueCount: 0,
  };
  if (
    result.schemaVersion !== 1 ||
    result.version !== plan.version ||
    result.tag !== plan.tag ||
    result.commitSha !== plan.commitSha ||
    !/^[0-9a-f]{64}$/i.test(result.harnessSha256 ?? '')
  ) {
    throw new Error('Hardware evidence identity does not match the candidate.');
  }
  if (
    !/^[0-9a-f]{64}$/i.test(result.candidateId ?? '') ||
    (expectedCandidateId && result.candidateId !== expectedCandidateId)
  ) {
    throw new Error(
      'Hardware evidence candidate ID does not match the downloaded candidate.',
    );
  }
  if (!Array.isArray(result.pdfs) || result.pdfs.length !== 4) {
    throw new Error(
      'Hardware evidence must cover exactly four acceptance PDFs.',
    );
  }
  const pdfNames = new Set(
    result.pdfs.map((item) => String(item.name ?? '').trim()),
  );
  if (pdfNames.has('') || pdfNames.size !== result.pdfs.length) {
    throw new Error('Hardware evidence must identify four distinct PDFs.');
  }
  if (
    !result.pdfs.every(
      (item) => item.usableQuestions > 0 && item.fullExamQuestionCount > 0,
    )
  ) {
    throw new Error(
      'Every hardware acceptance PDF must produce usable and Full Exam questions.',
    );
  }
  for (const [key, expected] of Object.entries(requiredChecks)) {
    if (result[key] !== expected) {
      throw new Error(`Hardware evidence check failed: ${key}.`);
    }
  }
  for (const key of HARDWARE_CANCELLATION_CHECKS) {
    const evidence = result.cancellation?.[key];
    if (
      evidence?.passed !== true ||
      typeof evidence.path !== 'string' ||
      !evidence.path.toLowerCase().endsWith('.json') ||
      evidence.bytes <= 0 ||
      !/^[0-9a-f]{64}$/i.test(evidence.sha256 ?? '')
    ) {
      throw new Error(`Hardware cancellation evidence check failed: ${key}.`);
    }
  }
  if (
    result.sessionRestart?.passed !== true ||
    typeof result.sessionRestart.path !== 'string' ||
    !result.sessionRestart.path.toLowerCase().endsWith('.json') ||
    result.sessionRestart.bytes <= 0 ||
    !/^[0-9a-f]{64}$/i.test(result.sessionRestart.sha256 ?? '')
  ) {
    throw new Error(
      'Hardware session restart evidence must be a non-empty hashed JSON artifact.',
    );
  }
  const acceptanceStartedAt = Date.parse(result.acceptance?.startedAt ?? '');
  const acceptanceCompletedAt = Date.parse(
    result.acceptance?.completedAt ?? '',
  );
  const recordingStartedAt = Date.parse(result.recording?.startedAt ?? '');
  const recordingCompletedAt = Date.parse(result.recording?.completedAt ?? '');
  if (
    result.acceptance?.completed !== true ||
    !/^[A-Za-z0-9._-]{8,128}$/.test(result.acceptance?.runId ?? '') ||
    !Number.isFinite(acceptanceStartedAt) ||
    !Number.isFinite(acceptanceCompletedAt) ||
    acceptanceStartedAt >= acceptanceCompletedAt ||
    result.recording?.acceptanceRunId !== result.acceptance.runId ||
    !Number.isFinite(recordingStartedAt) ||
    !Number.isFinite(recordingCompletedAt) ||
    recordingStartedAt > acceptanceStartedAt ||
    recordingCompletedAt < acceptanceCompletedAt
  ) {
    throw new Error(
      'Hardware evidence recording is not bound to the completed acceptance run.',
    );
  }
  if (
    typeof result.recording?.path !== 'string' ||
    !result.recording.path.toLowerCase().endsWith('.webm') ||
    result.recording?.captureSource !== 'playwright_screencast' ||
    !/^[0-9a-f]{64}$/i.test(result.recording?.sha256 ?? '') ||
    result.recording?.bytes <= 0
  ) {
    throw new Error(
      'Hardware evidence must include a non-empty hashed recording.',
    );
  }
  return result;
}

export async function validateHardwareEvidenceFiles(result, evidenceRoot) {
  const resolvedEvidenceRoot = resolve(evidenceRoot);
  const records = [
    ['recording', result.recording],
    ['sessionRestart', result.sessionRestart],
    ...HARDWARE_CANCELLATION_CHECKS.map((key) => [
      key,
      result.cancellation[key],
    ]),
  ];
  const paths = new Set();
  for (const [key, record] of records) {
    const path = resolveEvidencePath(resolvedEvidenceRoot, record.path, key);
    const relativePath = relativePosix(resolvedEvidenceRoot, path);
    if (paths.has(relativePath)) {
      throw new Error(`Hardware evidence path is reused: ${relativePath}.`);
    }
    paths.add(relativePath);
    if (statSync(path).size !== record.bytes) {
      throw new Error(`Hardware evidence byte count does not match: ${key}.`);
    }
    if ((await sha256File(path)) !== record.sha256.toLowerCase()) {
      throw new Error(`Hardware evidence digest does not match: ${key}.`);
    }
    if (key !== 'recording') {
      let detail;
      try {
        detail = readJson(path);
      } catch {
        throw new Error(`Hardware resilience evidence is not JSON: ${key}.`);
      }
      const context = {
        candidate: {
          candidateId: result.candidateId,
          version: result.version,
          tag: result.tag,
          commitSha: result.commitSha,
          harnessSha256: result.harnessSha256,
        },
        acceptanceRunId: result.acceptance.runId,
        acceptanceStartedAt: result.acceptance.startedAt,
        acceptanceCompletedAt: result.acceptance.completedAt,
      };
      if (key === 'sessionRestart') {
        validateSessionRestartEvidence(detail, context);
      } else {
        validateResilienceEvidence(detail, key, context);
      }
    }
  }
  return result;
}

export function validateRecordingProbeContract(probe, result) {
  const recordingDurationSeconds =
    (Date.parse(result.recording.completedAt) -
      Date.parse(result.recording.startedAt)) /
    1000;
  if (
    probe.schemaVersion !== 1 ||
    probe.acceptanceRunId !== result.acceptance.runId ||
    probe.recording?.path !== result.recording.path ||
    probe.recording?.bytes !== result.recording.bytes ||
    probe.recording?.sha256 !== result.recording.sha256.toLowerCase() ||
    !/^[0-9a-f]{64}$/i.test(probe.ffprobe?.sha256 ?? '') ||
    !Array.isArray(probe.formatNames) ||
    !probe.formatNames.some((name) => ['matroska', 'webm'].includes(name)) ||
    !Number.isFinite(probe.durationSeconds) ||
    probe.durationSeconds < 1 ||
    probe.durationSeconds + 2 < recordingDurationSeconds ||
    !['vp8', 'vp9', 'av1'].includes(probe.video?.codec) ||
    !Number.isInteger(probe.video?.width) ||
    probe.video.width <= 0 ||
    !Number.isInteger(probe.video?.height) ||
    probe.video.height <= 0 ||
    !Number.isInteger(probe.video?.frameCount) ||
    probe.video.frameCount <= 0
  ) {
    throw new Error(
      'Hardware recording probe did not prove a playable WebM video.',
    );
  }
  return probe;
}

function resolveEvidencePath(evidenceRoot, relativePath, label) {
  const path = resolve(evidenceRoot, String(relativePath ?? ''));
  const realRoot = realpathSync(evidenceRoot);
  if (
    !path.startsWith(`${evidenceRoot}${sep}`) ||
    !existsSync(path) ||
    !statSync(path).isFile() ||
    lstatSync(path).isSymbolicLink() ||
    !realpathSync(path).startsWith(`${realRoot}${sep}`)
  ) {
    throw new Error(`Hardware evidence path is invalid: ${label}.`);
  }
  return path;
}

export async function validateCandidateFiles(candidateRoot, candidate) {
  const root = resolve(candidateRoot);
  const realRoot = realpathSync(root);
  if (
    candidate.schemaVersion !== 1 ||
    !Array.isArray(candidate.files) ||
    candidate.files.length === 0 ||
    !/^[0-9a-f]{64}$/i.test(candidate.candidateId ?? '')
  ) {
    throw new Error('Candidate identity document is invalid.');
  }
  const identities = [...candidate.files].sort();
  if (new Set(identities).size !== identities.length) {
    throw new Error('Candidate identity document contains duplicate files.');
  }
  const rootEntries = readdirSync(root, { withFileTypes: true });
  if (
    rootEntries.length !== 3 ||
    !rootEntries.some(
      (entry) => entry.name === 'candidate.json' && entry.isFile(),
    ) ||
    !rootEntries.some(
      (entry) => entry.name === 'release' && entry.isDirectory(),
    ) ||
    !rootEntries.some(
      (entry) => entry.name === 'harness' && entry.isDirectory(),
    ) ||
    rootEntries.some((entry) => entry.isSymbolicLink())
  ) {
    throw new Error('Candidate root contains missing or undeclared entries.');
  }
  const actualPaths = new Set([
    ...listCandidateTree(join(root, 'release'), 'release'),
    ...listCandidateTree(join(root, 'harness'), 'harness'),
  ]);
  const declaredPaths = new Set();
  for (const identity of identities) {
    const match = String(identity).match(
      /^((?:release|harness)\/[^:]+):([0-9a-f]{64})$/i,
    );
    if (!match) {
      throw new Error(`Candidate file identity is invalid: ${identity}.`);
    }
    declaredPaths.add(match[1]);
    const path = resolve(root, ...match[1].split('/'));
    if (
      !path.startsWith(`${root}${sep}`) ||
      !existsSync(path) ||
      !statSync(path).isFile() ||
      lstatSync(path).isSymbolicLink() ||
      !realpathSync(path).startsWith(`${realRoot}${sep}`) ||
      (await sha256File(path)) !== match[2].toLowerCase()
    ) {
      throw new Error(`Candidate file identity does not match: ${match[1]}.`);
    }
  }
  if (
    actualPaths.size !== declaredPaths.size ||
    [...actualPaths].some((path) => !declaredPaths.has(path))
  ) {
    throw new Error(
      'Candidate identity does not exactly cover release and harness files.',
    );
  }
  const computed = createHash('sha256')
    .update(identities.join('\n'))
    .digest('hex');
  if (computed !== candidate.candidateId.toLowerCase()) {
    throw new Error(
      'Candidate ID does not match the verified file identities.',
    );
  }
  return candidate;
}

function listCandidateTree(root, prefix) {
  const output = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const identityPath = `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Candidate tree contains a symbolic link: ${identityPath}.`,
      );
    }
    if (entry.isDirectory()) {
      output.push(...listCandidateTree(path, identityPath));
    } else if (entry.isFile()) {
      output.push(identityPath);
    } else {
      throw new Error(
        `Candidate tree contains an unsupported entry: ${identityPath}.`,
      );
    }
  }
  return output;
}

export function planAssetUploads(
  existingAssets,
  desiredAssets,
  { allowExistingNames = [] } = {},
) {
  const existingByName = new Map(
    existingAssets.map((item) => [item.name, item]),
  );
  const desiredNames = new Set(desiredAssets.map((item) => item.name));
  const allowed = new Set([...desiredNames, ...allowExistingNames]);
  const unexpected = existingAssets.filter((item) => !allowed.has(item.name));
  if (unexpected.length > 0) {
    throw new Error(
      `Release contains unexpected assets: ${unexpected.map((item) => item.name).join(', ')}.`,
    );
  }
  const upload = [];
  const reuse = [];
  for (const desired of desiredAssets) {
    const existing = existingByName.get(desired.name);
    if (!existing) {
      upload.push(desired);
      continue;
    }
    const digest = String(existing.digest ?? '')
      .replace(/^sha256:/, '')
      .toLowerCase();
    if (!digest || digest !== desired.sha256.toLowerCase()) {
      throw new Error(
        `Release asset ${desired.name} already exists with a different digest.`,
      );
    }
    reuse.push(desired);
  }
  return { upload, reuse };
}

export function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!name.startsWith('--')) throw new Error(`Unexpected argument: ${name}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${name} requires a value.`);
    }
    parsed[name.slice(2)] = value;
    index += 1;
  }
  return parsed;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function copyInto(source, destination) {
  if (!existsSync(source))
    throw new Error(`Required release input is missing: ${source}`);
  mkdirSync(dirname(destination), { recursive: true });
  if (statSync(source).isDirectory())
    cpSync(source, destination, { recursive: true });
  else copyFileSync(source, destination);
}

export function listFiles(root) {
  if (!existsSync(root)) return [];
  const output = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...listFiles(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  const handle = await open(path, 'r');
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

export function relativePosix(root, path) {
  return relative(root, path).split(sep).join('/');
}

function encodePurlName(name) {
  return name
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function isGeneratedReleaseDocument(releaseRoot, path) {
  const relativePath = relativePosix(releaseRoot, path);
  return (
    relativePath === 'SHA256SUMS' ||
    relativePath === 'metadata/release-metadata.json' ||
    relativePath === 'metadata/license-inventory.json' ||
    /^metadata\/cert-prep-alpha(?:-[a-z0-9-]+)?\.(?:spdx|cdx)\.json$/.test(
      relativePath,
    )
  );
}

function rejectForbiddenReleaseFiles(files) {
  const forbidden = files.find((path) =>
    /(?:^|[\\/])(?:flm|fastflowlm)(?:[-_.].*)?\.exe$/i.test(path),
  );
  if (forbidden) {
    throw new Error(
      `FastFlowLM binaries must not be redistributed: ${forbidden}`,
    );
  }
  const duplicateNames = new Set();
  const names = new Set();
  for (const path of files) {
    const name = basename(path).toLowerCase();
    if (names.has(name)) duplicateNames.add(name);
    names.add(name);
  }
  if (duplicateNames.size > 0) {
    throw new Error(
      `Release asset basenames must be unique: ${[...duplicateNames].join(', ')}.`,
    );
  }
}
