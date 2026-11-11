"""Ollama server coordinator managing application-owned lifecycle, device policy, and restart."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, replace
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
    OllamaDevicePreference,
    USER_CHOSEN_CPU_EXECUTION_WARNING,
    corrected_device_policy,
    ollama_child_environment,
    select_ollama_device_policy,
)
from cert_prep_ollama.device_status import DeviceStatus, build_device_status
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
# close() waits this long for the switch thread: one stop that is already under
# way plus the stop of a child it started, each a terminate wait and a kill wait.
# The readiness wait is not counted: the thread checks the close between probes.
_SWITCH_CLOSE_JOIN_SECONDS = 4 * _PROCESS_EXIT_TIMEOUT_SECONDS + 2.0
_CORRECTIVE_RESTART_WAIT_SECONDS = 30.0


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


def _auto_device_preference() -> OllamaDevicePreference:
    """Auto when the caller does not supply the stored choice."""

    return OllamaDevicePreference()


@dataclass(frozen=True, slots=True)
class _StatusSnapshot:
    """What health and the preference status read, without the lifecycle locks."""

    ownership: ServerOwnership = "none"
    process: Any | None = None
    policy: OllamaDevicePolicy | None = None
    running_preference: OllamaDevicePreference | None = None
    verification_pending: bool = False
    restarts: int = 0
    execution: DeviceExecution | None = None
    switch_pending: bool = False
    switch_running: bool = False


class OllamaServerCoordinator:
    """Coordinates the lifecycle, environment policy, and verification of an Ollama server.

    Locks, always taken in this order: ``_verify_lock`` (verification and the
    corrective restart), ``_lock`` (process, ownership, policy),
    ``_admission_cond`` (calls using the server and the restart holds), and
    ``_status_lock``. ``_status_lock`` is a leaf: nothing else is taken while
    it is held, and it is never held across I/O, a probe, a process start or
    stop, an inventory read or a database read. Status reads and
    ``apply_device_preference`` take only ``_status_lock``.
    """

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
        preference_provider: Callable[[], OllamaDevicePreference] = _auto_device_preference,
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
        self._preference_provider = preference_provider
        self._policy_preference: OllamaDevicePreference | None = None
        # A corrected environment belongs to one preference. The next start keeps
        # it only while that preference is still the one it was built for.
        self._policy_is_correction = False
        self._is_windows = (
            (platform_name.casefold() == "windows")
            if platform_name is not None
            else (os.name == "nt")
        )
        self._local_host = _is_local_host(host)

        # Lifecycle and process state
        self._lock = threading.Lock()
        # Serialises verification so concurrent generation calls decide on one restart.
        self._verify_lock = threading.Lock()
        self._process: Any | None = None
        self._ownership: ServerOwnership = "none"
        # A switch stopped the old server and no replacement came up. Written under ``_lock``.
        self._switch_left_server_down: bool = False
        self._policy: OllamaDevicePolicy | None = None
        # The choice the live owned server was started with.
        self._running_preference: OllamaDevicePreference | None = None
        self._restarts: int = 0
        self._closed: bool = False
        self._verification_pending: bool = False
        self._device_execution: DeviceExecution | None = None

        # Status snapshot and device-choice requests (leaf lock).
        self._status_lock = threading.Lock()
        # Bumped by every apply_device_preference call.
        self._requested_epoch: int = 0
        # A stored device choice the owned server does not run with yet.
        self._preference_switch_pending: bool = False
        # The switch thread is stopping or starting the server.
        self._preference_switch_running: bool = False
        self._status = _StatusSnapshot()

        # The switch thread. ``_handled_epoch`` is read and written only by it.
        self._switch_thread_lock = threading.Lock()
        self._switch_wakeup = threading.Event()
        self._switch_thread: threading.Thread | None = None
        self._handled_epoch: int = 0

        # Log parsing & stdout drain
        self._log_parser = OllamaLogParser()
        self._drain_thread: threading.Thread | None = None

        # Admission control. SHORT work: generation and translation. LONG work:
        # model pulls and the profile installer's pull and create.
        self._admission_cond = threading.Condition(threading.Lock())
        self._short_active: int = 0
        self._long_active: int = 0
        # A restart holds every new call back. Only the holder clears it.
        self._restarting: bool = False
        # A switch waits for the server to be idle. While no LONG work runs,
        # new calls wait too, so back-to-back calls cannot starve the switch.
        self._switch_waiting: bool = False
        self._admission_depth = threading.local()

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

    def _publish_status(
        self,
        *,
        pending: bool | None = None,
        clear_pending_for: int | None = None,
        switch_running: bool | None = None,
    ) -> None:
        """Rebuild the snapshot from the current fields after a state change.

        ``clear_pending_for`` clears the pending flag only when no newer choice
        was requested after that epoch, so a later ``PUT`` is never reported
        as applied.
        """

        with self._status_lock:
            if pending is not None:
                self._preference_switch_pending = pending
            if clear_pending_for is not None and clear_pending_for == self._requested_epoch:
                self._preference_switch_pending = False
            if switch_running is not None:
                self._preference_switch_running = switch_running
            self._status = _StatusSnapshot(
                ownership=self._ownership,
                process=self._process,
                policy=self._policy,
                running_preference=self._running_preference,
                verification_pending=self._verification_pending,
                restarts=self._restarts,
                execution=self._device_execution,
                switch_pending=self._preference_switch_pending,
                switch_running=self._preference_switch_running,
            )

    def _current_epoch(self) -> int:
        with self._status_lock:
            return self._requested_epoch

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

    def _stop_process_tree(self, proc: Any) -> bool:
        """Stop one process tree. Does not take the coordinator locks or clear pointers."""

        self._tree_terminator(proc.pid)
        if not self._wait_for_exit(proc):
            proc.kill()
            if not self._wait_for_exit(proc):
                logger.warning("Owned Ollama server (pid %s) did not exit.", proc.pid)
                return False
        return True

    def _join_drain(self) -> None:
        drain = self._drain_thread
        if drain is not None and drain.is_alive():
            drain.join(timeout=1.0)

    def _stop_owned_process(self) -> bool:
        """Stop our server. Caller holds ``_lock``.

        False when it would not exit, so no second server may start.
        """

        proc = self._process
        if proc is not None:
            if not self._stop_process_tree(proc):
                return False
            self._process = None
        self._join_drain()
        return True

    @contextmanager
    def _admissions_paused_when_idle(self):
        """Yield True with new calls held back, or False while a call is running."""
        with self._admission_cond:
            idle = (
                self._short_active + self._long_active == 0 and not self._restarting
            )
            if idle:
                self._restarting = True
        try:
            yield idle
        finally:
            if idle:
                with self._admission_cond:
                    self._restarting = False
                    self._admission_cond.notify_all()

    def _end_switch_wait(self) -> None:
        """No switch is waiting any more; calls held back for it may continue."""

        with self._admission_cond:
            if self._switch_waiting:
                self._switch_waiting = False
                self._admission_cond.notify_all()

    def _create_child(self, executable: Path, policy: OllamaDevicePolicy) -> Any:
        """Start a process. The caller adopts it under ``_lock``."""

        child_env, _ = ollama_child_environment(
            self._base_environment, policy, case_insensitive=self._is_windows
        )
        bind_host = _ollama_server_bind_host(self.host)
        if bind_host:
            child_env["OLLAMA_HOST"] = bind_host
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if self._is_windows else 0
        return self._process_factory(
            [str(executable), "serve"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=child_env,
            creationflags=creationflags,
        )

    def _spawn_server(self, executable: Path, policy: OllamaDevicePolicy) -> Any:
        """Caller holds ``_lock`` for the whole create-and-adopt.

        So close() always finds the child: it takes ``_lock`` before it stops
        what the coordinator references. Each server gets its own log.
        """

        proc = self._create_child(executable, policy)
        self._process = proc
        self._ownership = "owned"
        self._running_preference = self._policy_preference
        self._verification_pending = True
        self._log_parser = OllamaLogParser()
        self._start_drain_thread(proc)
        self._publish_status()
        return proc

    def ensure_running(
        self, timeout_seconds: float = OLLAMA_API_READY_TIMEOUT_SECONDS
    ) -> bool:
        """Ensure the local Ollama server is running with the device policy applied.

        Every start reads the stored device choice, so a choice whose switch
        failed, or that is waiting for a server that has since stopped, is
        applied here. While the switch thread is stopping or starting the
        server, this only probes: that thread owns the restart.
        """

        epoch = self._current_epoch()
        with self._lock:
            try:
                return self._ensure_running_locked(timeout_seconds, epoch)
            finally:
                self._publish_status()

    def _ensure_running_locked(self, timeout_seconds: float, epoch: int) -> bool:
        if self._closed:
            return False
        # Non-local hosts: never spawn; return the probe
        if not self._local_host:
            return self._api_probe(self.host)
        if self._preference_switch_running:
            return self._api_probe(self.host)

        if self._api_probe(self.host):
            # API answers and we own no live process: mark external
            if not self._owns_live_process():
                self._mark_external()
            return True

        with self._admissions_paused_when_idle() as idle:
            if not idle:
                # A busy server can miss one probe; never stop or replace it under a running call.
                return False
            if self._owns_live_process():
                # Our server stopped answering; never run two servers on one port.
                # This is also where a switch whose stop failed is retried.
                if not self._stop_owned_process():
                    return False
                self._ownership = "none"
            started = self._start_owned_server(timeout_seconds)
        if started:
            # The new server read the stored choice, so a waiting switch is done.
            # Cleared only here, once a server answers: a start that fails keeps the choice pending.
            self._switch_left_server_down = False
            self._end_switch_wait()
            self._publish_status(clear_pending_for=epoch)
        return started

    def _mark_external(self) -> None:
        """Caller holds ``_lock``. An external server is never reconfigured."""

        self._ownership = "external"
        self._switch_left_server_down = False
        self._end_switch_wait()
        self._publish_status(pending=False)

    def _owned_policy(self, pinned: OllamaDevicePolicy | None = None) -> OllamaDevicePolicy:
        """Policy for a server this process is about to start. Caller holds ``_lock``.

        The preference is read on every start. A corrected policy is kept only
        while that read still matches the preference the correction was built for.
        """

        return self._choose_owned_policy(
            self._preference_provider(), self._inventory_provider, pinned
        )

    def _choose_owned_policy(
        self,
        preference: OllamaDevicePreference,
        read_inventory: Callable[[], MachineInventorySnapshot | None],
        pinned: OllamaDevicePolicy | None = None,
    ) -> OllamaDevicePolicy:
        """Caller holds ``_lock``. A different choice gets its own corrective restart."""

        current = self._policy
        if (
            self._policy_is_correction
            and current is not None
            and preference == self._policy_preference
        ):
            return pinned if pinned is not None else current
        policy = select_ollama_device_policy(
            read_inventory(),
            platform_name=self._platform_name,
            preference=preference,
        )
        if preference != self._policy_preference:
            self._restarts = 0
            self._device_execution = None
        self._policy = policy
        self._policy_preference = preference
        self._policy_is_correction = False
        return policy

    def _start_owned_server(self, timeout_seconds: float) -> bool:
        policy = self._owned_policy()
        logger.info(
            "Ollama device policy: target=%s, backend=%s, adapter=%s, application=%s, vars=%s",
            policy.target,
            policy.backend,
            policy.adapter_name,
            policy.application,
            policy.environment,
        )

        executable = self._executable_resolver()
        if executable is None:
            return False
        proc = self._spawn_server(executable, policy)

        deadline = self._clock() + max(1.0, timeout_seconds)
        while self._clock() < deadline and not self._closed:
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

        # Readiness timed out or close() ran: stop the process tree so no
        # half-started server keeps the port.
        if not self._stop_owned_process():
            return False
        self._ownership = "none"
        return not self._closed and self._api_probe(self.host)

    @contextmanager
    def admission(self, *, long_running: bool = False):
        """Held by every use of the server. A count, never a held lock.

        SHORT work (the default) is generation and translation. LONG work
        (``long_running=True``) is a model pull and the profile installer's
        pull and create. A restart holds every new call back. A waiting device
        switch holds new calls back only while no LONG work runs, so the
        switch cannot starve and a long download does not freeze generation.
        A call made inside another call on the same thread is not held back.
        """

        depth = getattr(self._admission_depth, "value", 0)
        with self._admission_cond:
            if depth == 0:
                while not self._closed and (
                    self._restarting or (self._switch_waiting and self._long_active == 0)
                ):
                    self._admission_cond.wait()
            if long_running:
                self._long_active += 1
            else:
                self._short_active += 1
        self._admission_depth.value = depth + 1
        try:
            yield
        finally:
            self._admission_depth.value = depth
            with self._admission_cond:
                if long_running:
                    self._long_active -= 1
                else:
                    self._short_active -= 1
                idle = self._short_active + self._long_active == 0
                self._admission_cond.notify_all()
            # The last release wakes the switch thread, also when the call failed.
            # The switch is not done here, so no caller can forget it, and this
            # method takes no other lock.
            if idle:
                self._switch_wakeup.set()

    def after_model_load(self) -> DeviceExecution | None:
        """Verify device execution from logs after model load, with at most one restart.

        While a device choice is waiting or being applied, the load that just
        finished ran on the server being replaced, so it is not verified. This
        method never applies a choice: the switch thread does that when the last
        admission is released, also when the call failed.
        """

        with self._verify_lock:
            with self._status_lock:
                switching = self._preference_switch_pending or self._preference_switch_running
            if switching:
                return self._device_execution
            try:
                return self._verify_latest_load()
            finally:
                self._publish_status()

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
                if not self._hold_for_corrective_restart():
                    # A model download (or another restart) uses the server. Never
                    # stop it under LONG work; verify again at the next model load.
                    self._verification_pending = True
                    return execution
                self._restarts += 1
                self._policy = corrected
                self._policy_is_correction = True
                self._publish_status()
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

    def _hold_for_corrective_restart(self) -> bool:
        """Take the restart hold, unless LONG work, a waiting switch or another restart is on.

        The check and the hold are one critical section, so a download cannot
        start between them.
        """

        with self._admission_cond:
            if (
                self._closed
                or self._long_active > 0
                or self._restarting
                or self._switch_waiting
            ):
                return False
            self._restarting = True
            self._admission_cond.notify_all()
            return True

    def _restart_server(self, new_policy: OllamaDevicePolicy) -> bool:
        """Restart the owned server with the corrected policy. The hold is already taken.

        Waits at most 30 s for running SHORT calls, then restarts anyway.
        """

        try:
            with self._admission_cond:
                deadline = self._clock() + _CORRECTIVE_RESTART_WAIT_SECONDS
                while self._short_active + self._long_active > 0 and not self._closed:
                    remaining = deadline - self._clock()
                    if remaining <= 0:
                        break
                    self._admission_cond.wait(timeout=remaining)

            with self._lock:
                try:
                    # close() may have run while this restart waited for active calls.
                    if self._closed or not self._stop_owned_process():
                        return False

                    executable = self._executable_resolver()
                    if executable is None:
                        self._ownership = "none"
                        return False

                    policy = self._owned_policy(new_policy)
                    logger.info(
                        "Restarting Ollama with corrected policy: "
                        "target=%s, backend=%s, adapter=%s, application=%s, vars=%s",
                        policy.target,
                        policy.backend,
                        policy.adapter_name,
                        policy.application,
                        policy.environment,
                    )
                    proc = self._spawn_server(executable, policy)

                    deadline = self._clock() + 30.0
                    while self._clock() < deadline and not self._closed:
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
                    self._publish_status()
        finally:
            with self._admission_cond:
                self._restarting = False
                self._admission_cond.notify_all()

    def apply_device_preference(self, preference: OllamaDevicePreference) -> None:
        """Ask for the stored choice to be applied. No I/O, no lifecycle lock.

        ``preference`` is the choice just stored. It only decides what the
        status says right away: ``pending`` when the owned server runs another
        choice or a switch is already under way. The switch thread reads the
        stored choice itself, replaces a live owned server once nothing is in
        flight, and leaves an external server alone. Sending the choice the
        server already runs changes nothing.
        """

        with self._status_lock:
            if self._closed:
                return
            self._requested_epoch += 1
            status = self._status
            owned = self._local_host and status.ownership == "owned"
            if (
                status.switch_running
                or status.switch_pending
                or (owned and preference != status.running_preference)
            ):
                self._preference_switch_pending = True
                self._status = replace(status, switch_pending=True)
        self._wake_switch_thread()

    def device_preference_application(self) -> tuple[bool, bool]:
        """``(switch_pending, external_server)`` from the snapshot. Never waits.

        ``external_server`` covers a non-local host and ownership ``external``.
        """

        with self._status_lock:
            status = self._status
        return (status.switch_pending, not self._local_host or status.ownership == "external")

    def cpu_request_override(self) -> str | None:
        """Warning when the stored choice forces CPU, otherwise None.

        Does not change the running policy. A non-Windows machine stays
        unmanaged, so a CPU choice there does not replace the provider's mode.
        """

        preference = self._preference_provider()
        if preference.mode != "cpu":
            return None
        policy = select_ollama_device_policy(
            self._inventory_provider(),
            platform_name=self._platform_name,
            preference=preference,
        )
        if policy.application == "not_applicable" or policy.target != "cpu":
            return None
        return USER_CHOSEN_CPU_EXECUTION_WARNING

    def _wake_switch_thread(self) -> None:
        """Start the switch thread if it is not running, then wake it."""

        with self._switch_thread_lock:
            if self._closed:
                return
            thread = self._switch_thread
            if thread is None or not thread.is_alive():
                thread = threading.Thread(
                    target=self._switch_loop,
                    name="ollama-device-switch",
                    daemon=True,
                )
                self._switch_thread = thread
                thread.start()
        self._switch_wakeup.set()

    def _switch_loop(self) -> None:
        """Wake on a new choice or on the last admission's release; end after close.

        An unexpected error is logged and ends only that pass, never the thread.
        """

        while True:
            self._switch_wakeup.wait()
            self._switch_wakeup.clear()
            if self._closed:
                return
            try:
                self._switch_pass()
            except Exception:
                logger.exception("Ollama device switch failed.")
                try:
                    self._end_switch_wait()
                except Exception:
                    logger.exception("Could not release calls held for a device switch.")

    def _switch_pass(self) -> None:
        """Handle the newest request, or claim a switch that waits for an idle server."""

        epoch = self._current_epoch()
        with self._admission_cond:
            waiting = self._switch_waiting
        if epoch == self._handled_epoch and not waiting:
            return
        # Marked before the read, so a failing read is not retried on every release.
        self._handled_epoch = epoch
        preference = self._preference_provider()
        proc, probe = self._claim_switch(epoch, preference)
        if probe:
            # Nothing owned is running: the choice applies at the next start.
            # A live API there belongs to someone else.
            answered = self._api_probe(self.host)
            with self._lock:
                if answered and not self._closed and not self._owns_live_process():
                    if self._ownership != "external":
                        self._mark_external()
        if proc is not None:
            self._run_switch(proc)

    def _claim_switch(
        self, epoch: int, preference: OllamaDevicePreference
    ) -> tuple[Any | None, bool]:
        """``(process to replace, probe)``. The process comes with new calls held back.

        Lock order is ``_verify_lock``, then ``_lock``, then ``_admission_cond``.
        ``_verify_lock`` keeps a corrective restart and this switch apart. The
        idle decision reads the counts and ``_restarting`` in one critical
        section and takes the hold only when it was clear, so the switch thread
        releases only the hold it took itself.
        """

        with self._verify_lock, self._lock:
            if self._closed:
                return (None, False)
            if not self._local_host or self._ownership == "external":
                self._end_switch_wait()
                self._publish_status(pending=False)
                return (None, False)
            if not self._owns_live_process():
                self._end_switch_wait()
                if not self._switch_left_server_down:
                    self._publish_status(clear_pending_for=epoch)
                return (None, True)
            if preference == self._running_preference:
                # Already running this choice: no restart. A corrected policy and
                # the restart count stay as they are.
                self._end_switch_wait()
                self._publish_status(clear_pending_for=epoch)
                return (None, False)
            with self._admission_cond:
                if self._short_active + self._long_active > 0 or self._restarting:
                    if not self._switch_waiting:
                        self._switch_waiting = True
                    claimed = False
                else:
                    self._restarting = True
                    self._switch_waiting = False
                    claimed = True
            if not claimed:
                self._publish_status(pending=True)
                return (None, False)
            self._publish_status(pending=True, switch_running=True)
            return (self._process, False)

    def _run_switch(self, proc: Any) -> None:
        """Replace ``proc`` with a server for the latest stored choice.

        Holds no coordinator lock while stopping or waiting for the API, so
        health and the preference status keep answering. Ends by releasing
        the hold ``_claim_switch`` took, before anything that can fail.
        """

        try:
            self._replace_owned_server(proc)
        except Exception:
            logger.exception("Ollama device switch failed; the choice stays pending.")
        finally:
            with self._admission_cond:
                self._restarting = False
                self._admission_cond.notify_all()
            self._publish_status(switch_running=False)
            if self._closed:
                self._stop_after_close()

    def _replace_owned_server(self, proc: Any) -> None:
        if not self._stop_switched_process(proc):
            # The old server keeps serving and later calls are not held back. A
            # choice stored during the stop has a newer epoch: the next pass takes it.
            logger.warning("Ollama did not stop for a device switch; the choice stays pending.")
            return
        replacement_ready = False
        try:
            while True:
                started = self._switch_start()
                if started is None:
                    return
                child, epoch, preference = started
                outcome = self._wait_for_switched_api(child)
                if outcome == "closed":
                    return
                if outcome == "external":
                    self._settle_external(child)
                    return
                if outcome == "ready":
                    replacement_ready = True
                    latest = self._current_epoch()
                    if latest != epoch:
                        self._handled_epoch = latest
                        stored = self._stored_preference_or_none()
                        if stored is None:
                            return
                        if stored != preference:
                            # A newer choice was stored after this start read it.
                            if not self._stop_switched_process(child):
                                return
                            replacement_ready = False
                            continue
                        epoch = latest
                    self._publish_status(clear_pending_for=epoch)
                    return
                # Exited or never ready: status stays pending with no server running.
                if not self._stop_switched_process(child):
                    return
                if self._current_epoch() == epoch:
                    logger.warning(
                        "Ollama did not start for a device switch; the next start retries."
                    )
                    return
        finally:
            with self._lock:
                if replacement_ready:
                    self._switch_left_server_down = False
                elif not self._closed and self._ownership != "external":
                    # A later choice cannot be active until ensure_running starts a server.
                    self._switch_left_server_down = True

    def _stored_preference_or_none(self) -> OllamaDevicePreference | None:
        """The stored choice, or None when a failed read must leave it pending."""

        try:
            return self._preference_provider()
        except Exception:
            logger.exception("Could not read the stored device choice; keeping the running server.")
            return None

    def _switch_start(self) -> tuple[Any, int, OllamaDevicePreference] | None:
        """Start a server for the newest stored choice, or None after close.

        The choice and the inventory are read with no lock held. The start
        itself is under ``_lock``, so close() always sees the child.
        """

        epoch = self._current_epoch()
        self._handled_epoch = epoch
        preference = self._preference_provider()
        inventory = self._inventory_provider()
        with self._lock:
            if self._closed:
                return None
            executable = self._executable_resolver()
            if executable is None:
                logger.warning("Ollama is not installed; the device choice stays pending.")
                return None
            policy = self._choose_owned_policy(preference, lambda: inventory)
            logger.info(
                "Switching Ollama to the stored device choice: "
                "target=%s, backend=%s, adapter=%s, application=%s, vars=%s",
                policy.target,
                policy.backend,
                policy.adapter_name,
                policy.application,
                policy.environment,
            )
            return (self._spawn_server(executable, policy), epoch, preference)

    def _stop_switched_process(self, proc: Any) -> bool:
        """Stop ``proc`` without coordinator locks, then forget it if it is still ours."""

        if proc.poll() is None and not self._stop_process_tree(proc):
            return False
        with self._lock:
            if self._process is proc:
                self._process = None
                self._ownership = "none"
            self._publish_status()
        self._join_drain()
        return True

    def _wait_for_switched_api(self, child: Any) -> str:
        """``ready``, ``exited``, ``external``, ``closed`` or ``timeout``. Takes no lock."""

        deadline = self._clock() + OLLAMA_API_READY_TIMEOUT_SECONDS
        while self._clock() < deadline:
            if self._closed:
                return "closed"
            if child.poll() is not None:
                # Our child never became the server. A live API belongs to someone else.
                return "external" if self._api_probe(self.host) else "exited"
            if self._api_probe(self.host):
                return "ready"
            self._sleep(0.5)
        return "timeout"

    def _settle_external(self, child: Any) -> None:
        with self._lock:
            if self._process is child:
                self._process = None
            self._mark_external()

    def _stop_after_close(self) -> None:
        """The switch thread stops what it started when close() ran during the switch."""

        try:
            with self._lock:
                if self._ownership == "owned":
                    if self._stop_owned_process():
                        self._ownership = "none"
                self._publish_status()
        except Exception:
            logger.exception("Could not stop Ollama after close.")

    def note_api_answered(self) -> None:
        """Record that the Ollama API answered.

        A server this process does not own is external. That includes a tray app
        that was already running, and any non-local host. During a switch the
        answer may come from the server being replaced, so it is ignored. When
        a start holds ``_lock``, this is skipped rather than waited for: the
        next health check records it.
        """

        if not self._lock.acquire(blocking=False):
            return
        try:
            if self._closed or self._preference_switch_running or self._owns_live_process():
                return
            self._mark_external()
        finally:
            self._lock.release()

    def device_status(self) -> DeviceStatus:
        """Return one consistent device snapshot for health. Never waits for a restart."""

        with self._status_lock:
            status = self._status
        proc = status.process
        return build_device_status(
            local_host=self._local_host,
            ownership=status.ownership,
            owns_live_process=(
                status.ownership == "owned" and proc is not None and proc.poll() is None
            ),
            policy=status.policy,
            verification_pending=status.verification_pending,
            restarts=status.restarts,
            execution=status.execution,
        )

    def close(self) -> None:
        """Stop the switch thread and an owned server; never touch an external server.

        A switch that has not started is cancelled. One that is stopping or
        starting sees the close between its steps and stops the child it
        started; close() waits for that within a bound sized for two process
        stops, then stops whatever the coordinator still references, so no
        child is left when the interpreter exits right after.
        """

        with self._status_lock:
            self._closed = True
            self._preference_switch_pending = False
        with self._admission_cond:
            self._switch_waiting = False
            self._admission_cond.notify_all()
        self._switch_wakeup.set()
        with self._switch_thread_lock:
            thread = self._switch_thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=_SWITCH_CLOSE_JOIN_SECONDS)
        with self._lock:
            if self._ownership == "owned":
                self._stop_owned_process()
                self._ownership = "none"
            elif self._drain_thread is not None and self._drain_thread.is_alive():
                self._drain_thread.join(timeout=2.0)
            self._publish_status()


__all__ = ["OllamaServerCoordinator"]
