"""Synchronous backend-only client for the local Capture Runtime sidecar."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
from typing import BinaryIO, Mapping
from urllib.parse import urlsplit
from uuid import UUID

import httpx
from pydantic import ValidationError

from cert_prep_backend.domains.capture_workbench.contracts import (
    CAPTURE_DOCUMENT_SCHEMA_VERSION,
    SUPPORTED_API_MAJOR,
    SUPPORTED_RUNTIME_MAJOR,
    CaptureDocumentV1,
    CaptureJobV1,
    CaptureRequirementId,
    CaptureSourceKind,
    ErrorEnvelopeV1,
    RawCaptureV1,
    RuntimeInstallationV1,
    RuntimeInstallationsV1,
    RuntimeReadyV1,
    RuntimeRequirementsV1,
    StructuringMode,
)


_VERSION = re.compile(
    r"^(?P<major>0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))?(?:[-+].*)?$"
)


class CaptureRuntimeError(RuntimeError):
    """Machine-readable sidecar error without credentials in its representation."""

    def __init__(
        self,
        *,
        status_code: int,
        code: str,
        message: str,
        details: dict[str, object] | None = None,
    ) -> None:
        super().__init__(f"Capture Runtime request failed ({code}): {message}")
        self.status_code = status_code
        self.code = code
        self.runtime_message = message
        self.details = details


class CaptureRuntimeProtocolError(RuntimeError):
    """The sidecar returned a response outside the pinned v1 wire contract."""


class CaptureRuntimeCompatibilityError(RuntimeError):
    """The sidecar is healthy but incompatible with this host client."""


@dataclass(frozen=True, slots=True)
class CaptureUpload:
    file_name: str
    content: bytes | BinaryIO
    media_type: str = "application/octet-stream"


class CaptureRuntimeClient:
    """Keep the process-scoped sidecar credential inside the Cert Prep backend."""

    def __init__(
        self,
        *,
        base_url: str,
        bearer_token: str,
        timeout_seconds: float = 30,
        client: httpx.Client | None = None,
    ) -> None:
        self._base_url = _validated_loopback_base_url(base_url)
        if not bearer_token.strip():
            raise ValueError("Capture Runtime bearer token must not be empty")
        self._bearer_token = bearer_token
        self._client = client or httpx.Client(timeout=timeout_seconds, follow_redirects=False)
        self._owns_client = client is None

    def __repr__(self) -> str:
        return f"{type(self).__name__}(base_url={self._base_url!r})"

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> CaptureRuntimeClient:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def handshake(self) -> RuntimeReadyV1:
        ready = self._model_response(
            self._request("GET", "/v1/health/ready"), RuntimeReadyV1
        )
        _assert_compatible(ready)
        return ready

    def get_requirements(self) -> RuntimeRequirementsV1:
        return self._model_response(
            self._request("GET", "/v1/runtime/requirements"), RuntimeRequirementsV1
        )

    def start_installation(
        self,
        requirement_id: CaptureRequirementId,
        *,
        idempotency_key: UUID,
    ) -> RuntimeInstallationV1:
        return self._model_response(
            self._request(
                "POST",
                "/v1/runtime/installations",
                headers={"X-Idempotency-Key": str(idempotency_key)},
                json={"requirementId": requirement_id, "consent": True},
            ),
            RuntimeInstallationV1,
        )

    def list_installations(self) -> RuntimeInstallationsV1:
        return self._model_response(
            self._request("GET", "/v1/runtime/installations"), RuntimeInstallationsV1
        )

    def get_installation(self, installation_id: str) -> RuntimeInstallationV1:
        return self._model_response(
            self._request("GET", f"/v1/runtime/installations/{installation_id}"),
            RuntimeInstallationV1,
        )

    def cancel_installation(self, installation_id: str) -> RuntimeInstallationV1:
        return self._model_response(
            self._request(
                "POST", f"/v1/runtime/installations/{installation_id}/cancel"
            ),
            RuntimeInstallationV1,
        )

    def create_capture(
        self,
        upload: CaptureUpload,
        *,
        source_kind: CaptureSourceKind,
        idempotency_key: UUID,
        target_language: str | None = None,
    ) -> CaptureJobV1:
        data = {
            "sourceKind": source_kind.value,
            "structuringMode": StructuringMode.HOST.value,
        }
        if target_language is not None:
            data["targetLanguage"] = target_language
        response = self._request(
            "POST",
            "/v1/captures",
            headers={"X-Idempotency-Key": str(idempotency_key)},
            data=data,
            files={
                "file": (upload.file_name, upload.content, upload.media_type),
            },
        )
        return self._model_response(response, CaptureJobV1)

    def upload_path(
        self,
        path: Path,
        *,
        source_kind: CaptureSourceKind,
        idempotency_key: UUID,
        media_type: str = "application/octet-stream",
        target_language: str | None = None,
    ) -> CaptureJobV1:
        with path.open("rb") as stream:
            return self.create_capture(
                CaptureUpload(path.name, stream, media_type),
                source_kind=source_kind,
                idempotency_key=idempotency_key,
                target_language=target_language,
            )

    def get_capture(self, capture_id: str) -> CaptureJobV1:
        return self._model_response(
            self._request("GET", f"/v1/captures/{capture_id}"), CaptureJobV1
        )

    def get_raw(self, capture_id: str) -> RawCaptureV1:
        return self._model_response(
            self._request("GET", f"/v1/captures/{capture_id}/raw"), RawCaptureV1
        )

    def get_result(self, capture_id: str) -> CaptureDocumentV1:
        return self._model_response(
            self._request("GET", f"/v1/captures/{capture_id}/result"), CaptureDocumentV1
        )

    def commit_structure(
        self,
        capture_id: str,
        candidate: str | bytes | Mapping[str, object],
        *,
        idempotency_key: UUID,
    ) -> CaptureJobV1:
        headers = {
            "Content-Type": "application/json",
            "X-Idempotency-Key": str(idempotency_key),
        }
        request_body: dict[str, object]
        if isinstance(candidate, Mapping):
            request_body = {"json": dict(candidate)}
        else:
            request_body = {
                "content": candidate.encode("utf-8") if isinstance(candidate, str) else candidate
            }
        response = self._request(
            "POST",
            f"/v1/captures/{capture_id}/structure",
            headers=headers,
            **request_body,
        )
        return self._model_response(response, CaptureJobV1)

    def report_structuring_failure(
        self,
        capture_id: str,
        *,
        code: str,
        message: str,
    ) -> CaptureJobV1:
        return self._model_response(
            self._request(
                "POST",
                f"/v1/captures/{capture_id}/structuring-failure",
                json={"code": code, "message": message},
            ),
            CaptureJobV1,
        )

    def cancel_capture(self, capture_id: str) -> CaptureJobV1:
        return self._model_response(
            self._request("POST", f"/v1/captures/{capture_id}/cancel"), CaptureJobV1
        )

    def delete_capture(self, capture_id: str) -> None:
        response = self._request("DELETE", f"/v1/captures/{capture_id}")
        if response.status_code != 204 or response.content:
            raise CaptureRuntimeProtocolError(
                "Capture Runtime delete response must be an empty HTTP 204"
            )

    def _request(self, method: str, path: str, **kwargs: object) -> httpx.Response:
        request_headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self._bearer_token}",
            **dict(kwargs.pop("headers", {})),
        }
        response = self._client.request(
            method,
            f"{self._base_url}{path}",
            headers=request_headers,
            follow_redirects=False,
            **kwargs,
        )
        if response.is_error:
            raise _runtime_error(response)
        return response

    @staticmethod
    def _model_response(response: httpx.Response, model_type):
        try:
            return model_type.model_validate_json(response.content)
        except (ValidationError, ValueError) as error:
            raise CaptureRuntimeProtocolError(
                f"Capture Runtime returned invalid {model_type.__name__}"
            ) from error


def _validated_loopback_base_url(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "http"
        or parsed.hostname != "127.0.0.1"
        or parsed.port is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise ValueError(
            "Capture Runtime URL must be an HTTP 127.0.0.1 authority with an explicit port"
        )
    return f"http://127.0.0.1:{parsed.port}"


def _runtime_error(response: httpx.Response) -> CaptureRuntimeError:
    try:
        envelope = ErrorEnvelopeV1.model_validate_json(response.content)
    except (ValidationError, ValueError):
        return CaptureRuntimeError(
            status_code=response.status_code,
            code="invalid_error_response",
            message="Capture Runtime returned an invalid error envelope.",
        )
    return CaptureRuntimeError(
        status_code=response.status_code,
        code=envelope.error.code,
        message=envelope.error.message,
        details=envelope.error.details,
    )


def _major(version: str, *, label: str) -> int:
    match = _VERSION.fullmatch(version)
    if match is None:
        raise CaptureRuntimeCompatibilityError(f"{label} version is not semantic: {version!r}")
    return int(match.group("major"))


def _assert_compatible(ready: RuntimeReadyV1) -> None:
    failures: list[str] = []
    if not ready.ready:
        failures.append("runtime is not ready")
    if _major(ready.api_version, label="API") != SUPPORTED_API_MAJOR:
        failures.append(f"API major {ready.api_version} is unsupported")
    if _major(ready.runtime_version, label="runtime") != SUPPORTED_RUNTIME_MAJOR:
        failures.append(f"runtime major {ready.runtime_version} is unsupported")
    if ready.capture_document_schema_version != CAPTURE_DOCUMENT_SCHEMA_VERSION:
        failures.append(
            "CaptureDocument schema "
            f"{ready.capture_document_schema_version} is unsupported"
        )
    if StructuringMode.HOST not in ready.capabilities.structuring_modes:
        failures.append("host structuring mode is unavailable")
    if failures:
        raise CaptureRuntimeCompatibilityError("; ".join(failures))


__all__ = [
    "CaptureRuntimeClient",
    "CaptureRuntimeCompatibilityError",
    "CaptureRuntimeError",
    "CaptureRuntimeProtocolError",
    "CaptureUpload",
]
