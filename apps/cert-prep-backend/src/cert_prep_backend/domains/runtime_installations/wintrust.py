from __future__ import annotations

import ctypes
from ctypes import wintypes
from dataclasses import dataclass
import os
from pathlib import Path
from typing import Any


_ERROR_SUCCESS = 0
_WTD_UI_NONE = 2
_WTD_REVOKE_WHOLECHAIN = 1
_WTD_CHOICE_FILE = 1
_WTD_STATEACTION_VERIFY = 1
_WTD_STATEACTION_CLOSE = 2
_WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT = 0x00000080
_WTD_UICONTEXT_INSTALL = 1
_CERT_SHA1_HASH_PROP_ID = 3
_CERT_NAME_SIMPLE_DISPLAY_TYPE = 4
_SGNR_TYPE_TIMESTAMP = 0x00000010
_MAX_WINDOWS_PATH_CHARS = 32_768


class AuthenticodeInspectionError(RuntimeError):
    """Raised when Windows cannot produce trusted Authenticode metadata."""


@dataclass(frozen=True, slots=True)
class AuthenticodeSignature:
    subject: str
    thumbprint: str
    timestamped: bool


class _GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", ctypes.c_uint32),
        ("Data2", ctypes.c_uint16),
        ("Data3", ctypes.c_uint16),
        ("Data4", ctypes.c_ubyte * 8),
    ]


class _FILETIME(ctypes.Structure):
    _fields_ = [
        ("dwLowDateTime", ctypes.c_uint32),
        ("dwHighDateTime", ctypes.c_uint32),
    ]


class _WINTRUST_FILE_INFO(ctypes.Structure):
    _fields_ = [
        ("cbStruct", ctypes.c_uint32),
        ("pcwszFilePath", ctypes.c_wchar_p),
        ("hFile", ctypes.c_void_p),
        ("pgKnownSubject", ctypes.POINTER(_GUID)),
    ]


class _WINTRUST_DATA(ctypes.Structure):
    _fields_ = [
        ("cbStruct", ctypes.c_uint32),
        ("pPolicyCallbackData", ctypes.c_void_p),
        ("pSIPClientData", ctypes.c_void_p),
        ("dwUIChoice", ctypes.c_uint32),
        ("fdwRevocationChecks", ctypes.c_uint32),
        ("dwUnionChoice", ctypes.c_uint32),
        ("pFile", ctypes.POINTER(_WINTRUST_FILE_INFO)),
        ("dwStateAction", ctypes.c_uint32),
        ("hWVTStateData", ctypes.c_void_p),
        ("pwszURLReference", ctypes.c_wchar_p),
        ("dwProvFlags", ctypes.c_uint32),
        ("dwUIContext", ctypes.c_uint32),
    ]


class _CRYPT_PROVIDER_CERT(ctypes.Structure):
    _fields_ = [
        ("cbStruct", ctypes.c_uint32),
        ("pCert", ctypes.c_void_p),
    ]


class _CRYPT_PROVIDER_SGNR(ctypes.Structure):
    _fields_ = [
        ("cbStruct", ctypes.c_uint32),
        ("sftVerifyAsOf", _FILETIME),
        ("csCertChain", ctypes.c_uint32),
        ("pasCertChain", ctypes.POINTER(_CRYPT_PROVIDER_CERT)),
        ("dwSignerType", ctypes.c_uint32),
        ("psSigner", ctypes.c_void_p),
        ("dwError", ctypes.c_uint32),
        ("csCounterSigners", ctypes.c_uint32),
    ]


@dataclass(frozen=True, slots=True)
class _WinTrustApi:
    win_verify_trust: Any
    provider_data_from_state: Any
    signer_from_chain: Any
    cert_from_chain: Any
    cert_get_property: Any
    cert_get_name: Any


def inspect_authenticode_signature(path: Path) -> AuthenticodeSignature:
    """Verify one Windows file and return signer metadata from WinVerifyTrust state."""

    if os.name != "nt":
        raise AuthenticodeInspectionError("Authenticode verification requires Windows.")
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise AuthenticodeInspectionError("Authenticode target does not exist.") from exc

    api = _load_wintrust_api()
    action = _wintrust_action_generic_verify_v2()
    file_info = _WINTRUST_FILE_INFO(
        cbStruct=ctypes.sizeof(_WINTRUST_FILE_INFO),
        pcwszFilePath=str(resolved),
        hFile=None,
        pgKnownSubject=None,
    )
    trust_data = _WINTRUST_DATA(
        cbStruct=ctypes.sizeof(_WINTRUST_DATA),
        pPolicyCallbackData=None,
        pSIPClientData=None,
        dwUIChoice=_WTD_UI_NONE,
        fdwRevocationChecks=_WTD_REVOKE_WHOLECHAIN,
        dwUnionChoice=_WTD_CHOICE_FILE,
        pFile=ctypes.pointer(file_info),
        dwStateAction=_WTD_STATEACTION_VERIFY,
        hWVTStateData=None,
        pwszURLReference=None,
        dwProvFlags=_WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT,
        dwUIContext=_WTD_UICONTEXT_INSTALL,
    )

    verification_error: AuthenticodeInspectionError | None = None
    try:
        result = int(
            api.win_verify_trust(
                None,
                ctypes.byref(action),
                ctypes.byref(trust_data),
            )
        )
        if result != _ERROR_SUCCESS:
            verification_error = AuthenticodeInspectionError(
                f"WinVerifyTrust rejected the file with status 0x{result & 0xFFFFFFFF:08X}."
            )
            raise verification_error
        return _signature_from_verified_state(api, trust_data.hWVTStateData)
    finally:
        if trust_data.hWVTStateData:
            trust_data.dwStateAction = _WTD_STATEACTION_CLOSE
            close_result = int(
                api.win_verify_trust(
                    None,
                    ctypes.byref(action),
                    ctypes.byref(trust_data),
                )
            )
            if close_result != _ERROR_SUCCESS and verification_error is None:
                raise AuthenticodeInspectionError(
                    "WinVerifyTrust could not release its verification state."
                )


def _signature_from_verified_state(
    api: _WinTrustApi,
    state_handle: int | None,
) -> AuthenticodeSignature:
    provider_data = api.provider_data_from_state(state_handle)
    if not provider_data:
        raise AuthenticodeInspectionError("WinVerifyTrust returned no provider state.")

    signer = api.signer_from_chain(provider_data, 0, False, 0)
    if not signer or signer.contents.dwError != _ERROR_SUCCESS:
        raise AuthenticodeInspectionError("WinVerifyTrust returned no valid signer chain.")
    provider_cert = api.cert_from_chain(signer, 0)
    if not provider_cert or not provider_cert.contents.pCert:
        raise AuthenticodeInspectionError("WinVerifyTrust returned no signer certificate.")

    counter_signer = api.signer_from_chain(provider_data, 0, True, 0)
    timestamped = bool(
        signer.contents.csCounterSigners > 0
        and counter_signer
        and counter_signer.contents.dwError == _ERROR_SUCCESS
        and counter_signer.contents.dwSignerType == _SGNR_TYPE_TIMESTAMP
    )
    cert_context = provider_cert.contents.pCert
    return AuthenticodeSignature(
        subject=_certificate_simple_name(api, cert_context),
        thumbprint=_certificate_sha1_thumbprint(api, cert_context),
        timestamped=timestamped,
    )


def _certificate_simple_name(api: _WinTrustApi, cert_context: int) -> str:
    length = int(
        api.cert_get_name(
            cert_context,
            _CERT_NAME_SIMPLE_DISPLAY_TYPE,
            0,
            None,
            None,
            0,
        )
    )
    if length <= 1:
        raise AuthenticodeInspectionError("Signer certificate subject is unavailable.")
    buffer = ctypes.create_unicode_buffer(length)
    copied = int(
        api.cert_get_name(
            cert_context,
            _CERT_NAME_SIMPLE_DISPLAY_TYPE,
            0,
            None,
            buffer,
            length,
        )
    )
    if copied != length:
        raise AuthenticodeInspectionError("Signer certificate subject could not be read.")
    return buffer.value


def _certificate_sha1_thumbprint(api: _WinTrustApi, cert_context: int) -> str:
    size = ctypes.c_uint32(0)
    if not api.cert_get_property(
        cert_context,
        _CERT_SHA1_HASH_PROP_ID,
        None,
        ctypes.byref(size),
    ):
        raise AuthenticodeInspectionError("Signer certificate thumbprint is unavailable.")
    if size.value != 20:
        raise AuthenticodeInspectionError("Signer certificate thumbprint has an invalid size.")
    buffer = (ctypes.c_ubyte * size.value)()
    if not api.cert_get_property(
        cert_context,
        _CERT_SHA1_HASH_PROP_ID,
        buffer,
        ctypes.byref(size),
    ):
        raise AuthenticodeInspectionError("Signer certificate thumbprint could not be read.")
    return bytes(buffer).hex().upper()


def _load_wintrust_api() -> _WinTrustApi:
    system_directory = windows_system_directory()
    wintrust = ctypes.WinDLL(str(system_directory / "wintrust.dll"), use_last_error=True)
    crypt32 = ctypes.WinDLL(str(system_directory / "crypt32.dll"), use_last_error=True)

    win_verify_trust = wintrust.WinVerifyTrust
    win_verify_trust.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(_GUID),
        ctypes.c_void_p,
    ]
    win_verify_trust.restype = ctypes.c_long

    provider_data_from_state = wintrust.WTHelperProvDataFromStateData
    provider_data_from_state.argtypes = [ctypes.c_void_p]
    provider_data_from_state.restype = ctypes.c_void_p

    signer_from_chain = wintrust.WTHelperGetProvSignerFromChain
    signer_from_chain.argtypes = [
        ctypes.c_void_p,
        ctypes.c_uint32,
        wintypes.BOOL,
        ctypes.c_uint32,
    ]
    signer_from_chain.restype = ctypes.POINTER(_CRYPT_PROVIDER_SGNR)

    cert_from_chain = wintrust.WTHelperGetProvCertFromChain
    cert_from_chain.argtypes = [
        ctypes.POINTER(_CRYPT_PROVIDER_SGNR),
        ctypes.c_uint32,
    ]
    cert_from_chain.restype = ctypes.POINTER(_CRYPT_PROVIDER_CERT)

    cert_get_property = crypt32.CertGetCertificateContextProperty
    cert_get_property.argtypes = [
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_uint32),
    ]
    cert_get_property.restype = wintypes.BOOL

    cert_get_name = crypt32.CertGetNameStringW
    cert_get_name.argtypes = [
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_void_p,
        ctypes.c_wchar_p,
        ctypes.c_uint32,
    ]
    cert_get_name.restype = ctypes.c_uint32

    return _WinTrustApi(
        win_verify_trust=win_verify_trust,
        provider_data_from_state=provider_data_from_state,
        signer_from_chain=signer_from_chain,
        cert_from_chain=cert_from_chain,
        cert_get_property=cert_get_property,
        cert_get_name=cert_get_name,
    )


def _wintrust_action_generic_verify_v2() -> _GUID:
    return _GUID(
        Data1=0x00AAC56B,
        Data2=0xCD44,
        Data3=0x11D0,
        Data4=(ctypes.c_ubyte * 8)(0x8C, 0xC2, 0x00, 0xC0, 0x4F, 0xC2, 0x95, 0xEE),
    )


def windows_system_directory() -> Path:
    """Resolve System32 through the native API, never an environment variable."""

    if os.name != "nt":
        raise AuthenticodeInspectionError("Windows system directory requires Windows.")
    kernel32 = ctypes.WinDLL("kernel32.dll", use_last_error=True)
    get_system_directory = kernel32.GetSystemDirectoryW
    get_system_directory.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32]
    get_system_directory.restype = ctypes.c_uint32
    buffer = ctypes.create_unicode_buffer(_MAX_WINDOWS_PATH_CHARS)
    copied = int(get_system_directory(buffer, len(buffer)))
    if copied == 0 or copied >= len(buffer):
        raise AuthenticodeInspectionError("Windows system directory could not be resolved.")
    resolved = Path(buffer.value)
    if not resolved.is_absolute() or not resolved.is_dir():
        raise AuthenticodeInspectionError("Windows system directory is invalid.")
    return resolved


def resolve_windows_system_executable(file_name: str) -> Path:
    """Resolve one fixed System32 executable without PATH search."""

    if Path(file_name).name != file_name or not file_name.casefold().endswith(".exe"):
        raise AuthenticodeInspectionError("Windows system executable name is invalid.")
    executable = windows_system_directory() / file_name
    if not executable.is_file():
        raise AuthenticodeInspectionError(
            f"Windows system executable was not found: {file_name}"
        )
    return executable


__all__ = [
    "AuthenticodeInspectionError",
    "AuthenticodeSignature",
    "inspect_authenticode_signature",
    "resolve_windows_system_executable",
    "windows_system_directory",
]
