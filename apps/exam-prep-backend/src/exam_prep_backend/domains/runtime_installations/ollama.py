from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import time
from urllib.error import URLError
from urllib.parse import urlparse
from urllib.request import urlopen


DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434"
OLLAMA_API_READY_TIMEOUT_SECONDS = 30.0


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


def ensure_ollama_server_running(
    host: str = DEFAULT_OLLAMA_HOST,
    *,
    executable: Path | None = None,
    timeout_seconds: float = OLLAMA_API_READY_TIMEOUT_SECONDS,
) -> bool:
    """Start the local Ollama API server when the runtime is installed but idle."""

    if ollama_api_available(host):
        return True

    executable = executable or resolve_ollama_executable()
    if executable is None:
        return False

    process = _start_ollama_server(executable, host)
    deadline = time.monotonic() + max(1.0, timeout_seconds)
    while time.monotonic() < deadline:
        if ollama_api_available(host):
            return True
        if process.poll() is not None:
            return ollama_api_available(host)
        time.sleep(0.5)

    if process.poll() is None:
        process.terminate()
    return ollama_api_available(host)


def ollama_api_available(host: str = DEFAULT_OLLAMA_HOST) -> bool:
    """Return whether the Ollama HTTP API responds without pulling a model."""

    try:
        with urlopen(f"{host.rstrip('/')}/api/tags", timeout=2) as response:
            return 200 <= response.status < 500
    except (OSError, URLError, ValueError):
        return False


def _start_ollama_server(executable: Path, host: str) -> subprocess.Popen:
    env = os.environ.copy()
    bind_host = _ollama_server_bind_host(host)
    if bind_host:
        env["OLLAMA_HOST"] = bind_host
    creationflags = 0
    if os.name == "nt":
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return subprocess.Popen(
        [str(executable), "serve"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=env,
        creationflags=creationflags,
    )


def _ollama_server_bind_host(host: str) -> str:
    if "://" not in host:
        return host
    parsed = urlparse(host)
    return parsed.netloc or parsed.path
