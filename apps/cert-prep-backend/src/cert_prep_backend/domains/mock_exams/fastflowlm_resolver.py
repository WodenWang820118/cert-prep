from __future__ import annotations

import ctypes
from ctypes import wintypes
import hashlib
import hmac
import os
from pathlib import Path
from uuid import UUID

from cert_prep_contracts.llm import FASTFLOWLM_RUNTIME_TRUST_POLICY


class _Guid(ctypes.Structure):
    _fields_ = [
        ("data1", wintypes.DWORD),
        ("data2", wintypes.WORD),
        ("data3", wintypes.WORD),
        ("data4", ctypes.c_ubyte * 8),
    ]


_FOLDER_ID_PROGRAM_FILES = UUID("905e63b6-c1bf-494e-b29c-65b732d3d21a")
_FOLDER_ID_PROGRAM_FILES_X86 = UUID("7c5a40ef-a0fb-4bfc-874a-c0f2e0b9fa8e")
_FOLDER_ID_LOCAL_APP_DATA = UUID("f1b32785-6fba-4fcf-9d55-7b8e7f157091")


def resolve_fastflowlm_executable(
    configured_path: Path | None = None,
) -> Path | None:
    """Resolve only the exact allowlisted CLI from Windows known folders."""

    if os.name != "nt":
        return None

    roots = trusted_fastflowlm_install_roots()
    candidates = (
        [configured_path]
        if configured_path is not None
        else [
            candidate
            for root in roots
            for candidate in (root / "flm.exe", root / "bin" / "flm.exe")
        ]
    )
    for candidate in candidates:
        if candidate is None or not candidate.is_absolute():
            continue
        try:
            resolved = candidate.resolve(strict=True)
        except OSError:
            continue
        if resolved.name.casefold() != "flm.exe":
            continue
        if not any(_is_relative_to(resolved, root) for root in roots):
            continue
        if not is_allowlisted_fastflowlm_executable(resolved):
            continue
        return resolved
    return None


def trusted_fastflowlm_install_roots() -> tuple[Path, ...]:
    """Return canonical product roots without trusting process environment variables."""

    if os.name != "nt":
        return ()
    roots: list[Path] = []
    local_app_data = _known_folder_path(_FOLDER_ID_LOCAL_APP_DATA)
    if local_app_data is not None:
        roots.append(local_app_data / "Programs" / "FastFlowLM")
    for folder_id in (
        _FOLDER_ID_PROGRAM_FILES,
        _FOLDER_ID_PROGRAM_FILES_X86,
    ):
        program_files = _known_folder_path(folder_id)
        if program_files is not None:
            roots.extend(
                (
                    program_files / "flm",
                    program_files / "FastFlowLM",
                )
            )
    return tuple(
        dict.fromkeys(root.resolve(strict=False) for root in roots if root.is_absolute())
    )


def is_allowlisted_fastflowlm_executable(executable: Path) -> bool:
    """Check installed CLI bytes without executing the candidate."""

    policy = FASTFLOWLM_RUNTIME_TRUST_POLICY
    try:
        if executable.stat().st_size != policy.executable_bytes:
            return False
        digest = hashlib.sha256()
        with executable.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        return False
    return hmac.compare_digest(
        digest.hexdigest().casefold(),
        policy.executable_sha256.casefold(),
    )


def _known_folder_path(folder_id: UUID) -> Path | None:
    if os.name != "nt":
        return None
    shell32 = ctypes.WinDLL("shell32", use_last_error=True)
    ole32 = ctypes.WinDLL("ole32", use_last_error=True)
    get_path = shell32.SHGetKnownFolderPath
    get_path.argtypes = [
        ctypes.POINTER(_Guid),
        wintypes.DWORD,
        wintypes.HANDLE,
        ctypes.POINTER(ctypes.c_wchar_p),
    ]
    get_path.restype = ctypes.c_long
    free_memory = ole32.CoTaskMemFree
    free_memory.argtypes = [ctypes.c_void_p]
    free_memory.restype = None

    native_id = _guid(folder_id)
    path_pointer = ctypes.c_wchar_p()
    result = get_path(
        ctypes.byref(native_id),
        0,
        None,
        ctypes.byref(path_pointer),
    )
    if result != 0 or not path_pointer.value:
        if path_pointer:
            free_memory(ctypes.cast(path_pointer, ctypes.c_void_p))
        return None
    try:
        return Path(path_pointer.value)
    finally:
        free_memory(ctypes.cast(path_pointer, ctypes.c_void_p))


def _guid(value: UUID) -> _Guid:
    bytes_le = value.bytes_le
    return _Guid(
        int.from_bytes(bytes_le[0:4], "little"),
        int.from_bytes(bytes_le[4:6], "little"),
        int.from_bytes(bytes_le[6:8], "little"),
        (ctypes.c_ubyte * 8)(*bytes_le[8:]),
    )


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


__all__ = [
    "is_allowlisted_fastflowlm_executable",
    "resolve_fastflowlm_executable",
    "trusted_fastflowlm_install_roots",
]
