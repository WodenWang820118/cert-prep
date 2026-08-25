export const REAL_PDF_MAGIC = '%PDF-';

export const PDF_PAGE_INSPECTION_SCRIPT = `
import json
import sys
import pypdfium2 as pdfium

document = pdfium.PdfDocument(sys.stdin.buffer.read())
try:
    print(json.dumps({"pageCount": len(document)}))
finally:
    document.close()
`;
