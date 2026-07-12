from __future__ import annotations

from pathlib import Path

import pytest

from cert_prep_backend.api.errors import ProviderUnavailableError
from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.mock_exams import (
    fastflowlm_client,
    fastflowlm_resolver,
)
from cert_prep_backend.domains.mock_exams.fastflowlm_client import FastFlowLMClient


def test_resolver_ignores_path_cwd_and_spoofed_program_files(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    trusted_root = tmp_path / "known-program-files"
    malicious_root = tmp_path / "spoofed-program-files"
    malicious = malicious_root / "flm" / "flm.exe"
    malicious.parent.mkdir(parents=True)
    malicious.write_bytes(b"malicious")
    monkeypatch.chdir(malicious.parent)
    monkeypatch.setenv("PATH", str(malicious.parent))
    monkeypatch.setenv("ProgramFiles", str(malicious_root))
    monkeypatch.setenv("ProgramFiles(x86)", str(malicious_root))
    monkeypatch.setenv("LOCALAPPDATA", str(malicious_root))
    monkeypatch.setattr(fastflowlm_resolver.os, "name", "nt")
    monkeypatch.setattr(
        fastflowlm_resolver,
        "_known_folder_path",
        lambda _folder_id: trusted_root,
    )

    assert fastflowlm_resolver.resolve_fastflowlm_executable() is None
    assert fastflowlm_resolver.resolve_fastflowlm_executable(malicious) is None
    assert not hasattr(fastflowlm_resolver, "subprocess")


def test_resolver_rejects_an_executable_with_unpinned_bytes(tmp_path: Path) -> None:
    executable = tmp_path / "flm.exe"
    executable.write_bytes(b"not the pinned FastFlowLM executable")

    assert (
        fastflowlm_resolver.is_allowlisted_fastflowlm_executable(executable)
        is False
    )


@pytest.mark.parametrize(
    "base_url",
    [
        "https://127.0.0.1:52625/v1",
        "http://localhost:52625/v1",
        "http://[::1]:52625/v1",
        "http://user:password@127.0.0.1:52625/v1",
        "http://127.0.0.1/v1",
        "http://127.0.0.1:0/v1",
        "http://127.0.0.1:52625/",
        "http://127.0.0.1:52625/v1?redirect=https://example.com",
        "http://127.0.0.1:52625/v1#fragment",
        "http://example.com:52625/v1",
    ],
)
def test_settings_reject_noncanonical_fastflowlm_endpoints(
    base_url: str,
    tmp_path: Path,
) -> None:
    with pytest.raises(ValueError, match="must be http://127.0.0.1"):
        Settings(data_dir=tmp_path, fastflowlm_base_url=base_url)


def test_fastflowlm_client_rejects_direct_remote_construction() -> None:
    with pytest.raises(ProviderUnavailableError, match="must be http://127.0.0.1"):
        FastFlowLMClient(
            base_url="https://example.com/v1",
            timeout_seconds=5,
        )


def test_fastflowlm_http_transport_disables_proxies_and_redirects() -> None:
    assert fastflowlm_client._NO_PROXY_HANDLER.proxies == {}
    assert fastflowlm_client._REJECT_REDIRECTS.redirect_request() is None
