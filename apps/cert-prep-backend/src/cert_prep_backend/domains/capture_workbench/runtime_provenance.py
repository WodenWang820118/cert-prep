"""Privacy-safe provenance for an installed Capture Runtime sidecar.

The desktop acceptance boundary must be able to distinguish a real packaged
backend from a source checkout or a stale same-version wheel.  The build step
embeds a hash-only candidate tuple in the backend executable.  This module
combines that immutable build tuple with a live authenticated Capture Runtime
handshake; it never returns local paths, bearer tokens, or source text.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any

from cert_prep_backend.domains.capture_workbench.client import CaptureRuntimeClient


PROVENANCE_FILE_NAME = "capture-runtime-provenance.json"
_SHA256_LENGTH = 64


def capture_runtime_attestation(client: CaptureRuntimeClient) -> dict[str, Any]:
    """Return the packaged candidate tuple plus one live runtime observation."""

    candidate = load_packaged_provenance()
    ready = client.handshake()
    compute = ready.ocr_compute
    if not ready.ready or compute is None:
        raise RuntimeError("Capture Runtime did not expose OCR readiness provenance.")
    if compute.worker_sha256 is None:
        raise RuntimeError("Capture Runtime OCR readiness omitted worker provenance.")

    return {
        "schema_version": 1,
        "candidate": candidate,
        "observed": {
            "ready": True,
            "runtime_version": ready.runtime_version,
            "api_version": ready.api_version,
            "capture_document_schema_version": ready.capture_document_schema_version,
            "contract_set_sha256": compute.contract_sha256,
            "worker_executable_sha256": compute.worker_sha256,
            "mode": compute.mode,
        },
    }


def load_packaged_provenance() -> dict[str, Any]:
    """Load and validate the hash-only tuple embedded by the backend build.

    A source process may opt into an explicit test file.  Frozen/installed
    processes deliberately ignore that override and only inspect PyInstaller's
    extracted bundle directory, so an acceptance run cannot redirect the
    installed app to a checkout artifact through its environment.
    """

    candidates: list[Path] = []
    if not getattr(sys, "frozen", False):
        override = os.environ.get("CERT_PREP_CAPTURE_RUNTIME_PROVENANCE_FILE", "").strip()
        if override:
            candidates.append(Path(override))
    meipass = getattr(sys, "_MEIPASS", None)
    if isinstance(meipass, str) and meipass.strip():
        root = Path(meipass)
        candidates.extend(
            [
                root / "cert_prep_backend" / PROVENANCE_FILE_NAME,
                root / PROVENANCE_FILE_NAME,
            ]
        )
    package_root = Path(__file__).resolve().parent
    candidates.append(package_root / PROVENANCE_FILE_NAME)

    for path in candidates:
        if not path.is_file():
            continue
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise RuntimeError("Packaged Capture Runtime provenance is invalid.") from error
        return _validate_candidate(value)
    raise RuntimeError("Packaged Capture Runtime provenance is unavailable.")


def _validate_candidate(value: object) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("schema_version") != 1:
        raise RuntimeError("Packaged Capture Runtime provenance is invalid.")
    if value.get("status") != "bound":
        raise RuntimeError("Packaged Capture Runtime provenance is not candidate-bound.")
    if value.get("runtime_version") != "0.4.2":
        raise RuntimeError("Packaged Capture Runtime provenance runtime version is invalid.")
    for key in (
        "runtime_core_sha256",
        "runtime_manifest_identity_sha256",
        "worker_archive_sha256",
        "worker_executable_sha256",
        "contract_set_sha256",
    ):
        _require_digest(value.get(key), key)
    for key in ("runtime_core_bytes", "worker_archive_bytes"):
        raw = value.get(key)
        if not isinstance(raw, int) or isinstance(raw, bool) or raw <= 0:
            raise RuntimeError(f"Packaged Capture Runtime provenance field {key} is invalid.")

    wheel = value.get("python_wheel")
    if not isinstance(wheel, dict):
        raise RuntimeError("Packaged Capture Runtime provenance omitted Python wheel identity.")
    for key in ("sha256", "contract_set_sha256"):
        _require_digest(wheel.get(key), f"python_wheel.{key}")
    if wheel.get("package_name") != "capture-runtime-client" or wheel.get(
        "package_version"
    ) != "0.4.2":
        raise RuntimeError("Packaged Capture Runtime Python wheel identity is invalid.")
    wheel_bytes = wheel.get("bytes")
    if not isinstance(wheel_bytes, int) or isinstance(wheel_bytes, bool) or wheel_bytes <= 0:
        raise RuntimeError("Packaged Capture Runtime Python wheel byte count is invalid.")
    generated = wheel.get("generated_models")
    if not isinstance(generated, dict) or generated.get("worker_sha256") is not True or generated.get(
        "pdf_page_numbers"
    ) is not True:
        raise RuntimeError("Packaged Capture Runtime Python wheel generated models are incomplete.")

    # Return a fresh object with only the public, path-free fields.  This keeps
    # future build metadata from accidentally becoming an API disclosure.
    return {
        "schema_version": 1,
        "status": "bound",
        "runtime_version": str(value["runtime_version"]),
        "runtime_core_sha256": str(value["runtime_core_sha256"]),
        "runtime_core_bytes": int(value["runtime_core_bytes"]),
        "runtime_manifest_identity_sha256": str(value["runtime_manifest_identity_sha256"]),
        "worker_archive_sha256": str(value["worker_archive_sha256"]),
        "worker_archive_bytes": int(value["worker_archive_bytes"]),
        "worker_executable_sha256": str(value["worker_executable_sha256"]),
        "contract_set_sha256": str(value["contract_set_sha256"]),
        "python_wheel": {
            "file_name": str(wheel.get("file_name", "")),
            "sha256": str(wheel["sha256"]),
            "bytes": int(wheel_bytes),
            "package_name": "capture-runtime-client",
            "package_version": "0.4.2",
            "contract_set_sha256": str(wheel["contract_set_sha256"]),
            "generated_models": {
                "worker_sha256": True,
                "pdf_page_numbers": True,
            },
        },
    }


def _require_digest(value: object, label: str) -> None:
    if not isinstance(value, str) or len(value) != _SHA256_LENGTH:
        raise RuntimeError(f"Packaged Capture Runtime provenance field {label} is invalid.")
    try:
        int(value, 16)
    except ValueError as error:
        raise RuntimeError(f"Packaged Capture Runtime provenance field {label} is invalid.") from error


def sha256_bytes(value: bytes) -> str:
    """Small helper shared by the build-time provenance generator and tests."""

    return hashlib.sha256(value).hexdigest()


__all__ = ["capture_runtime_attestation", "load_packaged_provenance"]
