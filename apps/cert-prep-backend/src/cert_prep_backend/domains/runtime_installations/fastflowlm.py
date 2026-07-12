from __future__ import annotations

from collections.abc import Callable
import hashlib
import hmac
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import (
    HTTPRedirectHandler,
    OpenerDirector,
    ProxyHandler,
    Request,
    build_opener,
)

from cert_prep_backend.api.errors import (
    ProviderUnavailableError,
    TermsAcceptanceRequiredError,
)
from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.mock_exams.fastflowlm_resolver import (
    resolve_fastflowlm_executable,
)
from cert_prep_backend.domains.mock_exams.fastflowlm_process import (
    terminate_fastflowlm_process_tree,
)
from cert_prep_backend.domains.mock_exams.provider_selection import (
    provider_selection_from_settings,
)
from cert_prep_backend.domains.runtime_installations.wintrust import (
    AuthenticodeInspectionError,
    AuthenticodeSignature,
    inspect_authenticode_signature,
)
from cert_prep_contracts.llm import FASTFLOWLM_RUNTIME_TRUST_POLICY
from cert_prep_contracts.runtime import (
    RuntimeInstallationStatus,
    RuntimeInstallProgress,
    RuntimeRequirementKind,
    RuntimeRequirementSnapshot,
)


_CONNECT_TIMEOUT_SECONDS = 15
_READ_IDLE_TIMEOUT_SECONDS = 60
_MAX_DOWNLOAD_ATTEMPTS = 5
_RETRY_BACKOFF_SECONDS = (1, 2, 4, 8)
_DOWNLOAD_CHUNK_BYTES = 1024 * 1024
_ALLOWED_REDIRECT_HOSTS = frozenset(
    {
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
    }
)


class FastFlowLMRuntimeInstaller:
    """Install only the pinned official FastFlowLM Windows artifact."""

    kind = RuntimeRequirementKind.FASTFLOWLM
    provider = "fastflowlm"
    model = ""

    def __init__(
        self,
        settings: Settings,
        *,
        downloader: Callable[[Path], None] | None = None,
        artifact_verifier: Callable[[Path], None] | None = None,
        signature_verifier: Callable[[Path], None] | None = None,
        installer_runner: Callable[[Path, float], None] | None = None,
        executable_resolver: Callable[[], Path | None] | None = None,
        terms_accepted: Callable[[], bool] | None = None,
    ) -> None:
        self._settings = settings
        self._download = downloader or download_fastflowlm_installer
        self._verify_artifact = artifact_verifier or verify_fastflowlm_installer_hash
        self._verify_signature = signature_verifier or verify_fastflowlm_authenticode
        self._run_installer = installer_runner
        self._resolve_executable = executable_resolver or (
            lambda: resolve_fastflowlm_executable(settings.fastflowlm_executable_path)
        )
        self._terms_accepted = terms_accepted or (lambda: False)

    def requirement(self) -> RuntimeRequirementSnapshot:
        executable = self._resolve_executable()
        if executable is not None:
            return RuntimeRequirementSnapshot(
                kind=self.kind,
                label="FastFlowLM",
                available=True,
                detail=f"FastFlowLM {FASTFLOWLM_RUNTIME_TRUST_POLICY.version} is installed.",
                unavailable_reason=None,
                version=FASTFLOWLM_RUNTIME_TRUST_POLICY.version,
                bytes=FASTFLOWLM_RUNTIME_TRUST_POLICY.installer_bytes,
                installed_path=str(executable),
            )

        selection = provider_selection_from_settings(self._settings)
        detail = "FastFlowLM is not installed."
        reason = "fastflowlm_missing"
        if not selection.hardware_compatible:
            detail = selection.fallback_reason or selection.selection_reason
            reason = "fastflowlm_hardware_incompatible"
        elif not self._terms_accepted():
            detail = "FastFlowLM terms must be accepted before installation."
            reason = "fastflowlm_terms_required"
        return RuntimeRequirementSnapshot(
            kind=self.kind,
            label="FastFlowLM",
            available=False,
            detail=detail,
            unavailable_reason=reason,
            version=FASTFLOWLM_RUNTIME_TRUST_POLICY.version,
            bytes=FASTFLOWLM_RUNTIME_TRUST_POLICY.installer_bytes,
        )

    def validate_installable(self) -> None:
        selection = provider_selection_from_settings(self._settings)
        if os.name != "nt":
            raise ProviderUnavailableError(
                "FastFlowLM installer automation is only supported on Windows."
            )
        if not selection.hardware_compatible:
            raise ProviderUnavailableError(
                selection.fallback_reason or selection.selection_reason
            )
        if not self._terms_accepted():
            raise TermsAcceptanceRequiredError(
                "FastFlowLM terms must be explicitly accepted before installation."
            )

    def install(
        self,
        progress: Callable[[RuntimeInstallProgress], None],
    ) -> RuntimeInstallationStatus:
        self.validate_installable()
        policy = FASTFLOWLM_RUNTIME_TRUST_POLICY
        with TemporaryDirectory(prefix="cert-prep-fastflowlm-") as temp_name:
            installer = Path(temp_name) / policy.installer_file_name
            progress(
                RuntimeInstallProgress(
                    f"Downloading FastFlowLM {policy.version} from its official release.",
                    total=policy.installer_bytes,
                )
            )
            self._download(installer)
            progress(
                RuntimeInstallProgress(
                    "Verifying FastFlowLM checksum and Authenticode signature.",
                    completed=policy.installer_bytes,
                    total=policy.installer_bytes,
                )
            )
            self._verify_artifact(installer)
            self._verify_signature(installer)
            progress(RuntimeInstallProgress("Starting the verified FastFlowLM installer."))
            if self._run_installer is None:
                self._run_owned_installer(
                    installer,
                    self._settings.runtime_install_timeout_seconds,
                )
            else:
                self._run_installer(installer, self._settings.runtime_install_timeout_seconds)

        executable = self._resolve_executable()
        if executable is None:
            return RuntimeInstallationStatus.WAITING_FOR_USER
        progress(RuntimeInstallProgress("FastFlowLM is installed."))
        return RuntimeInstallationStatus.SUCCEEDED

    def _run_owned_installer(self, installer: Path, timeout_seconds: float) -> None:
        process = subprocess.Popen(
            [
                str(installer),
                "/VERYSILENT",
                "/SUPPRESSMSGBOXES",
                "/NORESTART",
                "/SP-",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        try:
            stdout, stderr = process.communicate(timeout=max(60.0, timeout_seconds))
        except subprocess.TimeoutExpired as exc:
            terminate_fastflowlm_process_tree(process)
            raise ProviderUnavailableError("FastFlowLM installer timed out.") from exc
        if process.returncode != 0:
            detail = (stderr or stdout or "").strip()
            raise ProviderUnavailableError(detail or "FastFlowLM installer failed.")


def download_fastflowlm_installer(
    destination: Path,
    *,
    opener: OpenerDirector | None = None,
    sleeper: Callable[[float], None] = time.sleep,
) -> None:
    """Download the exact official installer without ambient proxy routing."""

    policy = FASTFLOWLM_RUNTIME_TRUST_POLICY
    _validate_fastflowlm_download_url(policy.installer_url, initial=True)
    destination.parent.mkdir(parents=True, exist_ok=True)
    trusted_opener = opener or build_opener(
        ProxyHandler({}),
        _StrictGitHubRedirectHandler(),
    )
    last_error: BaseException | None = None
    for attempt in range(_MAX_DOWNLOAD_ATTEMPTS):
        request = Request(
            policy.installer_url,
            headers={
                "Accept": "application/octet-stream",
                "User-Agent": "cert-prep/0.1.0-alpha.1",
            },
        )
        try:
            with trusted_opener.open(
                request,
                timeout=_CONNECT_TIMEOUT_SECONDS,
            ) as response:
                _validate_fastflowlm_download_url(response.geturl(), initial=False)
                _set_read_idle_timeout(response)
                status_code = int(getattr(response, "status", response.getcode()))
                if status_code != 200:
                    raise OSError(f"FastFlowLM release returned HTTP {status_code}.")
                _write_bounded_response(
                    response,
                    destination,
                    expected_bytes=policy.installer_bytes,
                )
            return
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            last_error = exc
            destination.unlink(missing_ok=True)
            if attempt < _MAX_DOWNLOAD_ATTEMPTS - 1:
                sleeper(_RETRY_BACKOFF_SECONDS[attempt])
    raise ProviderUnavailableError(
        f"FastFlowLM installer download failed after {_MAX_DOWNLOAD_ATTEMPTS} attempts: "
        f"{last_error}"
    ) from last_error


def verify_fastflowlm_installer_hash(installer: Path) -> None:
    """Fail closed unless installer bytes and SHA-256 match the shared policy."""

    policy = FASTFLOWLM_RUNTIME_TRUST_POLICY
    try:
        actual_bytes = installer.stat().st_size
    except OSError as exc:
        raise ProviderUnavailableError("FastFlowLM installer was not downloaded.") from exc
    if actual_bytes != policy.installer_bytes:
        raise ProviderUnavailableError("FastFlowLM installer size does not match the allowlist.")
    digest = hashlib.sha256()
    with installer.open("rb") as source:
        for chunk in iter(lambda: source.read(_DOWNLOAD_CHUNK_BYTES), b""):
            digest.update(chunk)
    if not hmac.compare_digest(digest.hexdigest(), policy.installer_sha256.casefold()):
        raise ProviderUnavailableError("FastFlowLM installer checksum does not match the allowlist.")


def verify_fastflowlm_authenticode(installer: Path) -> None:
    """Fail closed unless native WinVerifyTrust metadata matches the pinned signer."""

    try:
        signature = inspect_authenticode_signature(installer)
    except AuthenticodeInspectionError as exc:
        raise ProviderUnavailableError(str(exc)) from exc
    _verify_fastflowlm_signature_metadata(signature)


def _verify_fastflowlm_signature_metadata(signature: AuthenticodeSignature) -> None:
    policy = FASTFLOWLM_RUNTIME_TRUST_POLICY
    if not hmac.compare_digest(
        _normalize_thumbprint(signature.thumbprint),
        policy.signer_thumbprint,
    ):
        raise ProviderUnavailableError("FastFlowLM installer signer is not allowlisted.")
    if not hmac.compare_digest(
        _normalize_subject(signature.subject),
        _normalize_subject(policy.signer_subject),
    ):
        raise ProviderUnavailableError("FastFlowLM installer signer subject is not allowlisted.")
    if not signature.timestamped:
        raise ProviderUnavailableError("FastFlowLM installer signature is not timestamped.")


class _StrictGitHubRedirectHandler(HTTPRedirectHandler):
    max_redirections = 3

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _validate_fastflowlm_download_url(newurl, initial=False)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _validate_fastflowlm_download_url(url: str, *, initial: bool) -> None:
    policy = FASTFLOWLM_RUNTIME_TRUST_POLICY
    parsed = urlsplit(url)
    if (
        parsed.scheme.casefold() != "https"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise ProviderUnavailableError(
            "FastFlowLM installer URL must use an allowlisted HTTPS release host."
        )
    if initial:
        if url != policy.installer_url:
            raise ProviderUnavailableError("FastFlowLM installer URL is not allowlisted.")
        return
    host = (parsed.hostname or "").casefold()
    if host == "github.com":
        if url != policy.installer_url:
            raise ProviderUnavailableError("FastFlowLM GitHub release URL changed unexpectedly.")
        return
    if host not in _ALLOWED_REDIRECT_HOSTS:
        raise ProviderUnavailableError("FastFlowLM release redirected to an untrusted host.")


def _write_bounded_response(response, destination: Path, *, expected_bytes: int) -> None:
    content_length = response.headers.get("Content-Length")
    if content_length is not None:
        try:
            advertised_bytes = int(content_length)
        except ValueError as exc:
            raise OSError("FastFlowLM release returned an invalid Content-Length.") from exc
        if advertised_bytes != expected_bytes:
            raise OSError("FastFlowLM release Content-Length does not match the allowlist.")

    completed = 0
    with destination.open("xb") as output:
        while chunk := response.read(min(_DOWNLOAD_CHUNK_BYTES, expected_bytes - completed + 1)):
            completed += len(chunk)
            if completed > expected_bytes:
                raise OSError("FastFlowLM installer exceeded the allowlisted byte count.")
            output.write(chunk)
    if completed != expected_bytes:
        raise OSError(
            f"FastFlowLM installer download is incomplete: {completed}/{expected_bytes} bytes."
        )


def _set_read_idle_timeout(response) -> None:
    try:
        response.fp.raw._sock.settimeout(_READ_IDLE_TIMEOUT_SECONDS)  # noqa: SLF001
    except (AttributeError, OSError):
        pass


def _normalize_thumbprint(value: str) -> str:
    return "".join(value.split()).upper()


def _normalize_subject(value: str) -> str:
    return " ".join(value.split()).casefold()


__all__ = [
    "FastFlowLMRuntimeInstaller",
    "download_fastflowlm_installer",
    "verify_fastflowlm_authenticode",
    "verify_fastflowlm_installer_hash",
]
