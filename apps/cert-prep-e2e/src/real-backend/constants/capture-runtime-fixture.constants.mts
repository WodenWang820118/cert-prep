export const REAL_PDF_MAGIC = '%PDF-';

export const PDF_TEXT_EXTRACTION_SCRIPT = `
import json
import sys
import unicodedata
from io import BytesIO
from pypdf import PdfReader

reader = PdfReader(BytesIO(sys.stdin.buffer.read()))
pages = [
    {
        "page": index + 1,
        "text": unicodedata.normalize("NFKC", page.extract_text() or "").strip(),
    }
    for index, page in enumerate(reader.pages)
]
print(json.dumps(pages, ensure_ascii=False))
`;
