from __future__ import annotations

import os
from pathlib import Path
import subprocess
from typing import Any

from cert_prep_backend.api.errors import ProviderUnavailableError


def terminate_fastflowlm_process_tree(process: Any) -> None:
    """Terminate an owned FastFlowLM process tree without consulting PATH."""

    if process.poll() is not None:
        return
    if os.name == "nt":
        from cert_prep_backend.domains.runtime_installations.wintrust import (
            AuthenticodeInspectionError,
        )

        try:
            taskkill = _resolve_windows_system_executable("taskkill.exe")
            completed = subprocess.run(
                [str(taskkill), "/PID", str(process.pid), "/T", "/F"],
                check=False,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=15,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            if completed.returncode != 0 and process.poll() is None:
                raise OSError("taskkill could not terminate the FastFlowLM process tree")
            if process.poll() is None:
                process.wait(timeout=15)
        except (AuthenticodeInspectionError, OSError, subprocess.TimeoutExpired) as exc:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            raise ProviderUnavailableError(
                "FastFlowLM process tree could not be terminated cleanly."
            ) from exc
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def _resolve_windows_system_executable(name: str) -> Path:
    from cert_prep_backend.domains.runtime_installations.wintrust import (
        resolve_windows_system_executable,
    )

    return resolve_windows_system_executable(name)


__all__ = ["terminate_fastflowlm_process_tree"]
