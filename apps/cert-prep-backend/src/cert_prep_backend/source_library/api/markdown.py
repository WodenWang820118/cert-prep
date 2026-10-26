"""Deterministic Markdown projection for persisted PDF document chunks."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence
from pathlib import Path
import re
import unicodedata
from urllib.parse import quote


def render_pdf_markdown(
    *,
    filename: str,
    chunks: Sequence[Mapping[str, object]],
) -> str:
    """Render current persisted page text without changing its OCR content."""

    pages: dict[int, list[str]] = defaultdict(list)
    for chunk in chunks:
        page_number = int(chunk["page_number"])
        if page_number < 1:
            raise ValueError("PDF Markdown chunks must have a positive page number")
        pages[page_number].append(str(chunk.get("text") or "").rstrip())

    lines = [f"# {Path(filename).name}", ""]
    for page_number in sorted(pages):
        lines.extend(
            [
                f"## Page {page_number}",
                "",
                "\n\n".join(pages[page_number]),
                "",
            ]
        )
    return "\n".join(lines).rstrip() + "\n"


def markdown_download_filename(filename: str) -> str:
    """Return a path-free UTF-8 filename with a Markdown suffix."""

    source_name = Path(filename).name
    stem = Path(source_name).stem or "document"
    return f"{stem}.md"


def markdown_content_disposition(filename: str) -> str:
    """Build an attachment header with ASCII fallback and RFC 5987 filename."""

    safe_name = markdown_download_filename(filename)
    ascii_name = unicodedata.normalize("NFKD", safe_name).encode("ascii", "ignore").decode()
    ascii_name = re.sub(r"[^A-Za-z0-9._-]+", "_", ascii_name).strip("._") or "document.md"
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(safe_name)}"


__all__ = [
    "markdown_content_disposition",
    "markdown_download_filename",
    "render_pdf_markdown",
]
