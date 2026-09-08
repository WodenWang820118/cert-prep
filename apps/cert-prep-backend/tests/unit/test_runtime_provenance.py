from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from cert_prep_backend.domains.capture_workbench.runtime_provenance import (
    capture_runtime_attestation,
    load_packaged_provenance,
)


def _candidate() -> dict[str, object]:
    return {
        "schema_version": 1,
        "status": "bound",
        "runtime_version": "0.4.2",
        "runtime_core_sha256": "a" * 64,
        "runtime_core_bytes": 12,
        "runtime_manifest_identity_sha256": "b" * 64,
        "worker_archive_sha256": "c" * 64,
        "worker_archive_bytes": 34,
        "worker_executable_sha256": "d" * 64,
        "contract_set_sha256": "e" * 64,
        "python_wheel": {
            "file_name": "capture_runtime_client-0.4.2-py3-none-any.whl",
            "sha256": "f" * 64,
            "bytes": 56,
            "package_name": "capture-runtime-client",
            "package_version": "0.4.2",
            "contract_set_sha256": "e" * 64,
            "generated_models": {
                "worker_sha256": True,
                "pdf_page_numbers": True,
            },
        },
    }


def test_packaged_provenance_is_hash_only_and_validated(tmp_path, monkeypatch) -> None:
    path = tmp_path / "capture-runtime-provenance.json"
    path.write_text(json.dumps(_candidate()), encoding="utf-8")
    monkeypatch.setenv("CERT_PREP_CAPTURE_RUNTIME_PROVENANCE_FILE", str(path))

    loaded = load_packaged_provenance()

    assert loaded["status"] == "bound"
    assert loaded["runtime_core_sha256"] == "a" * 64
    assert "path" not in loaded


def test_runtime_attestation_combines_candidate_and_live_handshake(tmp_path, monkeypatch) -> None:
    path = tmp_path / "capture-runtime-provenance.json"
    path.write_text(json.dumps(_candidate()), encoding="utf-8")
    monkeypatch.setenv("CERT_PREP_CAPTURE_RUNTIME_PROVENANCE_FILE", str(path))
    client = SimpleNamespace(
        handshake=lambda: SimpleNamespace(
            ready=True,
            runtime_version="0.4.2",
            api_version="2.0",
            capture_document_schema_version="2",
            ocr_compute=SimpleNamespace(
                contract_sha256="e" * 64,
                worker_sha256="d" * 64,
                mode="gpu-dml",
            ),
        )
    )

    attestation = capture_runtime_attestation(client)  # type: ignore[arg-type]

    assert attestation["schema_version"] == 1
    assert attestation["candidate"]["worker_archive_sha256"] == "c" * 64
    assert attestation["observed"]["worker_executable_sha256"] == "d" * 64


def test_unbound_or_incomplete_provenance_fails_closed(tmp_path, monkeypatch) -> None:
    path = tmp_path / "capture-runtime-provenance.json"
    path.write_text(json.dumps({"schema_version": 1, "status": "unbound"}), encoding="utf-8")
    monkeypatch.setenv("CERT_PREP_CAPTURE_RUNTIME_PROVENANCE_FILE", str(path))

    with pytest.raises(RuntimeError, match="not candidate-bound"):
        load_packaged_provenance()
