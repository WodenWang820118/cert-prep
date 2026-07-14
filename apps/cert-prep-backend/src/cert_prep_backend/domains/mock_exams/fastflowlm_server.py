from __future__ import annotations

from collections.abc import Callable
import os
from pathlib import Path
import subprocess
from threading import Lock, Timer
import time
from urllib.parse import urlparse

from cert_prep_backend.api.errors import ProviderUnavailableError
from cert_prep_backend.domains.mock_exams.response_parsing import short_error


class FastFlowLMServerManager:
    """Owns auto-start and idle shutdown for a provider-started FastFlowLM server."""

    def __init__(
        self,
        *,
        base_url: str,
        auto_start_server: bool,
        server_start_timeout_seconds: float,
        owned_server_idle_timeout_seconds: float,
        executable_resolver: Callable[[], Path | None],
        start_process: Callable[..., subprocess.Popen],
        served_model_names: Callable[[], set[str]],
        model_to_serve: Callable[[], str],
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.auto_start_server = auto_start_server
        self.server_start_timeout_seconds = max(0.1, server_start_timeout_seconds)
        self.owned_server_idle_timeout_seconds = max(0.0, owned_server_idle_timeout_seconds)
        self._executable_resolver = executable_resolver
        self._start_process = start_process
        self._served_model_names = served_model_names
        self._model_to_serve = model_to_serve
        self._lock = Lock()
        self._owned_server_process: subprocess.Popen | None = None
        self._owned_server_model: str | None = None
        self._idle_shutdown_timer: Timer | None = None
        self._active_requests = 0
        self._release_requested = False

    def served_model_names_for_generation(self, initial_exc: Exception) -> set[str]:
        if not self.auto_start_server:
            raise initial_exc
        self._start_owned_server_if_needed(initial_exc)
        return self._wait_for_owned_server_ready()

    def begin_generation_request(self) -> None:
        with self._lock:
            self._active_requests += 1
            self._release_requested = False
            self._cancel_idle_shutdown_locked()

    def end_generation_request(self) -> None:
        process_to_stop = None
        with self._lock:
            self._active_requests = max(0, self._active_requests - 1)
            if self._active_requests == 0 and self._release_requested:
                process_to_stop = self._schedule_owned_server_shutdown_locked()
        if process_to_stop is not None:
            terminate_process(process_to_stop)

    def release_resources(self) -> None:
        process_to_stop = None
        with self._lock:
            self._release_requested = True
            if self._active_requests > 0 or self._owned_server_process is None:
                return
            process_to_stop = self._schedule_owned_server_shutdown_locked()
        if process_to_stop is not None:
            terminate_process(process_to_stop)

    def close(self) -> None:
        with self._lock:
            self._cancel_idle_shutdown_locked()
            process_to_stop = self._owned_server_process
            self._owned_server_process = None
            self._owned_server_model = None
            self._release_requested = False
        if process_to_stop is not None:
            terminate_process(process_to_stop)

    def _start_owned_server_if_needed(self, initial_exc: Exception) -> None:
        endpoint = self._local_server_endpoint()
        if endpoint is None:
            raise initial_exc
        host, port = endpoint

        executable = self._executable_resolver()
        if executable is None:
            raise ProviderUnavailableError("FastFlowLM is not installed.") from initial_exc

        model_to_serve = self._model_to_serve()
        with self._lock:
            if self._owned_server_process is not None:
                if self._owned_server_process.poll() is None:
                    return
                self._owned_server_process = None
                self._owned_server_model = None

            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
            process = self._start_process(
                executable=executable,
                model=model_to_serve,
                host=host,
                port=port,
                creationflags=creationflags,
            )
            self._owned_server_process = process
            self._owned_server_model = model_to_serve
            self._release_requested = False

    def _wait_for_owned_server_ready(self) -> set[str]:
        deadline = time.monotonic() + self.server_start_timeout_seconds
        last_error: Exception | None = None
        while time.monotonic() < deadline:
            process = self._owned_server_process_snapshot()
            if process is None:
                break
            if process.poll() is not None:
                with self._lock:
                    if self._owned_server_process is process:
                        raise ProviderUnavailableError("FastFlowLM server exited during startup.")
                break
            try:
                return self._served_model_names()
            except Exception as exc:
                last_error = exc
                time.sleep(0.5)

        self.close()
        detail = short_error(last_error) if last_error else "startup timed out"
        raise ProviderUnavailableError(f"FastFlowLM server did not become ready: {detail}")

    def _owned_server_process_snapshot(self) -> subprocess.Popen | None:
        with self._lock:
            return self._owned_server_process

    def _local_server_endpoint(self) -> tuple[str, int] | None:
        parsed = urlparse(self.base_url)
        host = parsed.hostname or ""
        if host not in {"127.0.0.1", "localhost"}:
            return None
        return host, parsed.port or 52625

    def _schedule_owned_server_shutdown_locked(self) -> subprocess.Popen | None:
        if self._owned_server_process is None:
            return None
        self._cancel_idle_shutdown_locked()
        if self.owned_server_idle_timeout_seconds <= 0:
            process = self._owned_server_process
            self._owned_server_process = None
            self._owned_server_model = None
            self._release_requested = False
            return process

        timer = Timer(
            self.owned_server_idle_timeout_seconds,
            self._stop_owned_server_if_idle,
        )
        timer.daemon = True
        self._idle_shutdown_timer = timer
        timer.start()
        return None

    def _stop_owned_server_if_idle(self) -> None:
        process_to_stop = None
        with self._lock:
            self._idle_shutdown_timer = None
            if self._active_requests > 0 or not self._release_requested:
                return
            process_to_stop = self._owned_server_process
            self._owned_server_process = None
            self._owned_server_model = None
            self._release_requested = False
        if process_to_stop is not None:
            terminate_process(process_to_stop)

    def _cancel_idle_shutdown_locked(self) -> None:
        if self._idle_shutdown_timer is None:
            return
        self._idle_shutdown_timer.cancel()
        self._idle_shutdown_timer = None


def start_fastflowlm_server_process(
    *,
    executable: Path,
    model: str,
    host: str,
    port: int,
    creationflags: int,
) -> subprocess.Popen:
    return subprocess.Popen(
        [
            str(executable),
            "serve",
            model,
            "--host",
            host,
            "--port",
            str(port),
            "--quiet",
            "--cors",
            "0",
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        cwd=executable.parent,
        creationflags=creationflags,
    )


def terminate_process(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)
