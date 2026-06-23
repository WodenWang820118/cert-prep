from __future__ import annotations

from pathlib import Path
import subprocess

from cert_prep_backend.errors import ProviderUnavailableError


def run_ocr_runtime_command(entrypoint: Path, args: list[str]) -> str:
    """Run an OCR runtime entrypoint with Windows script handling and UTF-8 output."""

    command: list[str]
    if entrypoint.suffix.lower() in {".cmd", ".bat"}:
        command = ["cmd.exe", "/C", str(entrypoint), *args]
    elif entrypoint.suffix.lower() == ".ps1":
        command = [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(entrypoint),
            *args,
        ]
    else:
        command = [str(entrypoint), *args]
    completed = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if completed.returncode != 0:
        raise ProviderUnavailableError((completed.stderr or completed.stdout).strip())
    return completed.stdout
