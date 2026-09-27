/**
 * Public input seam for the real packaged OCR journey.
 *
 * The smoke must receive a PDF containing a raster image from the caller. The
 * input seam does not inspect embedded text metadata: every PDF is sent to the
 * Capture Runtime raster/PaddleOCR path, and OCR-only provenance is proven by
 * the terminal semantic evidence contracts.
 */
export function assertRasterPdfFixture(content: Uint8Array): void {
  const text = Buffer.from(content).toString('latin1');
  if (!text.startsWith('%PDF-')) {
    throw new Error('Packaged OCR fixture must be a PDF.');
  }
  if (!/\/Subtype\s*\/Image/u.test(text)) {
    throw new Error('Packaged OCR fixture must contain a raster image.');
  }
}
