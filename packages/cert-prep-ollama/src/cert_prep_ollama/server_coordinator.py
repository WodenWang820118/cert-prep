"""Ollama server coordinator managing application-owned lifecycle, device policy, and restart."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from contextlib import contextmanager
from dataclasses import replace
import logging
import os
from pathlib import Path
import subprocess
import threading
import time
from typing import Any
from urllib.parse import urlparse

from cert_prep_contracts.hardware import MachineInventorySnapshot
from cert_prep_ollama.device_policy import (
    OllamaDevicePolicy,
    corrected_device_policy,
    ollama_child_environment,
    select_ollama_device_policy,
)
from cert_prep_ollama.device_verification import (
    DeviceExecution,
    ServerOwnership,
    verify_device_execution,
)
from cert_prep_ollama.server import (
    DEFAULT_OLLAMA_HOST,
    OLLAMA_API_READY_TIMEOUT_SECONDS,
    _ollama_server_bind_host,
    ollama_api_available,
    resolve_ollama_executable,
)
from cert_prep_ollama.server_log import OllamaLogParser

logger = logging.getLogger(__name__)

_MAX_DRAIN_CHUNK = 65536
_PROCESS_EXIT_TIMEOUT_SECONDS = 5.0


def _terminate_process_tree(pid: int) -> None:
    """Terminate a process and all its children across platforms."""
    if os.name == "nt":
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=creationflags,
                timeout=5.0,
            )
        except Exception:
            pass
    else:
        try:
            os.kill(pid, 15)
            time.sleep(0.1)
            try:
                os.kill(pid, 9)
            except ProcessLookupError:
                pass
        except ProcessLookupError:
            pass


def _is_local_host(host: str) -> bool:
    """Check if host string targets a local loopback address."""
    hostname = urlparse(host if "://" in host else f"http://{host}").hostname
    return hostname in ("127.0.0.1", "localhost", "::1")


class OllamaServerCoordinator:
    """Coordinates the lifecycle, environment policy, and verification of an Ollama server."""

    def __init__(
        self,
        host: str = DEFAULT_OLLAMA_HOST,
        inventory_provider: Callable[[], MachineInventorySnapshot | None] = lambda: None,
        *,
        executable_resolver: Callable[[], Path | None] = resolve_ollama_executable,
        process_factory: Callable[..., Any] = subprocess.Popen,
        api_probe: Callable[[str], bool] = ollama_api_available,
        tree_terminator: Callable[[int], None] = _terminate_process_tree,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        base_environment: Mapping[str, str] | None = None,
        platform_name: str | None = None,
    ) -> None:
        self.host = host
        self._inventory_provider = inventory_provider
        self._executable_resolver = executable_resolver
        self._process_factory = process_factory
        self._api_probe = api_probe
        self._tree_terminator = tree_terminator
        self._clock = clock
        self._sleep = sleep
        self._base_environment = base_environment if base_environment is not None else os.environ
        self._platform_name = platform_name
        self._is_windows = (
            (platform_name.casefold() == "windows")
            if platform_name is not None
            else (os.name == "nt")
        )

        # Lifecycle and process state
        self._lock = threading.Lock()
        # Serialises verification so concurrent generation calls decide on one restart.
        self._verify_lock = threading.Lock()
        self._process: Any | None = None
        self._ownership: ServerOwnership = "none"
        self._policy: OllamaDevicePolicy | None = None
        self._restarts: int = 0
        self._closed: bool = False
        self._verification_pending: bool = False
        self._device_execution: DeviceExecution | None = None

        # Log parsing & stdout drain
        self._log_parser = OllamaLogParser()
        self._drain_thread: threading.Thread | None = None

        # Admission control for generation & restart
        self._admission_cond = threading.Condition(threading.Lock())
        self._active_admissions: int = 0
        self._restarting: bool = False

    @property
    def ownership(self) -> ServerOwnership:
        return self._ownership

    @property
    def policy(self) -> OllamaDevicePolicy | None:
        return self._policy

    def _owns_live_process(self) -> bool:
        return (
            self._ownership == "owned"
            and self._process is not None
            and self._process.poll() is None
        )

    def _start_drain_thread(self, proc: Any) -> None:
        stdout = getattr(proc, "stdout", None)
        if stdout is None:
            return

        parser = self._log_parser

        def _drain() -> None:
            try:
                while True:
                    # Line by line: read(n) on a pipe would hold back the last lines until more output.
                    chunk = stdout.readline(_MAX_DRAIN_CHUNK)
                    if not chunk:
                        break
                    if isinstance(chunk, bytes):
                        text = chunk.decode("utf-8", errors="replace")
                    else:
                        text = str(chunk)
                    parser.feed(text)
            except Exception:
                pass

        thread = threading.Thread(target=_drain, daemon=True)
        self._drain_thread = thread
        thread.start()

    def _wait_for_exit(self, proc: Any) -> bool:
        deadline = self._clock() + _PROCESS_EXIT_TIMEOUT_SECONDS
        while proc.poll() is None:
            if self._clock() >= deadline:
                return False
            self._sleep(0.1)
        return True

    def _stop_owned_process(self) -> bool:
        """Stop our server; False when it would not exit, so no second server may start."""
        proc = self._process
        if proc is not None:
            self._tree_terminator(proc.pid)
            if not self._wait_for_exit(proc):
                proc.kill()
                if not self._wait_for_exit(proc):
                    logger.warning("Owned Ollama server (pid %s) did not exit.", proc.pid)
                    return False
            self._process = None
        if self._drain_thread is not None and self._drain_thread.is_alive():
            self._drain_thread.join(timeout=1.0)
        return True

    @contextmanager
    def _admissions_paused_when_idle(self):
        """Yield True with new generation calls held back, or False while a call is running."""
        with self._admission_cond:
            idle = self._active_admissions == 0 and not self._restarting
            if idle:
                self._restarting = True
        try:
            yield idle
        finally:
            if idle:
                with self._admission_cond:
                    self._restarting = False
                    self._admission_cond.notify_all()

    def _spawn_server(self, executable: Path, policy: OllamaDevicePolicy) -> Any:
        child_env, _ = ollama_child_environment(
            self._base_environment, policy, case_insensitive=self._is_windows
        )
        bind_host = _ollama_server_bind_host(self.host)
        if bind_host:
            child_env["OLLAMA_HOST"] = bind_host
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if self._is_windows else 0
        proc = self._process_factory(
            [str(executable), "serve"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=child_env,
            creationflags=creationflags,
        )
        self._process = proc
        self._ownership = "owned"
        self._verification_pending = True
        # Each server gets its own log so a restart never verifies against the old one.
        self._log_parser = OllamaLogParser()
        self._start_drain_thread(proc)
        return proc

    def ensure_running(
        self, timeout_seconds: float = OLLAMA_API_READY_TIMEOUT_SECONDS
    ) -> bool:
        """Ensure the local Ollama server is running with the device policy applied."""
        with self._lock:
            if self._closed:
                return False
            # Non-local hosts: never spawn; return the probe
            if not _is_local_host(self.host):
                return self._api_probe(self.host)

            if self._api_probe(self.host):
                # API answers and we own no live process: mark external
                if not self._owns_live_process():
                    self._ownership = "external"
                return True

            with self._admissions_paused_when_idle() as idle:
                if not idle:
                    # A busy server can miss one probe; never stop or replace it under a running call.
                    return False
                if self._owns_live_process():
                    # Our server stopped answering; never run two servers on one port.
                    if not self._stop_owned_process():
                        return False
                    self._ownership = "none"
                return self._start_owned_server(timeout_seconds)

    def _start_owned_server(self, timeout_seconds: float) -> bool:
        # A corrected policy survives a later respawn; otherwise read the inventory.
        if self._restarts and self._policy is not None:
            policy = self._policy
        else:
            policy = select_ollama_device_policy(
                self._inventory_provider(), platform_name=self._platform_name
            )
            self._policy = policy
        logger.info(
            "Ollama device policy: target=%s, backend=%s, adapter=%s, vars=%s",
            policy.target,
            policy.backend,
            policy.adapter_name,
            policy.environment,
        )

        executable = self._executable_resolver()
        if executable is None:
            return False
        proc = self._spawn_server(executable, policy)

        deadline = self._clock() + max(1.0, timeout_seconds)
        while self._clock() < deadline:
            if proc.poll() is not None:
                # Our child exited while waiting for API
                if self._api_probe(self.host):
                    self._ownership = "external"
                    self._process = None
                    return True
                self._ownership = "none"
                self._process = None
                return False
            if self._api_probe(self.host):
                return True
            self._sleep(0.5)

        # Readiness timed out: stop the process tree so no half-started server keeps the port.
        if not self._stop_owned_process():
            return False
        self._ownership = "none"
        return self._api_probe(self.host)

    @contextmanager
    def admission(self):
        """Context manager held during generation calls; blocks during server restarts."""
        with self._admission_cond:
            while self._restarting:
                self._admission_cond.wait()
            self._active_admissions += 1
        try:
            yield
        finally:
            with self._admission_cond:
                self._active_admissions -= 1
                if self._active_admissions == 0:
                    self._admission_cond.notify_all()

    def after_model_load(self) -> DeviceExecution | None:
        """Verify device execution from logs after model load, with at most one restart."""
        with self._verify_lock:
            return self._verify_latest_load()

    def _verify_latest_load(self) -> DeviceExecution | None:
        if self._ownership != "owned" or self._policy is None:
            detail = (
                "External Ollama; device selection is managed by Ollama."
                if self._ownership == "external"
                else "No owned Ollama server running."
            )
            execution = DeviceExecution(
                target=self._policy.target if self._policy else "unmanaged",
                backend=self._policy.backend if self._policy else None,
                adapter_name=self._policy.adapter_name if self._policy else None,
                observed_library=None,
                observed_description=None,
                observed_pci_bus=None,
                offloaded_layers=None,
                total_layers=None,
                state="unknown",
                detail=detail,
                ownership=self._ownership,
                restarts=self._restarts,
                observed_at=self._clock(),
            )
            self._device_execution = execution
            self._verification_pending = False
            return execution

        if not self._verification_pending:
            return self._device_execution

        records = self._log_parser.latest_load()
        discovered = self._log_parser.discovered_devices()

        if not records and not discovered:
            execution = DeviceExecution(
                target=self._policy.target,
                backend=self._policy.backend,
                adapter_name=self._policy.adapter_name,
                observed_library=None,
                observed_description=None,
                observed_pci_bus=None,
                offloaded_layers=None,
                total_layers=None,
                state="unknown",
                detail="Missing logs; no verification evidence.",
                ownership=self._ownership,
                restarts=self._restarts,
                observed_at=self._clock(),
            )
            # Stay pending: this server may simply not have loaded a model yet.
            self._device_execution = execution
            return execution

        execution = verify_device_execution(
            self._policy,
            records,
            discovered,
            ownership=self._ownership,
            restarts=self._restarts,
            clock=self._clock,
        )
        self._device_execution = execution

        if (
            execution.state == "mismatch"
            and self._ownership == "owned"
            and self._restarts == 0
        ):
            corrected = corrected_device_policy(self._policy, discovered)
            if corrected is not None:
                self._restarts += 1
                self._policy = corrected
                try:
                    restarted = self._restart_server(corrected)
                    if not restarted:
                        execution = replace(
                            execution,
                            detail=f"{execution.detail} Restart failed to become ready.",
                        )
                except Exception as exc:
                    logger.exception("Failed to restart Ollama server: %s", exc)
                    execution = replace(
                        execution,
                        detail=f"{execution.detail} Restart failed: {exc}",
                    )
                self._device_execution = execution
                self._verification_pending = True
                return execution
            else:
                execution = replace(
                    execution,
                    detail=f"{execution.detail} No correction could be derived from discovered devices.",
                )
                self._device_execution = execution
                self._verification_pending = False
                return execution
        else:
            # Without load evidence yet, check again after the next generation call.
            self._verification_pending = execution.state in ("selected_unverified", "unknown")
            return execution

    def _restart_server(self, new_policy: OllamaDevicePolicy) -> bool:
        """Restart owned Ollama server with corrected policy under admission lock."""
        with self._admission_cond:
            self._restarting = True
            self._admission_cond.notify_all()
            deadline = self._clock() + 30.0
            while self._active_admissions > 0:
                remaining = deadline - self._clock()
                if remaining <= 0:
                    break
                self._admission_cond.wait(timeout=remaining)

        try:
            with self._lock:
                # close() may have run while this restart waited for active calls.
                if self._closed or not self._stop_owned_process():
                    return False

                executable = self._executable_resolver()
                if executable is None:
                    self._ownership = "none"
                    return False

                logger.info(
                    "Restarting Ollama with corrected policy: target=%s, backend=%s, adapter=%s, vars=%s",
                    new_policy.target,
                    new_policy.backend,
                    new_policy.adapter_name,
                    new_policy.environment,
                )
                proc = self._spawn_server(executable, new_policy)

                deadline = self._clock() + 30.0
                while self._clock() < deadline:
                    if proc.poll() is not None:
                        break
                    if self._api_probe(self.host):
                        return True
                    self._sleep(0.5)
                # Not ready: stop it so the next ensure_running starts cleanly.
                if self._stop_owned_process():
                    self._ownership = "none"
                return False
        finally:
            with self._admission_cond:
                self._restarting = False
                self._admission_cond.notify_all()

    def device_execution(self) -> DeviceExecution | None:
        """Return the latest DeviceExecution record, or None if not verified yet."""
        return self._device_execution

    def close(self) -> None:
        """Terminate owned process tree and join stdout drain thread; never touch external."""
        with self._lock:
            self._closed = True
            if self._ownership == "owned":
                self._stop_owned_process()
                self._ownership = "none"
            elif self._drain_thread is not None and self._drain_thread.is_alive():
                self._drain_thread.join(timeout=2.0)


__all__ = ["OllamaServerCoordinator"]
