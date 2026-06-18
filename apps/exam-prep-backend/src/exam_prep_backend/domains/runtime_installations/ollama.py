from __future__ import annotations

import os
from pathlib import Path
import shutil


def resolve_ollama_executable() -> Path | None:
    """Resolve the Ollama executable from PATH or the Windows user install path."""

    configured = shutil.which("ollama")
    if configured:
        return Path(configured)
    if os.name == "nt":
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            candidate = Path(local_app_data) / "Programs" / "Ollama" / "ollama.exe"
            if candidate.is_file():
                return candidate
    return None
