"""The messages Cert stores and shows when Capture Runtime cannot extract a source.

A failed run stores one of these, chosen by the source kind and Capture's failure code. The
runtime's own error text and requirement detail are logged, never stored or shown.
"""

PDF_OCR_UNAVAILABLE_MESSAGE = (
    "This PDF requires text recognition, which is unavailable in the installed "
    "Capture Runtime."
)
TEXT_RECOGNITION_UNAVAILABLE_MESSAGE = (
    "Text recognition is unavailable in the installed Capture Runtime."
)
SPEECH_RECOGNITION_UNAVAILABLE_MESSAGE = (
    "Speech recognition is unavailable in the installed Capture Runtime."
)
TEXT_RECOGNITION_FAILED_MESSAGE = "Text recognition could not read this source."
SPEECH_RECOGNITION_FAILED_MESSAGE = "Speech recognition could not transcribe this recording."
# A review start that failed without a Capture code (Capture gave none, or storing the review
# state failed) states no diagnosis.
EXTRACTION_FAILED_MESSAGE = "Capture Runtime extraction failed."
REQUIREMENT_UNAVAILABLE_CODE = "requirement_unavailable"


def requirement_unavailable_message(source_kind: str) -> str:
    """What Cert says when the requirement a source kind needs is not ready."""

    if source_kind == "pdf":
        return PDF_OCR_UNAVAILABLE_MESSAGE
    if source_kind == "audio":
        return SPEECH_RECOGNITION_UNAVAILABLE_MESSAGE
    return TEXT_RECOGNITION_UNAVAILABLE_MESSAGE


def extraction_failure_message(source_kind: str, code: str | None) -> str:
    """What Cert says when a capture of this source kind failed with Capture's failure code,
    or with none."""

    if code == REQUIREMENT_UNAVAILABLE_CODE:
        return requirement_unavailable_message(source_kind)
    if source_kind == "audio":
        return SPEECH_RECOGNITION_FAILED_MESSAGE
    return TEXT_RECOGNITION_FAILED_MESSAGE
