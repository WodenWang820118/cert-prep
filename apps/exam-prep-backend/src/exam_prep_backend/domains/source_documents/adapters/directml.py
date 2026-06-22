from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import platform
from time import perf_counter
from typing import Any

from exam_prep_backend.domains.source_documents.ocr_contracts import OCRHealth, OCRPageResult
from exam_prep_backend.exceptions import ProviderUnavailableError


DET_INPUT_LONG_SIDE = 1152
DET_THRESH = 0.3
DET_BOX_THRESH = 0.6
DET_UNCLIP_RATIO = 1.5
REC_IMAGE_SHAPE = (3, 48, 320)


class DirectMLOCRProvider:
    """Blocked-until-ready DirectML OCR provider for the AMD iGPU production gate."""

    provider = "directml"
    engine = "onnxruntime-directml"
    page_workers = 1

    def health(self) -> OCRHealth:
        providers, version, import_error = _onnxruntime_state()
        directml_available = "DmlExecutionProvider" in providers
        unavailable_reason = _unavailable_reason(import_error, directml_available)
        return OCRHealth(
            provider=self.provider,
            engine=self.engine,
            available=False,
            detail=_detail(import_error, directml_available),
            python_version=platform.python_version(),
            paddle_version=None,
            paddleocr_version=version,
            selected_device="amd_directml" if directml_available else None,
            cuda_available=False,
            gpu_count=0,
            model_cache_dir=None,
            fallback_reason=None,
            unavailable_reason=unavailable_reason,
        )

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        raise ProviderUnavailableError(
            "DirectML OCR is gated until model artifacts, deterministic inference, "
            "benchmark, and AMD/Nvidia routing evidence pass."
        )


class DirectMLRuntimeOCRProvider:
    """Runnable DirectML OCR provider used inside the packaged DirectML runtime."""

    provider = "directml"
    engine = "onnxruntime-directml"
    page_workers = 1

    def __init__(self, *, model_dir: Path, device_id: int | None = 0) -> None:
        self.model_dir = model_dir
        self.device_id = device_id
        self._runner = DirectMLOCRRunner(model_dir=model_dir, device_id=device_id)

    def health(self) -> OCRHealth:
        providers, version, import_error = _onnxruntime_state()
        directml_available = "DmlExecutionProvider" in providers
        missing_files = [
            name
            for name in ("det_model.onnx", "rec_model.onnx", "rec_char_dict.txt", "pipeline.json")
            if not (self.model_dir / name).is_file()
        ]
        available = import_error is None and directml_available and not missing_files
        return OCRHealth(
            provider=self.provider,
            engine=self.engine,
            available=available,
            detail=_runtime_detail(import_error, directml_available, missing_files),
            python_version=platform.python_version(),
            paddle_version=None,
            paddleocr_version=version,
            selected_device="amd_directml" if directml_available else None,
            cuda_available=False,
            gpu_count=0,
            model_cache_dir=str(self.model_dir),
            fallback_reason=None,
            unavailable_reason=_runtime_unavailable_reason(
                import_error,
                directml_available,
                missing_files,
            ),
        )

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        result = self._runner.extract_text(image_png)
        return OCRPageResult(
            text=result.text,
            extraction_method="directml_ocr",
            device=result.device,
            fallback_reason=None,
            duration_ms=result.duration_ms,
        )


@dataclass(frozen=True)
class DirectMLOCRTextResult:
    text: str
    duration_ms: int
    box_count: int
    recognized_count: int
    device: str = "amd_directml"


class DirectMLOCRRunner:
    """Small PP-OCR ONNX runner used by DirectML production-gate QA targets."""

    def __init__(self, *, model_dir: Path, device_id: int | None = 0) -> None:
        self.model_dir = model_dir
        self.device_id = device_id
        self._ort: Any | None = None
        self._det_session: Any | None = None
        self._rec_session: Any | None = None
        self._characters: list[str] | None = None

    def extract_text(self, image_png: bytes) -> DirectMLOCRTextResult:
        started = perf_counter()
        image = self._decode_image(image_png)
        boxes = self._detect_boxes(image)
        crops = [self._crop_text_region(image, box) for box in boxes]
        recognized = self._recognize_crops(crops)
        lines = [item["text"] for item in recognized if item["text"]]
        return DirectMLOCRTextResult(
            text="\n".join(lines),
            duration_ms=_elapsed_ms(started),
            box_count=len(boxes),
            recognized_count=len(lines),
        )

    def _decode_image(self, image_png: bytes) -> Any:
        cv2, np = _import_cv2_numpy()
        buffer = np.frombuffer(image_png, dtype=np.uint8)
        image = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
        if image is None:
            raise ProviderUnavailableError("DirectML OCR could not decode the page image.")
        return image

    def _detect_boxes(self, image: Any) -> list[Any]:
        cv2, np = _import_cv2_numpy()
        input_tensor, ratio_h, ratio_w = _preprocess_detection_image(image, cv2=cv2, np=np)
        session = self._detector()
        prediction = session.run(None, {session.get_inputs()[0].name: input_tensor})[0]
        probability_map = prediction[0, 0]
        boxes = _boxes_from_bitmap(
            probability_map,
            bitmap=(probability_map > DET_THRESH).astype("uint8"),
            dest_width=image.shape[1],
            dest_height=image.shape[0],
            ratio_w=ratio_w,
            ratio_h=ratio_h,
            cv2=cv2,
            np=np,
        )
        return _sort_boxes(boxes)

    def _crop_text_region(self, image: Any, box: Any) -> Any:
        cv2, np = _import_cv2_numpy()
        box = _order_points_clockwise(box, np=np).astype("float32")
        width = int(
            max(
                np.linalg.norm(box[0] - box[1]),
                np.linalg.norm(box[2] - box[3]),
            )
        )
        height = int(
            max(
                np.linalg.norm(box[0] - box[3]),
                np.linalg.norm(box[1] - box[2]),
            )
        )
        width = max(1, width)
        height = max(1, height)
        target = np.array(
            [[0, 0], [width, 0], [width, height], [0, height]],
            dtype="float32",
        )
        matrix = cv2.getPerspectiveTransform(box, target)
        crop = cv2.warpPerspective(
            image,
            matrix,
            (width, height),
            borderMode=cv2.BORDER_REPLICATE,
            flags=cv2.INTER_CUBIC,
        )
        if crop.shape[0] / max(crop.shape[1], 1) >= 1.5:
            crop = np.rot90(crop)
        return crop

    def _recognize_crops(self, crops: list[Any]) -> list[dict[str, Any]]:
        if not crops:
            return []
        _cv2, np = _import_cv2_numpy()
        input_width = _recognition_batch_width(crops)
        tensors = [
            _preprocess_recognition_crop(crop, input_width=input_width, np=np)
            for crop in crops
        ]
        batch = np.stack(tensors, axis=0).astype("float32")
        session = self._recognizer()
        output = session.run(None, {session.get_inputs()[0].name: batch})[0]
        return [_decode_ctc_output(prediction, self._character_dict()) for prediction in output]

    def _detector(self) -> Any:
        if self._det_session is None:
            self._det_session = self._session(self.model_dir / "det_model.onnx")
        return self._det_session

    def _recognizer(self) -> Any:
        if self._rec_session is None:
            self._rec_session = self._session(self.model_dir / "rec_model.onnx")
        return self._rec_session

    def _session(self, model_path: Path) -> Any:
        if not model_path.is_file():
            raise ProviderUnavailableError(f"DirectML OCR model is missing: {model_path}")
        ort = self._onnxruntime()
        return ort.InferenceSession(
            str(model_path),
            sess_options=_directml_session_options(ort),
            providers=_directml_providers(self.device_id),
        )

    def _onnxruntime(self) -> Any:
        if self._ort is None:
            try:
                import onnxruntime as ort  # type: ignore[import-not-found]
            except Exception as exc:
                raise ProviderUnavailableError(f"DirectML runtime unavailable: {exc}") from exc
            self._ort = ort
        return self._ort

    def _character_dict(self) -> list[str]:
        if self._characters is None:
            path = self.model_dir / "rec_char_dict.txt"
            if not path.is_file():
                raise ProviderUnavailableError(f"DirectML OCR dictionary is missing: {path}")
            self._characters = path.read_text(encoding="utf-8").splitlines()
            if not self._characters:
                raise ProviderUnavailableError("DirectML OCR dictionary is empty.")
        return self._characters


def _onnxruntime_state() -> tuple[list[str], str | None, Exception | None]:
    try:
        import onnxruntime as ort  # type: ignore[import-not-found]
    except Exception as exc:
        return [], None, exc
    try:
        providers = list(ort.get_available_providers())
    except Exception as exc:
        return [], getattr(ort, "__version__", None), exc
    return providers, getattr(ort, "__version__", None), None


def _unavailable_reason(
    import_error: Exception | None,
    directml_available: bool,
) -> str:
    if import_error is not None:
        return "directml_runtime_missing"
    if not directml_available:
        return "directml_provider_unavailable"
    return "directml_ocr_not_ready"


def _detail(import_error: Exception | None, directml_available: bool) -> str:
    if import_error is not None:
        return f"AMD DirectML OCR runtime unavailable: {import_error}"
    if not directml_available:
        return "AMD DirectML OCR runtime is installed but DmlExecutionProvider is unavailable."
    return (
        "AMD DirectML OCR runtime is present, but production OCR is blocked until "
        "ONNX model artifacts, inference smoke, benchmark, and GPU routing checks pass."
    )


def _runtime_unavailable_reason(
    import_error: Exception | None,
    directml_available: bool,
    missing_files: list[str],
) -> str | None:
    if import_error is not None:
        return "directml_runtime_missing"
    if not directml_available:
        return "directml_provider_unavailable"
    if missing_files:
        return "directml_model_artifacts_missing"
    return None


def _runtime_detail(
    import_error: Exception | None,
    directml_available: bool,
    missing_files: list[str],
) -> str:
    if import_error is not None:
        return f"AMD DirectML OCR runtime unavailable: {import_error}"
    if not directml_available:
        return "AMD DirectML OCR runtime is installed but DmlExecutionProvider is unavailable."
    if missing_files:
        return f"AMD DirectML OCR model artifacts are missing: {', '.join(missing_files)}."
    return "AMD DirectML OCR runtime is ready."


def _directml_providers(device_id: int | None) -> list[Any]:
    if device_id is None:
        return ["DmlExecutionProvider", "CPUExecutionProvider"]
    return [
        ("DmlExecutionProvider", {"device_id": str(device_id)}),
        "CPUExecutionProvider",
    ]


def _directml_session_options(ort: Any) -> Any:
    options = ort.SessionOptions()
    options.enable_mem_pattern = False
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    return options


def _preprocess_detection_image(image: Any, *, cv2: Any, np: Any) -> tuple[Any, float, float]:
    height, width = image.shape[:2]
    ratio = DET_INPUT_LONG_SIDE / max(height, width)
    resized_height = max(32, int(round(height * ratio / 32) * 32))
    resized_width = max(32, int(round(width * ratio / 32) * 32))
    resized = cv2.resize(image, (resized_width, resized_height))
    normalized = resized.astype("float32") / 255.0
    mean = np.array([0.485, 0.456, 0.406], dtype="float32")
    std = np.array([0.229, 0.224, 0.225], dtype="float32")
    normalized = (normalized - mean) / std
    tensor = normalized.transpose(2, 0, 1)[None, :, :, :].astype("float32")
    return tensor, resized_height / height, resized_width / width


def _boxes_from_bitmap(
    probability_map: Any,
    *,
    bitmap: Any,
    dest_width: int,
    dest_height: int,
    ratio_w: float,
    ratio_h: float,
    cv2: Any,
    np: Any,
) -> list[Any]:
    contours, _hierarchy = cv2.findContours(
        (bitmap * 255).astype("uint8"),
        cv2.RETR_LIST,
        cv2.CHAIN_APPROX_SIMPLE,
    )
    boxes: list[Any] = []
    for contour in contours[:1000]:
        points, short_side = _mini_box(contour, cv2=cv2, np=np)
        if short_side < 3:
            continue
        score = _box_score_fast(probability_map, points, cv2=cv2, np=np)
        if score < DET_BOX_THRESH:
            continue
        expanded = _unclip(points)
        if expanded is None:
            continue
        points, short_side = _mini_box(expanded, cv2=cv2, np=np)
        if short_side < 5:
            continue
        points[:, 0] = np.clip(np.round(points[:, 0] / ratio_w), 0, dest_width)
        points[:, 1] = np.clip(np.round(points[:, 1] / ratio_h), 0, dest_height)
        boxes.append(points.astype("float32"))
    return boxes


def _mini_box(contour: Any, *, cv2: Any, np: Any) -> tuple[Any, float]:
    bounding_box = cv2.minAreaRect(contour)
    points = cv2.boxPoints(bounding_box)
    points = _order_points_clockwise(points, np=np)
    short_side = min(bounding_box[1])
    return points, short_side


def _order_points_clockwise(points: Any, *, np: Any) -> Any:
    rect = np.zeros((4, 2), dtype="float32")
    point_sum = points.sum(axis=1)
    point_diff = np.diff(points, axis=1).reshape(-1)
    rect[0] = points[np.argmin(point_sum)]
    rect[2] = points[np.argmax(point_sum)]
    rect[1] = points[np.argmin(point_diff)]
    rect[3] = points[np.argmax(point_diff)]
    return rect


def _box_score_fast(probability_map: Any, box: Any, *, cv2: Any, np: Any) -> float:
    height, width = probability_map.shape[:2]
    box = box.copy()
    xmin = max(0, min(width - 1, int(np.floor(box[:, 0].min()))))
    xmax = max(0, min(width - 1, int(np.ceil(box[:, 0].max()))))
    ymin = max(0, min(height - 1, int(np.floor(box[:, 1].min()))))
    ymax = max(0, min(height - 1, int(np.ceil(box[:, 1].max()))))
    if xmax <= xmin or ymax <= ymin:
        return 0.0
    mask = np.zeros((ymax - ymin + 1, xmax - xmin + 1), dtype="uint8")
    box[:, 0] -= xmin
    box[:, 1] -= ymin
    cv2.fillPoly(mask, box.reshape(1, -1, 2).astype("int32"), 1)
    return float(cv2.mean(probability_map[ymin : ymax + 1, xmin : xmax + 1], mask)[0])


def _unclip(box: Any) -> Any | None:
    try:
        import pyclipper  # type: ignore[import-not-found]
        from shapely.geometry import Polygon  # type: ignore[import-not-found]
    except Exception as exc:
        raise ProviderUnavailableError(f"DirectML OCR geometry dependencies unavailable: {exc}") from exc

    polygon = Polygon(box)
    distance = polygon.area * DET_UNCLIP_RATIO / max(polygon.length, 1.0)
    offset = pyclipper.PyclipperOffset()
    offset.AddPath(box.tolist(), pyclipper.JT_ROUND, pyclipper.ET_CLOSEDPOLYGON)
    expanded = offset.Execute(distance)
    if not expanded:
        return None
    cv2, np = _import_cv2_numpy()
    candidates = [np.array(path, dtype="float32") for path in expanded if len(path) >= 4]
    if not candidates:
        return None
    return max(candidates, key=lambda candidate: cv2.contourArea(candidate.astype("float32")))


def _sort_boxes(boxes: list[Any]) -> list[Any]:
    return sorted(boxes, key=lambda box: (float(box[:, 1].min()), float(box[:, 0].min())))


def _recognition_batch_width(crops: list[Any]) -> int:
    _image_c, image_h, base_width = REC_IMAGE_SHAPE
    max_ratio = max(crop.shape[1] / float(max(crop.shape[0], 1)) for crop in crops)
    dynamic_width = int(round(image_h * max_ratio))
    return max(base_width, dynamic_width)


def _preprocess_recognition_crop(crop: Any, *, input_width: int, np: Any) -> Any:
    cv2, _np = _import_cv2_numpy()
    image_c, image_h, _base_width = REC_IMAGE_SHAPE
    height, width = crop.shape[:2]
    ratio = width / float(height)
    resized_width = (
        input_width
        if int(round(image_h * ratio)) > input_width
        else max(1, int(round(image_h * ratio)))
    )
    resized = cv2.resize(crop, (resized_width, image_h))
    resized = resized.astype("float32").transpose(2, 0, 1) / 255.0
    resized = (resized - 0.5) / 0.5
    padded = np.zeros((image_c, image_h, input_width), dtype="float32")
    padded[:, :, 0:resized_width] = resized
    return padded


def _decode_ctc_output(prediction: Any, characters: list[str]) -> dict[str, Any]:
    indexes = prediction.argmax(axis=1).tolist()
    probabilities = prediction.max(axis=1).tolist()
    text_parts: list[str] = []
    confidences: list[float] = []
    previous_index: int | None = None
    for index, probability in zip(indexes, probabilities, strict=True):
        if index != 0 and index != previous_index:
            char_index = int(index) - 1
            if 0 <= char_index < len(characters):
                text_parts.append(characters[char_index])
                confidences.append(float(probability))
        previous_index = int(index)
    return {
        "text": "".join(text_parts),
        "confidence": sum(confidences) / len(confidences) if confidences else 0.0,
    }


def _import_cv2_numpy() -> tuple[Any, Any]:
    try:
        import cv2  # type: ignore[import-not-found]
        import numpy as np  # type: ignore[import-not-found]
    except Exception as exc:
        raise ProviderUnavailableError(f"DirectML OCR image dependencies unavailable: {exc}") from exc
    return cv2, np


def _elapsed_ms(started_at: float) -> int:
    return max(0, round((perf_counter() - started_at) * 1000))
