from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO

from pypdf import PdfReader

from exam_prep_backend.errors import InvalidPdfError


@dataclass(frozen=True)
class ExtractedPage:
    page_number: int
    text: str
    source_excerpt: str


@dataclass(frozen=True)
class PdfExtractionResult:
    page_count: int
    pages: list[ExtractedPage]

    @property
    def has_text(self) -> bool:
        return bool(self.pages)


def extract_pdf_pages(pdf_bytes: bytes) -> PdfExtractionResult:
    try:
        reader = PdfReader(BytesIO(pdf_bytes))
    except Exception as exc:
        raise InvalidPdfError("Uploaded file is not a readable PDF.") from exc

    extracted_pages: list[ExtractedPage] = []
    for page_number, page in enumerate(reader.pages, start=1):
        try:
            text = _normalize_text(page.extract_text() or "")
        except Exception as exc:
            raise InvalidPdfError(f"Could not extract page {page_number}.") from exc
        if text:
            extracted_pages.append(
                ExtractedPage(
                    page_number=page_number,
                    text=text,
                    source_excerpt=text[:500],
                )
            )

    return PdfExtractionResult(page_count=len(reader.pages), pages=extracted_pages)


def _normalize_text(text: str) -> str:
    return " ".join(text.split())
