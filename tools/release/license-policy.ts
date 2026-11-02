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
