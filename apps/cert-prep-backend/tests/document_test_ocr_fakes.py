from threading import Event
import time

from cert_prep_backend.domains.source_documents.ocr import OCRHealth, OCRPageResult
from cert_prep_backend.api.errors import ProviderUnavailableError


JLPT_SINGLE_ITEM_OCR_TEXT = (
    "問題1 の言葉の読み方として最もよいのを、1・2・3・4から一つ選びなさい。 "
    "1 余暇の楽しみ方はいろいろある。 1 ようか 2よか 3よが 4 ようが"
)


class MockPaddleOcrProvider:
    provider = "mock-ocr"
    engine = "paddleocr"

    def __init__(self) -> None:
        self.ocr_page_numbers: list[int] = []

    def health(self) -> OCRHealth:
        return OCRHealth(
            provider=self.provider,
            engine=self.engine,
            available=True,
            detail="test provider",
            python_version="3.13.5",
            paddle_version="3.3.0",
            paddleocr_version="3.3.0",
            selected_device="gpu:0",
            cuda_available=True,
            gpu_count=1,
            model_cache_dir=None,
            fallback_reason=None,
        )

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        assert image_png.startswith(b"\x89PNG")
        self.ocr_page_numbers.append(page_number)
        return OCRPageResult(
            text=f"JLPT question {page_number}: choose the correct word. A correct B wrong",
            extraction_method="paddle_ocr_gpu",
            device="gpu:0",
            fallback_reason=None,
            duration_ms=123,
        )


class CapturingOcrProvider(MockPaddleOcrProvider):
    def __init__(self) -> None:
        super().__init__()
        self.image_payloads: list[bytes] = []

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        self.image_payloads.append(image_png)
        return super().extract_page_text(image_png, page_number)


class JlptBlockOcrProvider(MockPaddleOcrProvider):
    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        assert image_png.startswith(b"\x89PNG")
        self.ocr_page_numbers.append(page_number)
        return OCRPageResult(
            text=JLPT_SINGLE_ITEM_OCR_TEXT,
            extraction_method="paddle_ocr_gpu",
            device="gpu:0",
            fallback_reason=None,
            duration_ms=123,
        )


class BlockingOcrProvider(MockPaddleOcrProvider):
    def __init__(self) -> None:
        super().__init__()
        self.started = Event()
        self.release = Event()

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        self.started.set()
        assert self.release.wait(timeout=5)
        return super().extract_page_text(image_png, page_number)


class PreparingOcrProvider(MockPaddleOcrProvider):
    def __init__(self) -> None:
        super().__init__()
        self.calls: list[str] = []

    def prepare_for_document_ocr(self) -> None:
        self.calls.append("prepare")

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        self.calls.append(f"extract:{page_number}")
        return super().extract_page_text(image_png, page_number)


class MockOllamaOcrProvider(MockPaddleOcrProvider):
    provider = "mock-ollama"
    engine = "gemma4:12b"

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        assert image_png.startswith(b"\x89PNG")
        self.ocr_page_numbers.append(page_number)
        return OCRPageResult(
            text=f"Ollama OCR page {page_number}",
            extraction_method="gemma_ocr",
            device="ollama",
            fallback_reason=None,
            duration_ms=77,
        )


class FailingSecondPageOcrProvider(MockPaddleOcrProvider):
    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        assert image_png.startswith(b"\x89PNG")
        self.ocr_page_numbers.append(page_number)
        if page_number == 2:
            raise RuntimeError("simulated OCR failure")
        return OCRPageResult(
            text=f"JLPT question {page_number}: choose the correct word. A correct B wrong",
            extraction_method="paddle_ocr_cpu_fallback",
            device="cpu",
            fallback_reason="gpu:0 failed: simulated GPU OCR failure",
            duration_ms=123,
        )


class DelayedOcrProvider(MockPaddleOcrProvider):
    def __init__(self, *, page_workers: int) -> None:
        super().__init__()
        self.page_workers = page_workers

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        assert image_png.startswith(b"\x89PNG")
        if self.page_workers > 1 and page_number == 1:
            time.sleep(0.05)
        self.ocr_page_numbers.append(page_number)
        return OCRPageResult(
            text=f"Worker page {page_number}",
            extraction_method="paddle_ocr_gpu",
            device="gpu:0",
            fallback_reason=None,
            duration_ms=page_number * 10,
        )


class BlockingFirstPageOcrProvider(MockPaddleOcrProvider):
    page_workers = 2

    def __init__(self) -> None:
        super().__init__()
        self.page_one_started = Event()
        self.page_two_finished = Event()
        self.release_page_one = Event()

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        assert image_png.startswith(b"\x89PNG")
        if page_number == 1:
            self.page_one_started.set()
            assert self.release_page_one.wait(timeout=5)
        self.ocr_page_numbers.append(page_number)
        if page_number == 2:
            self.page_two_finished.set()
        return OCRPageResult(
            text=f"Worker page {page_number}",
            extraction_method="paddle_ocr_gpu",
            device="gpu:0",
            fallback_reason=None,
            duration_ms=page_number * 10,
        )


class BlockingExamFirstPageOcrProvider(BlockingFirstPageOcrProvider):
    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        result = super().extract_page_text(image_png, page_number)
        return OCRPageResult(
            text=JLPT_SINGLE_ITEM_OCR_TEXT,
            extraction_method=result.extraction_method,
            device=result.device,
            fallback_reason=result.fallback_reason,
            duration_ms=result.duration_ms,
        )


class NoticePageOcrProvider(MockPaddleOcrProvider):
    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        assert image_png.startswith(b"\x89PNG")
        self.ocr_page_numbers.append(page_number)
        return OCRPageResult(
            text=(
                "This test paper has multiple versions. The questions are the same, "
                "but the fonts and layouts differ."
            ),
            extraction_method="paddle_ocr_gpu",
            device="gpu:0",
            fallback_reason=None,
            duration_ms=12,
        )


class PageOneObservedOcrProvider(MockPaddleOcrProvider):
    page_workers = 1

    def __init__(self) -> None:
        super().__init__()
        self.page_one_finished = Event()

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        result = super().extract_page_text(image_png, page_number)
        if page_number == 1:
            self.page_one_finished.set()
        return result


class MissingPaddleRuntimeProvider(MockPaddleOcrProvider):
    def health(self) -> OCRHealth:
        return OCRHealth(
            provider="paddle",
            engine="paddleocr",
            available=False,
            detail="PaddleOCR runtime is not installed.",
            python_version="3.13.5",
            paddle_version=None,
            paddleocr_version=None,
            selected_device=None,
            cuda_available=False,
            gpu_count=0,
            model_cache_dir=None,
            fallback_reason=None,
            unavailable_reason="paddle_runtime_missing",
        )

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        raise ProviderUnavailableError("PaddleOCR runtime is not installed.")


class PrepareFailingPaddleRuntimeProvider(MissingPaddleRuntimeProvider):
    def prepare_for_document_ocr(self) -> None:
        raise ProviderUnavailableError("PaddleOCR runtime is not installed.")
