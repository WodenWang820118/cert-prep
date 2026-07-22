import { basename } from 'node:path';

import { CAPTURE_WINDOWSML_BUNDLE_MAX_BYTES } from './package-qa/constants.mts';

export interface CaptureRuntimeBundleRequirement {
  readonly artifactUrl: string;
  readonly artifactFileName: string;
  readonly bytes: number;
  readonly sha256: string;
}

const PLAIN_ZIP_FILE_NAME = /^[A-Za-z0-9._-]+\.zip$/u;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/u;
const DOT_SEGMENT = /^\.\.?[ ]*$/u;
const DESCRIPTOR_FIELDS = [
  'artifactFileName',
  'artifactUrl',
  'bytes',
  'sha256',
] as const;

/** Validates the shared bounded size contract for staged Capture artifacts. */
export function validateCaptureArtifactBytes(
  value: unknown,
  context = 'Capture runtime artifact',
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > CAPTURE_WINDOWSML_BUNDLE_MAX_BYTES
  ) {
    throw new Error(`${context} bytes must be between 1 and 536870912.`);
  }
  return value;
}

/** Validates the canonical, download-safe WindowsML descriptor contract. */
export function validateCaptureWindowsmlDescriptor(
  value: unknown,
  context = 'Capture runtime WindowsML requirement',
): CaptureRuntimeBundleRequirement {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${context} is required.`);
  }
  const fields = Object.keys(value).sort();
  if (
    fields.length !== DESCRIPTOR_FIELDS.length ||
    fields.some((field, index) => field !== DESCRIPTOR_FIELDS[index])
  ) {
    throw new Error(
      `${context} must contain exactly artifactUrl, artifactFileName, bytes, and sha256.`,
    );
  }
  const descriptor = value as Partial<CaptureRuntimeBundleRequirement>;
  const fileName = descriptor.artifactFileName;
  if (
    typeof fileName !== 'string' ||
    basename(fileName) !== fileName ||
    !PLAIN_ZIP_FILE_NAME.test(fileName)
  ) {
    throw new Error(`${context} artifactFileName must be a plain .zip name.`);
  }
  const bytes = validateCaptureArtifactBytes(descriptor.bytes, context);
  if (
    typeof descriptor.sha256 !== 'string' ||
    !LOWERCASE_SHA256.test(descriptor.sha256)
  ) {
    throw new Error(`${context} sha256 must be 64 lowercase hex characters.`);
  }
  const rawUrl = descriptor.artifactUrl;
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('https://')) {
    throw new Error(`${context} artifactUrl is not canonical HTTPS.`);
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${context} artifactUrl is not canonical HTTPS.`);
  }
  const authorityAndPath = rawUrl.slice('https://'.length);
  const pathOffset = authorityAndPath.indexOf('/');
  const rawAuthority = authorityAndPath.slice(0, pathOffset);
  const rawPath = authorityAndPath.slice(pathOffset);
  const rawSegments = rawPath.split('/');
  if (
    rawUrl.trim() !== rawUrl ||
    [...rawUrl].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return /\s/u.test(character) || codePoint < 0x20 || codePoint === 0x7f;
    }) ||
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.port !== '' && url.port !== '443') ||
    pathOffset < 1 ||
    rawAuthority.includes('@') ||
    rawAuthority.includes('\\') ||
    rawAuthority.endsWith(':') ||
    rawPath.includes('\\') ||
    rawPath.includes(':') ||
    rawUrl.includes('%') ||
    [...rawPath].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 0x20 || codePoint === 0x7f;
    }) ||
    rawSegments.some((segment) => DOT_SEGMENT.test(segment)) ||
    rawSegments.at(-1) !== fileName ||
    url.pathname.split('/').at(-1) !== fileName
  ) {
    throw new Error(`${context} artifactUrl is not canonical HTTPS.`);
  }
  return {
    artifactUrl: rawUrl,
    artifactFileName: fileName,
    bytes,
    sha256: descriptor.sha256,
  };
}
