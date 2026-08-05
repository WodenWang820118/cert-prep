import { CAPTURE_RUNTIME_MAX_BYTES } from './package-qa/constants.mts';

/** Validates the shared bounded size contract for staged Capture artifacts. */
export function validateCaptureArtifactBytes(
  value: unknown,
  context = 'Capture runtime artifact',
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > CAPTURE_RUNTIME_MAX_BYTES
  ) {
    throw new Error(`${context} bytes must be between 1 and 536870912.`);
  }
  return value;
}
