"""Thin Cert Prep adapter over the published Capture Runtime v2 SDK.

The SDK owns discovery, hash negotiation, transport, retries, SSE parsing, and
wire decoding.  This module retains only Cert Prep's product-facing upload
shape and small collection wrappers used by the backend domain.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import re
from threading import Lock
from typing import BinaryIO
from uuid import UUID

import httpx

from capture_runtime_client import (
    CaptureEvent,
    CaptureOperation,
    CaptureRuntimeClient as SdkCaptureRuntimeClient,
    CaptureRuntimeCompatibilityError,
    CaptureRuntimeError,
    CaptureRuntimeProtocolError,
    CaptureSourceKind,
    CaptureStreamingResult,
    CaptureUpload as SdkCaptureUpload,
    HttpRuntimeTransport,
    Ingestion as SdkIngestion,
    PartialCapture,
    OpenStructuringSession,
    RawCapture,
    RuntimeInstallation,
    RuntimeInstallations,
    RuntimeRequirements,
    RuntimeStreamingCapabilities,
    StructuringBatch,
    StructuringSession,
    StructuringMode,
    SubmitStructuringBatch,
)
from capture_runtime_client.codec import decode_model as _decode_model
from cert_prep_backend.domains.capture_workbench.host_models import RuntimeReady


_SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
_TERMINAL_INSTALLATION_STATUSES = frozenset(
    {"completed", "failed", "cancelled", "manual_action_required"}
)


@dataclass(frozen=True, slots=True)
class CaptureUpload:
    """Cert Prep upload input; durable file ownership stays with the host."""

    file_name: str
    content: bytes | BinaryIO
    media_type: str = "application/octet-stream"
    pdf_page_numbers: tuple[int, ...] | None = None


class CaptureRuntimeClient:
    """Backend-only product adapter; all protocol behavior belongs to the SDK."""

    def __init__(
        self,
        *,
        base_url: str,
        bearer_token: str,
        timeout_seconds: float = 30,
        client: httpx.Client | None = None,
    ) -> None:
        _install_candidate_runtime_ready_decoder()
        transport = HttpRuntimeTransport(
            base_url=base_url,
            bearer_token=bearer_token,
            timeout_seconds=timeout_seconds,
            client=client,
        )
        sdk_options: dict[str, object] = {}
        expected_contract = os.environ.get(
            "CERT_PREP_CAPTURE_RUNTIME_CONTRACT_SHA256", ""
        ).strip()
        if expected_contract:
            if not _SHA256_PATTERN.fullmatch(expected_contract):
                raise CaptureRuntimeCompatibilityError(
                    "CERT_PREP_CAPTURE_RUNTIME_CONTRACT_SHA256 must be a lowercase SHA-256 digest."
                )
            sdk_options["allowed_contract_set_sha256"] = [expected_contract]
        self._sdk = SdkCaptureRuntimeClient(
            transport=transport,
            timeout_seconds=timeout_seconds,
            **sdk_options,
        )
        # The 0.4.2 candidate discovery guard is instance-scoped and rejects
        # overlapping negotiations. FastAPI serves the readiness and
        # provenance endpoints concurrently during the UI preflight, so keep
        # the SDK's discovery state machine single-flight at the host boundary.
        self._discovery_lock = Lock()

    def __repr__(self) -> str:
        return f"{type(self).__name__}(sdk={type(self._sdk).__name__})"

    def close(self) -> None:
        self._sdk.close()

    def __enter__(self) -> CaptureRuntimeClient:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def handshake(self) -> RuntimeReady:
        """Negotiate the exact allowlisted contract before returning readiness."""

        with self._discovery_lock:
            ready = self._sdk.discover().ready
        # Keep the host boundary typed with the generated OCR preflight field.
        # The conversion is intentionally lossless for the 0.4.2 SDK and lets
        # the current 0.4.1 rollback pin continue to represent a missing
        # preflight as ``None`` until the candidate SDK is installed.
        return RuntimeReady.model_validate(
            ready.model_dump(mode="python", by_alias=True)
        )

    def get_streaming_capabilities(self) -> RuntimeStreamingCapabilities:
        with self._discovery_lock:
            discovery = self._sdk.discover()
        if discovery.streaming is None:
            raise CaptureRuntimeCompatibilityError(
                "Capture Runtime does not advertise streaming capabilities."
            )
        return discovery.streaming

    def get_requirements(self) -> RuntimeRequirements:
        return self._sdk.get_requirements()

    def start_installation(
        self,
        requirement_id: str,
        *,
        idempotency_key: UUID | str,
    ) -> RuntimeInstallation:
        return self._sdk.start_installation(
            requirement_id,
            idempotency_key=idempotency_key,
        )

    def list_installations(self) -> RuntimeInstallations:
        return RuntimeInstallations(items=self._sdk.list_installations())

    def get_installation(self, installation_id: str) -> RuntimeInstallation:
        installation = self._sdk.get_installation(installation_id)
        if _installation_status_value(installation) in _TERMINAL_INSTALLATION_STATUSES:
            # The candidate SDK caches the first discovery result. A cold
            # runtime reports no OCR compute before windowsml-ocr is installed,
            # so the installation poll must invalidate that result before the
            # UI's post-install readiness check negotiates again.
            with self._discovery_lock:
                _invalidate_sdk_discovery_cache(self._sdk)
        return installation

    def cancel_installation(self, installation_id: str) -> RuntimeInstallation:
        return self._sdk.cancel_installation(installation_id)

    def start_capture(
        self,
        upload: CaptureUpload,
        *,
        source_kind: CaptureSourceKind | str,
        client_request_id: str,
        target_language: str | None = None,
    ) -> CaptureOperation:
        content = _upload_bytes(upload.content)
        if not content:
            raise ValueError("Capture upload must not be empty")
        file_name = upload.file_name.strip()
        if not file_name or len(file_name) > 255:
            raise ValueError("Capture upload filename must contain 1 to 255 characters")
        media_type = upload.media_type.strip()
        if not media_type:
            raise ValueError("Capture upload media type must not be empty")
        kind = CaptureSourceKind(source_kind)
        if upload.pdf_page_numbers is not None:
            _assert_pdf_page_scope(kind, upload.pdf_page_numbers)
        sdk_upload = SdkCaptureUpload(
            file_name=file_name,
            content=content,
            source_kind=kind,
            media_type=media_type,
            structuring_mode=StructuringMode.HOST,
            target_language=target_language,
        )
        if upload.pdf_page_numbers is None:
            return self._sdk.start_capture(
                sdk_upload,
                client_request_id=client_request_id,
            )
        return self._start_capture_with_pdf_page_scope(
            sdk_upload,
            client_request_id=client_request_id,
            page_numbers=upload.pdf_page_numbers,
        )

    def _start_capture_with_pdf_page_scope(
        self,
        upload: SdkCaptureUpload,
        *,
        client_request_id: str,
        page_numbers: tuple[int, ...],
    ) -> CaptureOperation:
        """Use the SDK transport seam while adding the 0.4.2 page-scope field.

        The published 0.4.2 SDK validates the generated StartCaptureV2 model,
        but its convenience upload method predates ``pdfPageNumbers``. Keep
        discovery, authentication, retries, and response decoding in that SDK;
        this narrow compatibility path only supplies the optional request
        member needed by the Phase 1 page-one acceptance journey.
        """

        request = getattr(self._sdk, "_request", None)
        if not callable(request):
            raise CaptureRuntimeCompatibilityError(
                "Capture Runtime SDK does not expose the v2 request seam required for PDF page scope."
            )
        decode_model = _decode_model
        content = upload.content
        digest = hashlib.sha256(content).hexdigest()
        ingestion = decode_model(
            request(
                "POST",
                "/v2/ingestions",
                headers={"X-Idempotency-Key": f"{client_request_id}-ingestion"},
                json={
                    "protocolVersion": "2",
                    "kind": CaptureSourceKind(upload.source_kind).value,
                    "mode": "file",
                    "clientRequestId": f"{client_request_id}-ingestion",
                    "fileName": upload.file_name,
                    "mediaType": upload.media_type,
                    "totalBytes": len(content),
                    "sourceSha256": digest,
                },
            ),
            SdkIngestion,
        )
        try:
            chunk_size = min(1024 * 1024, self.get_streaming_capabilities().max_chunk_bytes)
            for offset in range(ingestion.next_offset, len(content), chunk_size):
                chunk = content[offset : offset + chunk_size]
                ingestion = decode_model(
                    request(
                        "PUT",
                        f"/v2/ingestions/{ingestion.ingestion_id}/chunks/{ingestion.next_chunk_index}",
                        headers={
                            "Content-Range": (
                                f"bytes {offset}-{offset + len(chunk) - 1}/{len(content)}"
                            ),
                            "Digest": f"sha-256={hashlib.sha256(chunk).hexdigest()}",
                            "X-Idempotency-Key": (
                                f"{ingestion.ingestion_id}-{ingestion.next_chunk_index}"
                            ),
                        },
                        content=chunk,
                    ),
                    SdkIngestion,
                )
            decode_model(
                request(
                    "POST",
                    f"/v2/ingestions/{ingestion.ingestion_id}/finalize",
                    json={"protocolVersion": "2", "totalBytes": len(content), "sha256": digest},
                ),
                SdkIngestion,
            )
            return decode_model(
                request(
                    "POST",
                    "/v2/captures",
                    headers={"X-Idempotency-Key": client_request_id},
                    json={
                        "protocolVersion": "2",
                        "clientRequestId": client_request_id,
                        "ingestionId": ingestion.ingestion_id,
                        "structuringMode": StructuringMode(upload.structuring_mode).value,
                        "targetLanguage": upload.target_language,
                        "startPolicy": "eager",
                        "pdfPageNumbers": list(page_numbers),
                    },
                ),
                CaptureOperation,
            )
        except Exception:
            transport = getattr(self._sdk, "_transport", None)
            if transport is not None:
                try:
                    transport.request(
                        "DELETE", f"/v2/ingestions/{ingestion.ingestion_id}"
                    )
                except Exception:
                    pass
            raise

    def upload_path(
        self,
        path: Path,
        *,
        source_kind: CaptureSourceKind | str,
        client_request_id: str,
        media_type: str = "application/octet-stream",
        target_language: str | None = None,
    ) -> CaptureOperation:
        return self.start_capture(
            CaptureUpload(path.name, path.read_bytes(), media_type),
            source_kind=source_kind,
            client_request_id=client_request_id,
            target_language=target_language,
        )

    def get_capture(self, capture_id: str) -> CaptureOperation:
        return self._sdk.get_capture(capture_id)

    def capture_events(
        self,
        capture_id: str,
        *,
        last_event_id: str | int | None = None,
        max_reconnects: int | None = None,
        on_activity: Callable[[], None] | None = None,
    ) -> Iterator[CaptureEvent]:
        kwargs: dict[str, object] = {
            "last_event_id": last_event_id,
            "on_activity": on_activity,
        }
        if max_reconnects is not None:
            kwargs["max_reconnects"] = max_reconnects
        return self._sdk.capture_events(
            capture_id,
            **kwargs,
        )

    def get_partial(self, capture_id: str) -> PartialCapture:
        return self._sdk.get_partial(capture_id)

    def get_raw(self, capture_id: str) -> RawCapture:
        return self._sdk.get_raw(capture_id)

    def get_ocr(self, capture_id: str) -> object:
        """Return the runtime-owned schema-3 OCR page projection.

        The 0.4.2 candidate SDK owns decoding and validation of this endpoint.
        Keep the compatibility error explicit while the repository still
        carries the published 0.4.1 dependency pin; a production capture must
        never silently fall back to the legacy raw/embedded path.
        """

        method = getattr(self._sdk, "get_ocr", None)
        if not callable(method):
            raise CaptureRuntimeCompatibilityError(
                "Capture Runtime OCR projection requires the 0.4.2 SDK."
            )
        return method(capture_id)

    def get_result(self, capture_id: str) -> CaptureStreamingResult:
        return self._sdk.get_result(capture_id)

    def open_structuring_session(
        self,
        capture_id: str,
        request: OpenStructuringSession | Mapping[str, object],
        *,
        idempotency_key: UUID | str | None = None,
    ) -> StructuringSession:
        """Open or replay an authenticated typed pull-structuring session."""

        return self._sdk.open_structuring_session(
            capture_id,
            request,
            idempotency_key=idempotency_key,
        )

    def get_structuring_session(self, capture_id: str) -> StructuringSession:
        return self._sdk.get_structuring_session(capture_id)

    def pull_structuring_batch(self, capture_id: str, batch_index: int) -> StructuringBatch:
        return self._sdk.pull_structuring_batch(capture_id, batch_index)

    def submit_structuring_batch(
        self,
        capture_id: str,
        batch_index: int,
        submission: SubmitStructuringBatch | Mapping[str, object],
        *,
        idempotency_key: UUID | str,
    ) -> StructuringSession:
        return self._sdk.submit_structuring_batch(
            capture_id,
            batch_index,
            submission,
            idempotency_key=idempotency_key,
        )

    def report_structuring_failure(
        self,
        capture_id: str,
        *,
        code: str,
        message: str,
        idempotency_key: UUID | str,
    ) -> CaptureOperation:
        return self._sdk.report_structuring_failure(
            capture_id,
            code=code,
            message=message,
            idempotency_key=idempotency_key,
        )

    def cancel_capture(self, capture_id: str) -> CaptureOperation:
        return self._sdk.cancel_capture(capture_id)

    def delete_capture(self, capture_id: str) -> None:
        self._sdk.delete_capture(capture_id)


def _upload_bytes(content: bytes | BinaryIO) -> bytes:
    if isinstance(content, bytes):
        return content
    value = content.read()
    if not isinstance(value, bytes):
        raise TypeError("Capture upload stream must return bytes")
    return value


def _assert_pdf_page_scope(
    source_kind: CaptureSourceKind,
    page_numbers: tuple[int, ...],
) -> None:
    if source_kind is not CaptureSourceKind.PDF:
        raise ValueError("PDF page scope is only valid for PDF captures.")
    if (
        not page_numbers
        or len(page_numbers) > 500
        or any(isinstance(page, bool) or not isinstance(page, int) for page in page_numbers)
        or page_numbers != tuple(range(1, len(page_numbers) + 1))
    ):
        raise ValueError("PDF page numbers must be a non-empty ordered prefix from page one.")


__all__ = [
    "CaptureRuntimeClient",
    "CaptureRuntimeCompatibilityError",
    "CaptureRuntimeError",
    "CaptureRuntimeProtocolError",
    "CaptureStreamingResult",
    "CaptureUpload",
]


def _install_candidate_runtime_ready_decoder() -> None:
    """Route SDK discovery through the 0.4.2 generated readiness model.

    The candidate wheel's public ``contracts.RuntimeReady`` omits the
    generated ``ocrCompute`` member even though the candidate runtime emits
    it. The private discovery function keeps that public class in its module
    global, so replace only that decoder class with Cert's generated host
    model. All transport, contract-hash, and compatibility checks remain in
    the SDK; the wheel itself is never modified or rehashed.
    """

    try:
        import capture_runtime_client._discovery as sdk_discovery
    except ModuleNotFoundError:
        # The repository's 0.4.1 rollback client has no private discovery
        # module and already decodes its legacy readiness shape correctly.
        return

    fields = getattr(sdk_discovery.RuntimeReady, "model_fields", {})
    if "ocr_compute" not in fields:
        sdk_discovery.RuntimeReady = RuntimeReady


def _installation_status_value(installation: RuntimeInstallation) -> object:
    status = getattr(installation, "status", None)
    return getattr(status, "value", status)


def _invalidate_sdk_discovery_cache(sdk: object) -> None:
    """Refresh the SDK's cached discovery after runtime state changes.

    The 0.4.2 candidate exposes this state privately and has no public refresh
    operation. Keep the compatibility seam narrow and a no-op for the pinned
    rollback client if it does not carry the cache attribute.
    """

    if hasattr(sdk, "_discovery"):
        setattr(sdk, "_discovery", None)
