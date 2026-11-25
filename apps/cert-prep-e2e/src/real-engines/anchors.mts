/** One fixed normalization for recognized text and for the private anchors compared with it. */

export function normalizeRecognizedText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

export function countAnchors(
  text: string,
  anchors: readonly string[],
): { readonly found: number; readonly expected: number } {
  const normalized = normalizeRecognizedText(text);
  let found = 0;
  for (const anchor of anchors) {
    const expected = normalizeRecognizedText(anchor);
    if (expected.length > 0 && normalized.includes(expected)) found += 1;
  }
  return { found, expected: anchors.length };
}
