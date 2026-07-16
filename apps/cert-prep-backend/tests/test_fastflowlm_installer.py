from __future__ import annotations

import ctypes
from io import BytesIO
import os
from pathlib import Path
import subprocess
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from cert_prep_backend.api.app import create_app
from cert_prep_backend.api.errors import (
    ProviderUnavailableError,
    TermsAcceptanceRequiredError,
)
from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.runtime_installations.fastflowlm import (
    FastFlowLMRuntimeInstaller,
    _StrictGitHubRedirectHandler,
    _terminate_owned_process_tree,
    _verify_fastflowlm_signature_metadata,
    _write_bounded_response,
    download_fastflowlm_installer,
    verify_fastflowlm_authenticode,
    verify_fastflowlm_installer_hash,
)
from cert_prep_backend.domains.runtime_installations.installers import LLMModelInstaller
from cert_prep_backend.domains.runtime_installations.manager import RuntimeInstallationManager
from cert_prep_backend.domains.runtime_installations import wintrust as wintrust_module
from cert_prep_backend.domains.runtime_installations.wintrust import (
    AuthenticodeInspectionError,
    AuthenticodeSignature,
    inspect_authenticode_signature,
    resolve_windows_system_executable,
    windows_system_directory,
)
from cert_prep_contracts.llm import FASTFLOWLM_RUNTIME_TRUST_POLICY, ModelPullProgress
from cert_prep_contracts.runtime import (
    RuntimeInstallationStatus,
    RuntimeRequirementKind,
    RuntimeRequirementSnapshot,
)


AUTH_HEADERS = {"Authorization": "Bearer test-token"}


def test_fastflowlm_runtime_installer_requires_pinned_terms_before_work(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    events: list[str] = []
    settings = Settings(
        data_dir=tmp_path,
        llm_provider="fastflowlm",
        fastflowlm_terms_accepted_version=FASTFLOWLM_RUNTIME_TRUST_POLICY.version,
    )
    installer = FastFlowLMRuntimeInstaller(
        settings,
        downloader=lambda _path: events.append("download"),
        artifact_verifier=lambda _path: events.append("hash"),
        signature_verifier=lambda _path: events.append("signature"),
        installer_runner=lambda _path, _timeout: events.append("execute"),
        executable_resolver=lambda: None,
    )
    monkeypatch.setattr(
        "cert_prep_backend.domains.runtime_installations.fastflowlm.os",
        SimpleNamespace(name="nt"),
    )
    monkeypatch.setattr(
        "cert_prep_backend.domains.runtime_installations.fastflowlm."
        "provider_selection_from_settings",
        lambda current: SimpleNamespace(
            hardware_compatible=True,
            terms_accepted=(
                current.fastflowlm_terms_accepted_version
                == FASTFLOWLM_RUNTIME_TRUST_POLICY.version
                and not current.fastflowlm_terms_declined
            ),
            fallback_reason=None,
            selection_reason="selected",
        ),
    )

    with pytest.raises(TermsAcceptanceRequiredError, match="explicitly accepted"):
        installer.install(lambda _progress: None)

    assert events == []


def test_fastflowlm_runtime_installer_verifies_before_execution(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    events: list[str] = []
    installed = tmp_path / "Program Files" / "flm" / "flm.exe"
    settings = Settings(
        data_dir=tmp_path,
        llm_provider="fastflowlm",
        fastflowlm_terms_accepted_version=FASTFLOWLM_RUNTIME_TRUST_POLICY.version,
    )

    def download(path: Path) -> None:
        events.append("download")
        path.write_bytes(b"installer")

    def run_installer(_path: Path, _timeout: float) -> None:
        events.append("execute")
        installed.parent.mkdir(parents=True)
        installed.write_bytes(b"flm")

    installer = FastFlowLMRuntimeInstaller(
        settings,
        downloader=download,
        artifact_verifier=lambda _path: events.append("hash"),
        signature_verifier=lambda _path: events.append("signature"),
        installer_runner=run_installer,
        executable_resolver=lambda: installed if installed.is_file() else None,
        terms_accepted=lambda: True,
    )
    monkeypatch.setattr(
        "cert_prep_backend.domains.runtime_installations.fastflowlm.os",
        SimpleNamespace(name="nt"),
    )
    monkeypatch.setattr(
        "cert_prep_backend.domains.runtime_installations.fastflowlm."
        "provider_selection_from_settings",
        lambda _settings: SimpleNamespace(
            hardware_compatible=True,
            terms_accepted=True,
            fallback_reason=None,
            selection_reason="selected",
        ),
    )

    result = installer.install(lambda _progress: None)

    assert result == RuntimeInstallationStatus.SUCCEEDED
    assert events == ["download", "hash", "signature", "execute"]


def test_fastflowlm_installer_hash_fails_closed(tmp_path: Path) -> None:
    installer = tmp_path / "flm-setup.exe"
    installer.write_bytes(b"tampered")

    with pytest.raises(ProviderUnavailableError, match="size does not match"):
        verify_fastflowlm_installer_hash(installer)


def test_fastflowlm_installer_rejects_same_size_wrong_hash(tmp_path: Path) -> None:
    installer = tmp_path / "flm-setup.exe"
    with installer.open("wb") as output:
        output.seek(FASTFLOWLM_RUNTIME_TRUST_POLICY.installer_bytes - 1)
        output.write(b"\0")

    with pytest.raises(ProviderUnavailableError, match="checksum does not match"):
        verify_fastflowlm_installer_hash(installer)


@pytest.mark.skipif(
    not os.environ.get("CERT_PREP_FASTFLOWLM_INSTALLER_PROOF"),
    reason="set CERT_PREP_FASTFLOWLM_INSTALLER_PROOF to verify the official artifact",
)
def test_official_fastflowlm_installer_matches_native_trust_policy() -> None:
    installer = Path(os.environ["CERT_PREP_FASTFLOWLM_INSTALLER_PROOF"])

    verify_fastflowlm_installer_hash(installer)
    verify_fastflowlm_authenticode(installer)


@pytest.mark.skipif(
    os.environ.get("CERT_PREP_FASTFLOWLM_DOWNLOAD_PROOF") != "1",
    reason="set CERT_PREP_FASTFLOWLM_DOWNLOAD_PROOF=1 to exercise the official channel",
)
def test_official_fastflowlm_download_channel_is_allowlisted(tmp_path: Path) -> None:
    installer = tmp_path / FASTFLOWLM_RUNTIME_TRUST_POLICY.installer_file_name

    download_fastflowlm_installer(installer)

    verify_fastflowlm_installer_hash(installer)
    verify_fastflowlm_authenticode(installer)


@pytest.mark.parametrize(
    ("signature", "message"),
    [
        (
            AuthenticodeSignature(
                subject=FASTFLOWLM_RUNTIME_TRUST_POLICY.signer_subject,
                thumbprint="0" * 40,
                timestamped=True,
            ),
            "signer is not allowlisted",
        ),
        (
            AuthenticodeSignature(
                subject="FastFlowLM Imposter",
                thumbprint=FASTFLOWLM_RUNTIME_TRUST_POLICY.signer_thumbprint,
                timestamped=True,
            ),
            "signer subject is not allowlisted",
        ),
        (
            AuthenticodeSignature(
                subject=FASTFLOWLM_RUNTIME_TRUST_POLICY.signer_subject,
                thumbprint=FASTFLOWLM_RUNTIME_TRUST_POLICY.signer_thumbprint,
                timestamped=False,
            ),
            "not timestamped",
        ),
    ],
)
def test_fastflowlm_authenticode_metadata_fails_closed(
    signature: AuthenticodeSignature,
    message: str,
) -> None:
    with pytest.raises(ProviderUnavailableError, match=message):
        _verify_fastflowlm_signature_metadata(signature)


def test_fastflowlm_redirect_handler_rejects_non_github_host() -> None:
    handler = _StrictGitHubRedirectHandler()

    with pytest.raises(ProviderUnavailableError, match="untrusted host"):
        handler.redirect_request(
            SimpleNamespace(),
            None,
            302,
            "Found",
            {},
            "https://example.invalid/flm-setup.exe",
        )


def test_fastflowlm_download_rejects_oversized_response(tmp_path: Path) -> None:
    response = _BytesResponse(b"four")

    with pytest.raises(OSError, match="exceeded"):
        _write_bounded_response(
            response,
            tmp_path / "installer.exe",
            expected_bytes=3,
        )


def test_fastflowlm_download_rejects_short_and_bad_length_responses(
    tmp_path: Path,
) -> None:
    short_response = _BytesResponse(b"two")
    bad_length_response = _BytesResponse(b"three")
    bad_length_response.headers = {"Content-Length": "4"}

    with pytest.raises(OSError, match="incomplete"):
        _write_bounded_response(
            short_response,
            tmp_path / "short.exe",
            expected_bytes=4,
        )
    with pytest.raises(OSError, match="Content-Length does not match"):
        _write_bounded_response(
            bad_length_response,
            tmp_path / "bad-length.exe",
            expected_bytes=5,
        )


@pytest.mark.parametrize("verify_result", [0, -1])
def test_wintrust_state_is_closed_on_success_and_failure(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    verify_result: int,
) -> None:
    states: list[int] = []

    def win_verify_trust(_window, _action, trust_data_pointer) -> int:
        trust_data = ctypes.cast(
            trust_data_pointer,
            ctypes.POINTER(wintrust_module._WINTRUST_DATA),
        ).contents
        states.append(trust_data.dwStateAction)
        if trust_data.dwStateAction == wintrust_module._WTD_STATEACTION_VERIFY:
            trust_data.hWVTStateData = 1
            return verify_result
        return 0

    api = wintrust_module._WinTrustApi(
        win_verify_trust=win_verify_trust,
        provider_data_from_state=None,
        signer_from_chain=None,
        cert_from_chain=None,
        cert_get_property=None,
        cert_get_name=None,
    )
    monkeypatch.setattr(wintrust_module, "_load_wintrust_api", lambda: api)
    monkeypatch.setattr(wintrust_module, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(
        wintrust_module,
        "_signature_from_verified_state",
        lambda _api, _state: AuthenticodeSignature(
            subject=FASTFLOWLM_RUNTIME_TRUST_POLICY.signer_subject,
            thumbprint=FASTFLOWLM_RUNTIME_TRUST_POLICY.signer_thumbprint,
            timestamped=True,
        ),
    )
    target = tmp_path / "signed.exe"
    target.write_bytes(b"signed")

    if verify_result == 0:
        inspect_authenticode_signature(target)
    else:
        with pytest.raises(AuthenticodeInspectionError, match="rejected"):
            inspect_authenticode_signature(target)

    assert states == [
        wintrust_module._WTD_STATEACTION_VERIFY,
        wintrust_module._WTD_STATEACTION_CLOSE,
    ]


@pytest.mark.parametrize(
    ("signer_type", "timestamped"),
    [(wintrust_module._SGNR_TYPE_TIMESTAMP, True), (0, False)],
)
def test_wintrust_requires_timestamp_countersigner_type(
    monkeypatch: pytest.MonkeyPatch,
    signer_type: int,
    timestamped: bool,
) -> None:
    main_signer = wintrust_module._CRYPT_PROVIDER_SGNR(
        dwError=0,
        csCounterSigners=1,
    )
    counter_signer = wintrust_module._CRYPT_PROVIDER_SGNR(
        dwSignerType=signer_type,
        dwError=0,
    )
    provider_cert = wintrust_module._CRYPT_PROVIDER_CERT(pCert=1)
    api = wintrust_module._WinTrustApi(
        win_verify_trust=None,
        provider_data_from_state=lambda _state: 1,
        signer_from_chain=lambda _data, _index, counter, _counter_index: (
            ctypes.pointer(counter_signer) if counter else ctypes.pointer(main_signer)
        ),
        cert_from_chain=lambda _signer, _index: ctypes.pointer(provider_cert),
        cert_get_property=None,
        cert_get_name=None,
    )
    monkeypatch.setattr(
        wintrust_module,
        "_certificate_simple_name",
        lambda _api, _cert: FASTFLOWLM_RUNTIME_TRUST_POLICY.signer_subject,
    )
    monkeypatch.setattr(
        wintrust_module,
        "_certificate_sha1_thumbprint",
        lambda _api, _cert: FASTFLOWLM_RUNTIME_TRUST_POLICY.signer_thumbprint,
    )

    signature = wintrust_module._signature_from_verified_state(api, 1)

    assert signature.timestamped is timestamped


@pytest.mark.skipif(os.name != "nt", reason="native Windows system path probe")
def test_windows_system_executables_ignore_environment_roots(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("SystemRoot", str(tmp_path))
    monkeypatch.setenv("WINDIR", str(tmp_path))

    system_directory = windows_system_directory()
    taskkill = resolve_windows_system_executable("taskkill.exe")

    assert system_directory != tmp_path
    assert taskkill == system_directory / "taskkill.exe"
    assert taskkill.is_absolute()


def test_installer_timeout_uses_absolute_taskkill_and_waits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    taskkill = Path(r"C:\Windows\System32\taskkill.exe")
    process = _OwnedProcess()
    commands: list[list[str]] = []
    monkeypatch.setattr(
        "cert_prep_backend.domains.runtime_installations.fastflowlm.os",
        SimpleNamespace(name="nt"),
    )
    monkeypatch.setattr(
        "cert_prep_backend.domains.runtime_installations.fastflowlm."
        "resolve_windows_system_executable",
        lambda _name: taskkill,
    )
    monkeypatch.setattr(
        "cert_prep_backend.domains.runtime_installations.fastflowlm.subprocess.run",
        lambda command, **_kwargs: (
            commands.append(command) or subprocess.CompletedProcess(command, 0)
        ),
    )

    _terminate_owned_process_tree(process)

    assert commands == [[str(taskkill), "/PID", "42", "/T", "/F"]]
    assert process.wait_calls == [15]
    assert process.killed is False


def test_installer_timeout_fails_closed_when_taskkill_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = _OwnedProcess()
    monkeypatch.setattr(
        "cert_prep_backend.domains.runtime_installations.fastflowlm.os",
        SimpleNamespace(name="nt"),
    )
    monkeypatch.setattr(
        "cert_prep_backend.domains.runtime_installations.fastflowlm."
        "resolve_windows_system_executable",
        lambda _name: Path(r"C:\Windows\System32\taskkill.exe"),
    )
    monkeypatch.setattr(
        "cert_prep_backend.domains.runtime_installations.fastflowlm.subprocess.run",
        lambda command, **_kwargs: subprocess.CompletedProcess(command, 1),
    )

    with pytest.raises(ProviderUnavailableError, match="could not be terminated cleanly"):
        _terminate_owned_process_tree(process)

    assert process.killed is True
    assert process.wait_calls == [5]


def test_fastflowlm_model_installer_requires_pinned_terms() -> None:
    provider = _ModelProvider()
    accepted = False
    installer = LLMModelInstaller(
        provider,
        fastflowlm_terms_accepted=lambda: accepted,
    )

    with pytest.raises(TermsAcceptanceRequiredError, match="explicitly accepted"):
        installer.install(lambda _progress: None)
    assert provider.pull_calls == 0

    accepted = True
    assert installer.install(lambda _progress: None) == RuntimeInstallationStatus.SUCCEEDED
    assert provider.pull_calls == 1


def test_runtime_endpoint_reports_versioned_terms_requirement(tmp_path: Path) -> None:
    manager = RuntimeInstallationManager(
        settings=Settings(data_dir=tmp_path, api_token="test-token"),
        llm_provider=object(),
        ocr_provider=_OcrProvider(),
        installers=[_TermsBlockedInstaller()],
        async_jobs=False,
    )
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            runtime_installation_manager=manager,
        )
    )

    response = client.post(
        "/runtime/installations/fastflowlm",
        headers=AUTH_HEADERS,
        json={"fastflowlm_terms_accepted_version": "0.9.43"},
    )

    assert response.status_code == 409
    assert response.json() == {
        "code": "terms_acceptance_required",
        "message": "FastFlowLM terms must be explicitly accepted.",
        "details": {
            "terms_version": FASTFLOWLM_RUNTIME_TRUST_POLICY.version,
            "terms_url": FASTFLOWLM_RUNTIME_TRUST_POLICY.terms_url,
        },
    }


class _ModelProvider:
    provider = "fastflowlm"
    model = "qwen3.5:4b"

    def __init__(self) -> None:
        self.pull_calls = 0

    def health(self):
        return SimpleNamespace(available=False, detail="model missing", unavailable_reason=None)

    def pull_model(self, progress) -> None:
        self.pull_calls += 1
        progress(ModelPullProgress(status="complete", completed=1, total=1))


class _BytesResponse(BytesIO):
    headers: dict[str, str] = {}


class _OwnedProcess:
    pid = 42

    def __init__(self) -> None:
        self.wait_calls: list[int] = []
        self.killed = False

    def poll(self):
        return None

    def wait(self, timeout: int) -> int:
        self.wait_calls.append(timeout)
        return 0

    def kill(self) -> None:
        self.killed = True


class _OcrProvider:
    provider = "fake"


class _TermsBlockedInstaller:
    kind = RuntimeRequirementKind.FASTFLOWLM
    provider = "fastflowlm"
    model = ""

    def requirement(self) -> RuntimeRequirementSnapshot:
        return RuntimeRequirementSnapshot(
            kind=self.kind,
            label="FastFlowLM",
            available=False,
            detail="terms required",
            unavailable_reason="fastflowlm_terms_required",
        )

    def validate_installable(self) -> None:
        raise TermsAcceptanceRequiredError(
            "FastFlowLM terms must be explicitly accepted."
        )

    def install(self, _progress) -> RuntimeInstallationStatus:
        raise AssertionError("installation must not start")
