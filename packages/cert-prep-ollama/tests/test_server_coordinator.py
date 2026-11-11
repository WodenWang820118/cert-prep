"""Tests for OllamaServerCoordinator using fakes for processes, probes, and time."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import os
from pathlib import Path
import threading
import time

from cert_prep_contracts.hardware import (
    MachineAcceleratorSnapshot,
    MachineCpuSnapshot,
    MachineInventorySnapshot,
    MachineRamSnapshot,
    MachineStorageSnapshot,
)
from cert_prep_ollama.device_policy import (
    OllamaDevicePreference,
    USER_CHOSEN_CPU_EXECUTION_WARNING,
    adapter_key,
)
from cert_prep_ollama.profile_installer import OllamaProfileInstaller
from cert_prep_ollama.profiles import DEFAULT_PROFILE_ID, profile_by_id
from cert_prep_ollama.server_coordinator import OllamaServerCoordinator


class FakeClock:
    def __init__(self) -> None:
        self.current = 1000.0

    def time(self) -> float:
        return self.current

    def sleep(self, seconds: float) -> None:
        self.current += seconds


class FakeStdout:
    def __init__(self, data: bytes) -> None:
        self._bio = BytesIO(data)
        self.drained = threading.Event()
        if not data:
            self.drained.set()

    def readline(self, size: int = -1) -> bytes:
        chunk = self._bio.readline(size)
        if not chunk:
            self.drained.set()
        return chunk


class FakeProcess:
    def __init__(
        self,
        pid: int = 1234,
        stdout_data: bytes = b"",
        exit_code: int | None = None,
    ) -> None:
        self.pid = pid
        self._returncode = exit_code
        self.stdout = FakeStdout(stdout_data)
        self.env: dict[str, str] | None = None
        self.terminated = False

    def poll(self) -> int | None:
        return self._returncode

    def terminate(self) -> None:
        self.terminated = True
        self._returncode = 0

    def kill(self) -> None:
        self.terminate()

    @property
    def is_running(self) -> bool:
        return self._returncode is None and not self.terminated

    def wait_drained(self, timeout: float = 2.0) -> bool:
        return self.stdout.drained.wait(timeout=timeout)


def _sample_inventory() -> MachineInventorySnapshot:
    # Machine: Radeon 880M integrated, RTX 4060 dedicated w/ UUID
    radeon = MachineAcceleratorSnapshot(
        kind="gpu",
        name="AMD Radeon(TM) 880M Graphics",
        classification="integrated",
        pci_vendor_id="1002",
        pci_device_id="150e",
        dedicated_memory_bytes=298_012_672,
        shared_memory_bytes=16_706_365_440,
    )
    rtx = MachineAcceleratorSnapshot(
        kind="gpu",
        name="NVIDIA GeForce RTX 4060 Laptop GPU",
        classification="dedicated",
        pci_vendor_id="10de",
        pci_device_id="28a0",
        device_id="GPU-3c990263-ad20-7ce7-1ad5-cae44a0d9df3",
        dedicated_memory_bytes=8_342_470_656,
        shared_memory_bytes=16_706_365_440,
    )
    return MachineInventorySnapshot(
        platform="Windows",
        platform_version="10.0.26100",
        architecture="AMD64",
        cpu=MachineCpuSnapshot(architecture="AMD64"),
        ram=MachineRamSnapshot(32 * 1024**3, 16 * 1024**3),
        storage=MachineStorageSnapshot("C:\\", 64 * 1024**3, 128 * 1024**3),
        accelerators=(radeon, rtx),
    )


def test_concurrent_ensure_running_causes_only_one_spawn() -> None:
    spawned_procs: list[FakeProcess] = []
    spawn_lock = threading.Lock()

    def fake_factory(*args, **kwargs):
        proc = FakeProcess(pid=4321, stdout_data=b"Listening on 127.0.0.1:11434\n")
        proc.env = kwargs.get("env")
        with spawn_lock:
            spawned_procs.append(proc)
        return proc

    coordinator = OllamaServerCoordinator(
        host="http://127.0.0.1:11434",
        inventory_provider=_sample_inventory,
        executable_resolver=lambda: Path("C:\\Ollama\\ollama.exe"),
        process_factory=fake_factory,
        api_probe=lambda _host: any(p.is_running for p in spawned_procs),
        tree_terminator=lambda _pid: None,
    )

    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(coordinator.ensure_running) for _ in range(8)]
        results = [f.result() for f in futures]

    assert all(results)
    assert len(spawned_procs) == 1
    assert coordinator.ownership == "owned"


def test_non_local_host_never_spawns() -> None:
    spawn_called = False

    def fake_factory(*args, **kwargs):
        nonlocal spawn_called
        spawn_called = True
        return FakeProcess()

    coordinator = OllamaServerCoordinator(
        host="http://192.168.1.100:11434",
        inventory_provider=_sample_inventory,
        executable_resolver=lambda: Path("C:\\Ollama\\ollama.exe"),
        process_factory=fake_factory,
        api_probe=lambda _host: True,
    )

    ok = coordinator.ensure_running()
    assert ok is True
    assert spawn_called is False
    assert coordinator.ownership == "none"


def test_external_server_detected_no_spawn_and_never_restarted() -> None:
    spawn_called = False

    def fake_factory(*args, **kwargs):
        nonlocal spawn_called
        spawn_called = True
        return FakeProcess()

    coordinator = OllamaServerCoordinator(
        host="http://127.0.0.1:11434",
        inventory_provider=_sample_inventory,
        executable_resolver=lambda: Path("C:\\Ollama\\ollama.exe"),
        process_factory=fake_factory,
        api_probe=lambda _: True,  # API is already responding externally
    )

    ok = coordinator.ensure_running()
    assert ok is True
    assert spawn_called is False
    assert coordinator.ownership == "external"

    execution = coordinator.after_model_load()
    assert execution is not None
    assert execution.state == "unknown"
    assert execution.ownership == "external"
    assert execution.detail == "External Ollama; device selection is managed by Ollama."
    assert spawn_called is False  # Never spawned/restarted


def test_port_race_marks_external_and_reaps_our_process() -> None:
    # Our child exits immediately, but API probe returns True
    reaped = False
    spawned_proc: FakeProcess | None = None

    class ExitedProcess(FakeProcess):
        def poll(self):
            nonlocal reaped
            reaped = True
            return 1

    def fake_factory(*args, **kwargs):
        nonlocal spawned_proc
        spawned_proc = ExitedProcess(pid=5555)
        return spawned_proc

    coordinator = OllamaServerCoordinator(
        host="http://127.0.0.1:11434",
        inventory_provider=_sample_inventory,
        executable_resolver=lambda: Path("C:\\Ollama\\ollama.exe"),
        process_factory=fake_factory,
        api_probe=lambda _host: spawned_proc is not None,  # Port won by external server once spawn attempted
    )

    ok = coordinator.ensure_running()
    assert ok is True
    assert coordinator.ownership == "external"
    assert reaped is True


def test_readiness_timeout_terminates_tree_and_reaps() -> None:
    clock = FakeClock()
    terminated_pids = []
    proc = FakeProcess(pid=9999)

    coordinator = OllamaServerCoordinator(
        host="http://127.0.0.1:11434",
        inventory_provider=_sample_inventory,
        executable_resolver=lambda: Path("C:\\Ollama\\ollama.exe"),
        process_factory=lambda *args, **kwargs: proc,
        api_probe=lambda _host: False,  # API never becomes ready
        tree_terminator=lambda pid: terminated_pids.append(pid),
        clock=clock.time,
        sleep=clock.sleep,
    )

    ok = coordinator.ensure_running(timeout_seconds=5.0)
    assert ok is False
    assert 9999 in terminated_pids
    assert coordinator.ownership == "none"


def test_mismatch_causes_exactly_one_restart_with_corrected_environment() -> None:
    spawn_envs = []
    spawn_count = 0
    terminated_pids = []
    current_proc: FakeProcess | None = None

    rocm_mismatch_log = (
        'time=2026-10-29T17:42:30.310+08:00 msg="inference compute" id=0 filter_id=0 library=ROCm '
        'name=ROCm0 description="AMD Radeon(TM) 880M Graphics" libdirs=ollama,rocm_v7_1\n'
        'time=2026-10-29T17:42:30.310+08:00 msg="inference compute" id=0 filter_id=0 library=CUDA '
        'name=CUDA0 description="NVIDIA GeForce RTX 4060 Laptop GPU" libdirs=ollama,cuda_v13 '
        'pci_id=0000:63:00.0 type=discrete total="8.0 GiB" available="6.9 GiB"\n'
        'msg="starting llama-server"\n'
        'llama_prepare_model_devices: using device ROCm0 (AMD Radeon(TM) 880M Graphics) (0000:65:00.0) - 1000 MiB free\n'
        'load_tensors: offloaded 34/34 layers to GPU\n'
    )

    cuda_verified_log = (
        'msg="starting llama-server"\n'
        'llama_prepare_model_devices: using device CUDA0 (NVIDIA GeForce RTX 4060 Laptop GPU) (0000:63:00.0) - 7000 MiB free\n'
        'load_tensors: offloaded 34/34 layers to GPU\n'
    )

    def fake_factory(*args, **kwargs):
        nonlocal spawn_count, current_proc
        spawn_count += 1
        spawn_envs.append(dict(kwargs.get("env", {})))
        data = rocm_mismatch_log.encode("utf-8") if spawn_count == 1 else cuda_verified_log.encode("utf-8")
        current_proc = FakeProcess(pid=1000 + spawn_count, stdout_data=data)
        return current_proc

    def fake_terminator(pid: int) -> None:
        terminated_pids.append(pid)
        if current_proc is not None and current_proc.pid == pid:
            current_proc.terminate()

    coordinator = OllamaServerCoordinator(
        host="http://127.0.0.1:11434",
        inventory_provider=_sample_inventory,
        executable_resolver=lambda: Path("C:\\Ollama\\ollama.exe"),
        process_factory=fake_factory,
        api_probe=lambda _host: current_proc is not None and current_proc.is_running,
        tree_terminator=fake_terminator,
    )

    # 1. Start server
    assert coordinator.ensure_running() is True
    assert spawn_count == 1
    assert current_proc is not None
    first_proc = current_proc
    assert first_proc.wait_drained() is True

    # 2. First model load -> discovers mismatch and restarts once
    first_execution = coordinator.after_model_load()
    assert first_execution is not None
    assert first_execution.state == "mismatch"
    assert spawn_count == 2
    assert 1001 in terminated_pids

    # Check corrected environment was applied in 2nd spawn
    second_env = spawn_envs[1]
    assert second_env["CUDA_VISIBLE_DEVICES"] == "GPU-3c990263-ad20-7ce7-1ad5-cae44a0d9df3"
    assert second_env["HIP_VISIBLE_DEVICES"] == "-1"
    assert second_env["GGML_VK_VISIBLE_DEVICES"] == "-1"
    assert second_env["OLLAMA_LLM_LIBRARY"] == "cuda_v13"

    # 3. Next model load -> verifies successfully
    assert current_proc is not None
    assert current_proc is not first_proc
    assert current_proc.wait_drained() is True
    second_execution = coordinator.after_model_load()
    assert second_execution is not None
    assert second_execution.state == "verified"
    assert second_execution.restarts == 1
    assert spawn_count == 2  # No further spawns


def test_second_mismatch_does_not_restart_again() -> None:
    spawn_count = 0
    current_proc: FakeProcess | None = None
    persistent_mismatch_log = (
        'time=2026-10-29T17:42:30.310+08:00 msg="inference compute" id=0 filter_id=0 library=CUDA '
        'name=CUDA0 description="NVIDIA GeForce RTX 4060 Laptop GPU" libdirs=ollama,cuda_v13\n'
        'time=2026-10-29T17:42:30.310+08:00 msg="inference compute" id=0 filter_id=0 library=ROCm '
        'name=ROCm0 description="AMD Radeon(TM) 880M Graphics" libdirs=ollama,rocm_v7_1\n'
        'msg="starting llama-server"\n'
        'llama_prepare_model_devices: using device ROCm0 (AMD Radeon(TM) 880M Graphics) (0000:65:00.0) - 1000 MiB free\n'
        'load_tensors: offloaded 34/34 layers to GPU\n'
    )

    def fake_factory(*args, **kwargs):
        nonlocal spawn_count, current_proc
        spawn_count += 1
        current_proc = FakeProcess(
            pid=2000 + spawn_count,
            stdout_data=persistent_mismatch_log.encode("utf-8"),
        )
        return current_proc

    def fake_terminator(pid: int) -> None:
        if current_proc is not None and current_proc.pid == pid:
            current_proc.terminate()

    coordinator = OllamaServerCoordinator(
        host="http://127.0.0.1:11434",
        inventory_provider=_sample_inventory,
        executable_resolver=lambda: Path("C:\\Ollama\\ollama.exe"),
        process_factory=fake_factory,
        api_probe=lambda _host: current_proc is not None and current_proc.is_running,
        tree_terminator=fake_terminator,
    )

    assert coordinator.ensure_running() is True
    assert current_proc is not None
    first_proc = current_proc
    assert first_proc.wait_drained() is True

    # First mismatch restarts
    first_exec = coordinator.after_model_load()
    assert first_exec is not None
    assert first_exec.state == "mismatch"
    assert spawn_count == 2

    assert current_proc is not None
    assert current_proc is not first_proc
    assert current_proc.wait_drained() is True

    # Second mismatch does not restart
    second_exec = coordinator.after_model_load()
    assert second_exec is not None
    assert second_exec.state == "mismatch"
    assert spawn_count == 2  # Still 2, no second restart


def test_restart_waits_for_active_admission_and_blocks_new_ones() -> None:
    clock = FakeClock()
    current_proc: FakeProcess | None = None

    def fake_factory(*args, **kwargs):
        nonlocal current_proc
        current_proc = FakeProcess(pid=3333)
        return current_proc

    coordinator = OllamaServerCoordinator(
        host="http://127.0.0.1:11434",
        inventory_provider=_sample_inventory,
        executable_resolver=lambda: Path("C:\\Ollama\\ollama.exe"),
        process_factory=fake_factory,
        api_probe=lambda _host: current_proc is not None and current_proc.is_running,
        clock=clock.time,
        sleep=clock.sleep,
    )
    assert coordinator.ensure_running() is True
    assert coordinator.policy is not None
    assert current_proc is not None
    assert current_proc.wait_drained() is True

    admission_entered = threading.Event()
    admission_can_exit = threading.Event()
    admission_done = threading.Event()

    def run_admitted_call():
        with coordinator.admission():
            admission_entered.set()
            admission_can_exit.wait()
        admission_done.set()

    thread1 = threading.Thread(target=run_admitted_call)
    thread1.start()
    admission_entered.wait()

    # Now an admission is held. Restarting in thread2 must wait for active admissions to drain.
    restart_started = threading.Event()
    restart_finished = threading.Event()

    active_policy = coordinator.policy

    def run_restart():
        restart_started.set()
        # As _verify_latest_load does: take the hold, then restart.
        assert coordinator._hold_for_corrective_restart() is True
        coordinator._restart_server(active_policy)
        restart_finished.set()

    thread2 = threading.Thread(target=run_restart)
    thread2.start()
    restart_started.wait()

    # Wait explicitly on condition until coordinator enters restarting state
    with coordinator._admission_cond:
        while not coordinator._restarting:
            coordinator._admission_cond.wait(timeout=2.0)

    # Verify that restart is waiting and has not finished
    assert not restart_finished.is_set()

    # Verify that a new admission blocks while coordinator is restarting
    thread3_started = threading.Event()
    new_admission_entered = threading.Event()

    def run_blocked_admission():
        thread3_started.set()
        with coordinator.admission():
            new_admission_entered.set()

    thread3 = threading.Thread(target=run_blocked_admission)
    thread3.start()
    thread3_started.wait()

    assert not new_admission_entered.is_set()

    # Now release active admission (thread1)
    admission_can_exit.set()
    admission_done.wait()

    # Restart (thread2) unblocks and finishes
    thread2.join(timeout=2.0)
    assert restart_finished.is_set()

    # After restart finishes, the blocked admission (thread3) unblocks and enters
    thread3.join(timeout=2.0)
    assert new_admission_entered.is_set()

    thread1.join(timeout=2.0)


def test_missing_logs_gives_unknown_without_restart() -> None:
    spawn_count = 0
    current_proc: FakeProcess | None = None

    def fake_factory(*args, **kwargs):
        nonlocal spawn_count, current_proc
        spawn_count += 1
        current_proc = FakeProcess(pid=4444)
        return current_proc

    coordinator = OllamaServerCoordinator(
        host="http://127.0.0.1:11434",
        inventory_provider=_sample_inventory,
        executable_resolver=lambda: Path("C:\\Ollama\\ollama.exe"),
        process_factory=fake_factory,
        api_probe=lambda _host: current_proc is not None and current_proc.is_running,
    )
    assert coordinator.ensure_running() is True
    assert spawn_count == 1
    assert current_proc is not None
    assert current_proc.wait_drained() is True

    # No logs fed into coordinator._log_parser
    execution = coordinator.after_model_load()
    assert execution is not None
    assert execution.state == "unknown"
    assert "Missing logs" in execution.detail
    assert spawn_count == 1  # No restart


def test_close_terminates_only_our_process_tree() -> None:
    terminated_pids = []
    spawned_proc: FakeProcess | None = None

    def fake_factory(*args, **kwargs):
        nonlocal spawned_proc
        spawned_proc = FakeProcess(pid=7777)
        return spawned_proc

    def fake_terminator(pid: int) -> None:
        terminated_pids.append(pid)
        if spawned_proc is not None and spawned_proc.pid == pid:
            spawned_proc.terminate()

    coordinator = OllamaServerCoordinator(
        host="http://127.0.0.1:11434",
        inventory_provider=_sample_inventory,
        executable_resolver=lambda: Path("C:\\Ollama\\ollama.exe"),
        process_factory=fake_factory,
        api_probe=lambda _host: spawned_proc is not None and spawned_proc.is_running,
        tree_terminator=fake_terminator,
    )
    assert coordinator.ensure_running() is True
    assert coordinator.ownership == "owned"

    coordinator.close()
    assert 7777 in terminated_pids
    assert coordinator.ownership == "none"

    # Closing an external coordinator does nothing
    coordinator_ext = OllamaServerCoordinator(
        host="http://127.0.0.1:11434",
        api_probe=lambda _: True,
        tree_terminator=lambda pid: terminated_pids.append(pid),
    )
    assert coordinator_ext.ensure_running() is True
    assert coordinator_ext.ownership == "external"

    count_before = len(terminated_pids)
    coordinator_ext.close()
    assert len(terminated_pids) == count_before  # Untouched


_ROCM_MISMATCH_LOG = (
    'msg="inference compute" id=0 filter_id=0 library=ROCm name=ROCm0 '
    'description="AMD Radeon(TM) 880M Graphics" libdirs=ollama,rocm_v7_1\n'
    'msg="inference compute" id=0 filter_id=0 library=CUDA name=CUDA0 '
    'description="NVIDIA GeForce RTX 4060 Laptop GPU" libdirs=ollama,cuda_v13 '
    'pci_id=0000:63:00.0 type=discrete total="8.0 GiB" available="6.9 GiB"\n'
    'msg="starting llama-server"\n'
    "llama_prepare_model_devices: using device ROCm0 (AMD Radeon(TM) 880M Graphics) "
    "(0000:65:00.0) - 1000 MiB free\n"
    "load_tensors: offloaded 34/34 layers to GPU\n"
)
_CUDA_VERIFIED_LOG = (
    'msg="starting llama-server"\n'
    "llama_prepare_model_devices: using device CUDA0 (NVIDIA GeForce RTX 4060 Laptop GPU) "
    "(0000:63:00.0) - 7000 MiB free\n"
    "load_tensors: offloaded 34/34 layers to GPU\n"
)


class _ProcessFleet:
    """Spawns fake servers whose logs are given in order and tracks which are running."""

    def __init__(self, *logs: str) -> None:
        self.logs = list(logs)
        self.procs: list[FakeProcess] = []
        self.terminated: list[int] = []
        self.answering = True

    def spawn(self, *args, **kwargs) -> FakeProcess:
        log = self.logs[len(self.procs)] if len(self.procs) < len(self.logs) else ""
        self.procs.append(FakeProcess(pid=5000 + len(self.procs), stdout_data=log.encode("utf-8")))
        return self.procs[-1]

    def terminate(self, pid: int) -> None:
        self.terminated.append(pid)
        for proc in self.procs:
            if proc.pid == pid:
                proc.terminate()

    def probe(self, _host: str) -> bool:
        return self.answering and any(proc.is_running for proc in self.procs)

    def coordinator(
        self,
        clock: FakeClock | None = None,
        host: str = "http://127.0.0.1:11434",
        inventory_provider=None,
    ) -> OllamaServerCoordinator:
        timing = {} if clock is None else {"clock": clock.time, "sleep": clock.sleep}
        return OllamaServerCoordinator(
            host=host,
            inventory_provider=inventory_provider or _sample_inventory,
            executable_resolver=lambda: Path("C:\\Ollama\\ollama.exe"),
            process_factory=self.spawn,
            api_probe=self.probe,
            tree_terminator=self.terminate,
            **timing,
        )


def test_concurrent_verifications_restart_the_server_once() -> None:
    fleet = _ProcessFleet(_ROCM_MISMATCH_LOG, _CUDA_VERIFIED_LOG)
    coordinator = fleet.coordinator()
    assert coordinator.ensure_running() is True
    assert fleet.procs[0].wait_drained() is True

    with ThreadPoolExecutor(max_workers=4) as pool:
        states = list(pool.map(lambda _: coordinator.after_model_load().state, range(4)))

    assert len(fleet.procs) == 2
    assert states.count("mismatch") == 1
    assert fleet.terminated == [5000]


def test_verification_after_a_restart_waits_for_the_new_servers_load() -> None:
    fleet = _ProcessFleet(_ROCM_MISMATCH_LOG, "")
    coordinator = fleet.coordinator()
    assert coordinator.ensure_running() is True
    assert fleet.procs[0].wait_drained() is True
    assert coordinator.after_model_load().state == "mismatch"
    assert len(fleet.procs) == 2

    # A call that finished on the old server finds no load on the new one yet.
    assert coordinator.after_model_load().state == "unknown"

    # The new server's first load is still verified afterwards, and the old log is gone.
    coordinator._log_parser.feed(_CUDA_VERIFIED_LOG)
    verified = coordinator.after_model_load()
    assert verified.state == "verified"
    assert verified.restarts == 1
    assert len(fleet.procs) == 2


def test_an_unresponsive_owned_server_is_stopped_before_a_new_one_starts() -> None:
    fleet = _ProcessFleet()
    coordinator = fleet.coordinator(FakeClock())
    assert coordinator.ensure_running() is True

    fleet.answering = False
    assert coordinator.ensure_running(timeout_seconds=1.0) is False

    assert fleet.terminated[0] == 5000
    assert len(fleet.procs) == 2
    assert not any(proc.is_running for proc in fleet.procs)
    assert coordinator.ownership == "none"


def test_a_server_that_misses_a_probe_during_a_call_is_left_running() -> None:
    fleet = _ProcessFleet()
    coordinator = fleet.coordinator(FakeClock())
    assert coordinator.ensure_running() is True

    fleet.answering = False
    with coordinator.admission():
        assert coordinator.ensure_running(timeout_seconds=1.0) is False

    assert fleet.terminated == []
    assert len(fleet.procs) == 1
    assert coordinator.ownership == "owned"


def test_a_server_that_will_not_exit_is_never_joined_by_a_second_one() -> None:
    fleet = _ProcessFleet()
    coordinator = fleet.coordinator(FakeClock())
    assert coordinator.ensure_running() is True
    # Both the tree kill and kill() fail to stop it.
    fleet.procs[0].terminate = lambda: None

    fleet.answering = False
    assert coordinator.ensure_running(timeout_seconds=1.0) is False

    assert len(fleet.procs) == 1
    assert coordinator.ownership == "owned"


def test_close_during_a_pending_restart_leaves_no_server_running() -> None:
    fleet = _ProcessFleet(_ROCM_MISMATCH_LOG, _CUDA_VERIFIED_LOG)
    coordinator = fleet.coordinator()
    assert coordinator.ensure_running() is True
    assert fleet.procs[0].wait_drained() is True

    entered = threading.Event()
    release = threading.Event()

    def admitted_call() -> None:
        with coordinator.admission():
            entered.set()
            release.wait(timeout=5.0)

    call = threading.Thread(target=admitted_call)
    call.start()
    assert entered.wait(timeout=5.0)
    # The mismatch's restart now waits for the running call.
    verification = threading.Thread(target=coordinator.after_model_load)
    verification.start()
    with coordinator._admission_cond:
        for _ in range(10):
            if coordinator._restarting:
                break
            coordinator._admission_cond.wait(timeout=0.5)
    assert coordinator._restarting

    coordinator.close()
    release.set()
    call.join(timeout=5.0)
    verification.join(timeout=5.0)

    assert len(fleet.procs) == 1
    assert not any(proc.is_running for proc in fleet.procs)
    assert coordinator.ownership == "none"


def test_log_lines_reach_verification_while_the_server_keeps_running() -> None:
    read_fd, write_fd = os.pipe()
    reader = os.fdopen(read_fd, "rb")
    proc = FakeProcess(pid=4321)
    proc.stdout = reader
    spawned: list[FakeProcess] = []

    def spawn(*args, **kwargs) -> FakeProcess:
        spawned.append(proc)
        return proc

    coordinator = OllamaServerCoordinator(
        host="http://127.0.0.1:11434",
        inventory_provider=_sample_inventory,
        executable_resolver=lambda: Path("C:\\Ollama\\ollama.exe"),
        process_factory=spawn,
        api_probe=lambda _host: bool(spawned) and proc.is_running,
        tree_terminator=lambda _pid: proc.terminate(),
    )
    try:
        assert coordinator.ensure_running() is True
        # The pipe stays open, as with a live server; whole lines must still arrive.
        os.write(write_fd, _CUDA_VERIFIED_LOG.encode("utf-8"))
        deadline = time.monotonic() + 5.0
        while coordinator.after_model_load().state != "verified" and time.monotonic() < deadline:
            time.sleep(0.05)
        assert coordinator.after_model_load().state == "verified"
    finally:
        os.close(write_fd)
        coordinator.close()
        reader.close()


def test_an_ipv6_loopback_host_starts_a_local_server() -> None:
    fleet = _ProcessFleet()
    coordinator = fleet.coordinator(host="http://[::1]:11434")

    assert coordinator.ensure_running() is True
    assert len(fleet.procs) == 1
    assert coordinator.ownership == "owned"


_CUDA_FIXTURE = (
    Path(__file__).parent / "fixtures" / "ollama_0_40_13" / "cuda-dgpu-hip-hidden.log"
).read_text(encoding="utf-8")
_PARTIAL_OFFLOAD_LOG = (
    'msg="starting llama-server"\n'
    "llama_prepare_model_devices: using device CUDA0 "
    "(NVIDIA GeForce RTX 4060 Laptop GPU) (0000:63:00.0) - 7000 MiB free\n"
    "load_tensors: offloaded 32/33 layers to GPU\n"
)
_CPU_VERIFIED_LOG = (
    'msg="starting llama-server"\n'
    "load_backend: loaded CPU backend from "
    "C:\\Ollama\\lib\\ollama\\ggml-cpu-zen4.dll\n"
    "load_tensors: offloaded 0/34 layers to GPU\n"
)
_SCHEDULER_ONLY_LOG = (
    'msg="selecting single GPU for llama-server model" library=CUDA name=CUDA0 '
    'description="NVIDIA GeForce RTX 4060 Laptop GPU" integrated=false id=0 filter_id=0\n'
    'msg="starting llama-server"\n'
)
_UNCORRECTABLE_MISMATCH_LOG = (
    'msg="inference compute" id=0 filter_id=0 library=ROCm name=ROCm0 '
    'description="AMD Radeon(TM) 880M Graphics" libdirs=ollama,rocm_v7_1\n'
    'msg="starting llama-server"\n'
    "llama_prepare_model_devices: using device ROCm0 (AMD Radeon(TM) 880M Graphics) "
    "(0000:65:00.0) - 1000 MiB free\n"
    "load_tensors: offloaded 34/34 layers to GPU\n"
)


def _cpu_inventory() -> MachineInventorySnapshot:
    sample = _sample_inventory()
    return MachineInventorySnapshot(
        platform=sample.platform,
        platform_version=sample.platform_version,
        architecture=sample.architecture,
        cpu=sample.cpu,
        ram=sample.ram,
        storage=sample.storage,
        accelerators=(),
    )


def _unknown_gpu_inventory() -> MachineInventorySnapshot:
    sample = _sample_inventory()
    unknown = MachineAcceleratorSnapshot(
        kind="gpu",
        name="Unrecognized Graphics",
        classification="unknown",
    )
    return MachineInventorySnapshot(
        platform=sample.platform,
        platform_version=sample.platform_version,
        architecture=sample.architecture,
        cpu=sample.cpu,
        ram=sample.ram,
        storage=sample.storage,
        accelerators=(unknown,),
    )


def _assert_requested_matches_policy(status, coordinator: OllamaServerCoordinator) -> None:
    policy = coordinator.policy
    assert policy is not None
    assert status.requested is not None
    assert status.requested.target == policy.target
    assert status.requested.backend == policy.backend
    assert status.requested.adapter_name == policy.adapter_name


def test_device_status_when_ollama_is_not_running() -> None:
    coordinator = OllamaServerCoordinator(host="http://127.0.0.1:11434")

    status = coordinator.device_status()

    assert status.server == "not_running"
    assert status.requested is None
    assert status.verification == "not_observable"
    assert status.observed is None
    assert status.corrective_restarts == 0


def test_device_status_when_ollama_is_not_installed() -> None:
    coordinator = OllamaServerCoordinator(
        host="http://127.0.0.1:11434",
        executable_resolver=lambda: None,
        api_probe=lambda _host: False,
    )

    assert coordinator.ensure_running() is False
    status = coordinator.device_status()

    assert status.server == "not_running"
    assert status.requested is None
    assert status.verification == "not_observable"
    assert status.observed is None
    assert status.corrective_restarts == 0


def test_device_status_before_the_first_load_is_pending() -> None:
    fleet = _ProcessFleet("")
    coordinator = fleet.coordinator()
    assert coordinator.ensure_running() is True

    status = coordinator.device_status()

    assert status.server == "owned"
    assert status.verification == "pending"
    assert status.observed is None
    assert status.corrective_restarts == 0
    _assert_requested_matches_policy(status, coordinator)
    assert status.requested.target == "dedicated_gpu"
    assert status.requested.backend == "cuda"
    coordinator.note_api_answered()
    assert coordinator.ownership == "owned"
    assert coordinator.device_status().server == "owned"


def test_device_status_with_missing_logs_stays_pending() -> None:
    fleet = _ProcessFleet("")
    coordinator = fleet.coordinator()
    assert coordinator.ensure_running() is True
    assert fleet.procs[0].wait_drained() is True

    execution = coordinator.after_model_load()

    assert execution is not None
    assert execution.state == "unknown"
    status = coordinator.device_status()
    assert status.server == "owned"
    assert status.verification == "pending"
    assert status.observed is None
    assert status.corrective_restarts == 0
    _assert_requested_matches_policy(status, coordinator)


def test_device_status_with_only_a_scheduler_choice_is_pending() -> None:
    fleet = _ProcessFleet(_SCHEDULER_ONLY_LOG)
    coordinator = fleet.coordinator()
    assert coordinator.ensure_running() is True
    assert fleet.procs[0].wait_drained() is True

    execution = coordinator.after_model_load()

    assert execution is not None
    assert execution.state == "selected_unverified"
    status = coordinator.device_status()
    assert status.verification == "pending"
    assert status.observed is None
    assert status.corrective_restarts == 0
    assert len(fleet.procs) == 1
    _assert_requested_matches_policy(status, coordinator)


def test_device_status_reports_a_verified_partial_offload() -> None:
    fleet = _ProcessFleet(_PARTIAL_OFFLOAD_LOG)
    coordinator = fleet.coordinator()
    assert coordinator.ensure_running() is True
    assert fleet.procs[0].wait_drained() is True

    assert coordinator.after_model_load().state == "verified"
    status = coordinator.device_status()

    assert status.server == "owned"
    assert status.verification == "verified"
    assert status.corrective_restarts == 0
    assert status.observed is not None
    assert status.observed.backend == "cuda"
    assert status.observed.adapter_name == "NVIDIA GeForce RTX 4060 Laptop GPU"
    assert status.observed.offloaded_layers == 32
    assert status.observed.total_layers == 33
    _assert_requested_matches_policy(status, coordinator)


def test_device_status_after_a_restart_is_pending_until_the_new_server_loads() -> None:
    fleet = _ProcessFleet(_ROCM_MISMATCH_LOG, "")
    coordinator = fleet.coordinator()
    assert coordinator.ensure_running() is True
    assert fleet.procs[0].wait_drained() is True

    execution = coordinator.after_model_load()

    assert execution is not None
    assert execution.state == "mismatch"
    assert execution.restarts == 0
    assert len(fleet.procs) == 2
    status = coordinator.device_status()
    assert status.server == "owned"
    assert status.verification == "pending"
    assert status.observed is None
    assert status.corrective_restarts == 1
    _assert_requested_matches_policy(status, coordinator)
    assert status.requested.backend == "cuda"


def test_device_status_reports_the_second_mismatch_without_another_restart() -> None:
    fleet = _ProcessFleet(_ROCM_MISMATCH_LOG, _ROCM_MISMATCH_LOG)
    coordinator = fleet.coordinator()
    assert coordinator.ensure_running() is True
    assert fleet.procs[0].wait_drained() is True
    assert coordinator.after_model_load().state == "mismatch"
    assert fleet.procs[1].wait_drained() is True

    second = coordinator.after_model_load()

    assert second is not None
    assert second.state == "mismatch"
    assert len(fleet.procs) == 2
    status = coordinator.device_status()
    assert status.server == "owned"
    assert status.verification == "mismatch"
    assert status.corrective_restarts == 1
    assert status.observed is not None
    assert status.observed.backend == "rocm"
    assert status.observed.adapter_name == "AMD Radeon(TM) 880M Graphics"
    assert status.observed.offloaded_layers == 34
    assert status.observed.total_layers == 34
    _assert_requested_matches_policy(status, coordinator)


def test_device_status_keeps_a_mismatch_when_no_correction_can_be_derived() -> None:
    fleet = _ProcessFleet(_UNCORRECTABLE_MISMATCH_LOG)
    coordinator = fleet.coordinator()
    assert coordinator.ensure_running() is True
    assert fleet.procs[0].wait_drained() is True

    execution = coordinator.after_model_load()

    assert execution is not None
    assert execution.state == "mismatch"
    assert len(fleet.procs) == 1
    status = coordinator.device_status()
    assert status.verification == "mismatch"
    assert status.corrective_restarts == 0
    assert status.observed is not None
    assert status.observed.backend == "rocm"
    assert status.observed.adapter_name == "AMD Radeon(TM) 880M Graphics"
    _assert_requested_matches_policy(status, coordinator)
    assert status.requested.target == "dedicated_gpu"
    assert status.requested.backend == "cuda"


def test_device_status_reports_verified_cpu_with_no_offloaded_layers() -> None:
    fleet = _ProcessFleet(_CPU_VERIFIED_LOG)
    coordinator = fleet.coordinator(inventory_provider=_cpu_inventory)
    assert coordinator.ensure_running() is True
    assert fleet.procs[0].wait_drained() is True

    assert coordinator.after_model_load().state == "verified"
    status = coordinator.device_status()

    assert status.server == "owned"
    assert status.verification == "verified"
    assert status.corrective_restarts == 0
    assert status.requested is not None
    assert status.requested.target == "cpu"
    assert status.requested.backend == "cpu"
    assert status.observed is not None
    assert status.observed.backend == "cpu"
    assert status.observed.offloaded_layers == 0
    assert status.observed.total_layers == 34


def test_device_status_reports_an_unmanaged_server_from_its_log() -> None:
    fleet = _ProcessFleet(_CUDA_FIXTURE)
    coordinator = fleet.coordinator(inventory_provider=_unknown_gpu_inventory)
    assert coordinator.ensure_running() is True
    assert fleet.procs[0].wait_drained() is True

    execution = coordinator.after_model_load()

    assert execution is not None
    assert execution.state == "unknown"
    assert len(fleet.procs) == 1
    status = coordinator.device_status()
    assert status.server == "owned"
    assert status.verification == "unknown"
    assert status.corrective_restarts == 0
    assert status.requested is not None
    assert status.requested.target == "unmanaged"
    assert status.requested.backend is None
    assert status.observed is not None
    assert status.observed.backend == "cuda"
    assert status.observed.adapter_name == "NVIDIA GeForce RTX 4060 Laptop GPU"
    assert status.observed.offloaded_layers == 34
    assert status.observed.total_layers == 34


def test_device_status_verified_after_the_corrective_restart() -> None:
    fleet = _ProcessFleet(_ROCM_MISMATCH_LOG, _CUDA_VERIFIED_LOG)
    coordinator = fleet.coordinator()
    assert coordinator.ensure_running() is True
    assert fleet.procs[0].wait_drained() is True
    assert coordinator.after_model_load().state == "mismatch"
    assert fleet.procs[1].wait_drained() is True

    assert coordinator.after_model_load().state == "verified"
    status = coordinator.device_status()

    assert status.verification == "verified"
    assert status.corrective_restarts == 1
    assert status.observed is not None
    assert status.observed.backend == "cuda"
    assert status.observed.adapter_name == "NVIDIA GeForce RTX 4060 Laptop GPU"
    assert status.observed.offloaded_layers == 34
    assert status.observed.total_layers == 34
    _assert_requested_matches_policy(status, coordinator)


def test_note_api_answered_marks_a_tray_server_external_without_spawning() -> None:
    spawned = False

    def factory(*_args, **_kwargs):
        nonlocal spawned
        spawned = True
        return FakeProcess()

    coordinator = OllamaServerCoordinator(
        host="http://127.0.0.1:11434",
        process_factory=factory,
        api_probe=lambda _host: True,
    )
    assert coordinator.ownership == "none"

    coordinator.note_api_answered()

    assert spawned is False
    assert coordinator.ownership == "external"
    status = coordinator.device_status()
    assert status.server == "external"
    assert status.requested is None
    assert status.verification == "not_observable"
    assert status.observed is None
    assert status.corrective_restarts == 0


def test_device_status_reports_a_non_local_host_as_external() -> None:
    coordinator = OllamaServerCoordinator(
        host="http://192.168.1.100:11434",
        process_factory=lambda *_args, **_kwargs: FakeProcess(),
        api_probe=lambda _host: True,
    )

    assert coordinator.ensure_running() is True
    assert coordinator.ownership == "none"
    status = coordinator.device_status()
    assert status.server == "external"
    assert status.requested is None
    assert status.verification == "not_observable"
    assert status.observed is None
    assert status.corrective_restarts == 0

    coordinator.note_api_answered()
    assert coordinator.ownership == "external"
    assert coordinator.device_status().server == "external"


_RTX_UUID = "GPU-3c990263-ad20-7ce7-1ad5-cae44a0d9df3"


def _owned_server(preference_provider, *, clock: FakeClock | None = None):
    """Coordinator whose child environment is only the policy plus PATH."""

    procs: list[FakeProcess] = []
    accepting = {"value": True}
    timing = {} if clock is None else {"clock": clock.time, "sleep": clock.sleep}

    def spawn(*_args, **kwargs) -> FakeProcess:
        proc = FakeProcess(pid=8000 + len(procs))
        proc.env = dict(kwargs.get("env") or {})
        procs.append(proc)
        return proc

    def terminate(pid: int) -> None:
        for proc in procs:
            if proc.pid == pid:
                proc.terminate()

    def probe(_host: str) -> bool:
        return accepting["value"] and any(proc.is_running for proc in procs)

    coordinator = OllamaServerCoordinator(
        host="http://127.0.0.1:11434",
        inventory_provider=_sample_inventory,
        executable_resolver=lambda: Path("C:\\Ollama\\ollama.exe"),
        process_factory=spawn,
        api_probe=probe,
        tree_terminator=terminate,
        base_environment={"PATH": "C:\\Windows\\System32"},
        platform_name="Windows",
        preference_provider=preference_provider,
        **timing,
    )
    return coordinator, procs, accepting


def test_each_owned_start_reads_the_device_preference() -> None:
    clock = FakeClock()
    current = {
        "preference": OllamaDevicePreference(
            mode="adapter",
            adapter_key="0123456789abcdef",
            adapter_name="Missing Adapter",
            pci_vendor_id="ffff",
            pci_device_id="ffff",
        )
    }
    reads: list[OllamaDevicePreference] = []

    def provider() -> OllamaDevicePreference:
        reads.append(current["preference"])
        return current["preference"]

    coordinator, procs, accepting = _owned_server(provider, clock=clock)
    assert coordinator.ensure_running() is True
    assert len(reads) == 1
    assert coordinator.policy is not None
    assert coordinator.policy.application == "adapter_missing"
    assert procs[0].env is not None
    assert procs[0].env["CUDA_VISIBLE_DEVICES"] == _RTX_UUID
    assert procs[0].env["OLLAMA_VULKAN"] == "0"
    assert "OLLAMA_LLM_LIBRARY" not in procs[0].env

    current["preference"] = OllamaDevicePreference(mode="cpu")
    accepting["value"] = False
    assert coordinator.ensure_running(timeout_seconds=1.0) is False
    assert len(reads) == 2
    assert reads[1].mode == "cpu"
    assert coordinator.policy is not None
    assert coordinator.policy.target == "cpu"
    assert coordinator.policy.application == "applied"
    assert procs[1].env is not None
    assert procs[1].env["CUDA_VISIBLE_DEVICES"] == "-1"
    assert procs[1].env["HIP_VISIBLE_DEVICES"] == "-1"
    assert procs[1].env["GGML_VK_VISIBLE_DEVICES"] == "-1"
    assert procs[1].env["OLLAMA_VULKAN"] == "0"
    assert procs[1].env["OLLAMA_IGPU_ENABLE"] == "0"
    assert "OLLAMA_LLM_LIBRARY" not in procs[1].env


def test_corrected_policy_is_reused_only_for_the_same_preference() -> None:
    clock = FakeClock()
    current = {"preference": OllamaDevicePreference()}
    reads: list[str] = []

    def provider() -> OllamaDevicePreference:
        reads.append(current["preference"].mode)
        return current["preference"]

    mismatch_log = (
        'time=2026-10-29T17:42:30.310+08:00 msg="inference compute" id=0 filter_id=0 '
        'library=ROCm name=ROCm0 description="AMD Radeon(TM) 880M Graphics" '
        "libdirs=ollama,rocm_v7_1\n"
        'time=2026-10-29T17:42:30.310+08:00 msg="inference compute" id=0 filter_id=0 '
        'library=CUDA name=CUDA0 description="NVIDIA GeForce RTX 4060 Laptop GPU" '
        'libdirs=ollama,cuda_v13 pci_id=0000:63:00.0 type=discrete total="8.0 GiB" '
        'available="6.9 GiB"\n'
        'msg="starting llama-server"\n'
        "llama_prepare_model_devices: using device ROCm0 (AMD Radeon(TM) 880M Graphics) "
        "(0000:65:00.0) - 1000 MiB free\n"
        "load_tensors: offloaded 34/34 layers to GPU\n"
    )
    coordinator, procs, accepting = _owned_server(provider, clock=clock)
    real_spawn = coordinator._process_factory

    def spawn(*args, **kwargs):
        proc = real_spawn(*args, **kwargs)
        if len(procs) == 1:
            proc.stdout = FakeStdout(mismatch_log.encode("utf-8"))
        return proc

    coordinator._process_factory = spawn

    assert coordinator.ensure_running() is True
    assert len(reads) == 1
    assert procs[0].wait_drained() is True
    assert procs[0].env is not None
    assert "OLLAMA_LLM_LIBRARY" not in procs[0].env

    execution = coordinator.after_model_load()
    assert execution is not None
    assert execution.state == "mismatch"
    assert len(procs) == 2
    assert len(reads) == 2
    assert procs[1].env is not None
    assert procs[1].env["OLLAMA_LLM_LIBRARY"] == "cuda_v13"
    assert procs[1].env["CUDA_VISIBLE_DEVICES"] == _RTX_UUID

    accepting["value"] = False
    assert coordinator.ensure_running(timeout_seconds=1.0) is False
    assert len(reads) == 3
    assert procs[2].env == procs[1].env

    current["preference"] = OllamaDevicePreference(mode="cpu")
    assert coordinator.ensure_running(timeout_seconds=1.0) is False
    assert len(reads) == 4
    assert reads[3] == "cpu"
    assert procs[3].env is not None
    assert procs[3].env["CUDA_VISIBLE_DEVICES"] == "-1"
    assert procs[3].env["OLLAMA_VULKAN"] == "0"
    assert procs[3].env["OLLAMA_IGPU_ENABLE"] == "0"
    assert "OLLAMA_LLM_LIBRARY" not in procs[3].env
    assert coordinator.policy is not None
    assert coordinator.policy.target == "cpu"


def _cpu_env(env: dict[str, str] | None) -> None:
    assert env is not None
    assert env["CUDA_VISIBLE_DEVICES"] == "-1"
    assert env["HIP_VISIBLE_DEVICES"] == "-1"
    assert env["GGML_VK_VISIBLE_DEVICES"] == "-1"
    assert env["OLLAMA_VULKAN"] == "0"
    assert env["OLLAMA_IGPU_ENABLE"] == "0"


def _wait_until(predicate, timeout: float = 5.0) -> None:
    """Wait until the preference thread has done its work. It is a daemon, so join does not end it."""

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        threading.Event().wait(0.01)
    assert predicate()


def _promptly(action, timeout: float = 5.0):
    """Run ``action`` on another thread and require it to return within ``timeout``."""

    done = threading.Event()
    result: list[object] = []

    def run() -> None:
        try:
            result.append(action())
        except BaseException as exc:  # noqa: BLE001 - re-raised on the test thread
            result.append(exc)
        finally:
            done.set()

    threading.Thread(target=run, daemon=True).start()
    assert done.wait(timeout=timeout), "the call waited instead of answering"
    value = result[0]
    if isinstance(value, BaseException):
        raise value
    return value


def test_an_idle_owned_server_restarts_once_when_the_choice_changes() -> None:
    current = {"preference": OllamaDevicePreference()}
    coordinator, procs, _accepting = _owned_server(lambda: current["preference"], clock=FakeClock())
    assert coordinator.ensure_running() is True
    assert procs[0].env is not None
    assert procs[0].env["CUDA_VISIBLE_DEVICES"] == _RTX_UUID

    current["preference"] = OllamaDevicePreference(mode="cpu")
    coordinator.apply_device_preference(current["preference"])
    _wait_until(
        lambda: len(procs) == 2 and coordinator.device_preference_application() == (False, False)
    )

    assert procs[0].poll() is not None
    _cpu_env(procs[1].env)
    assert coordinator._restarts == 0


def test_a_choice_during_a_running_call_waits_and_skips_the_old_load() -> None:
    current = {"preference": OllamaDevicePreference()}
    coordinator, procs, _accepting = _owned_server(lambda: current["preference"], clock=FakeClock())
    real_spawn = coordinator._process_factory

    def spawn(*args, **kwargs):
        proc = real_spawn(*args, **kwargs)
        if len(procs) == 1:
            proc.stdout = FakeStdout(_ROCM_MISMATCH_LOG.encode("utf-8"))
        return proc

    coordinator._process_factory = spawn
    assert coordinator.ensure_running() is True
    assert procs[0].wait_drained() is True

    entered = threading.Event()
    release = threading.Event()

    def admitted() -> None:
        with coordinator.admission():
            entered.set()
            assert release.wait(timeout=5.0)

    call = threading.Thread(target=admitted)
    call.start()
    assert entered.wait(timeout=5.0)
    current["preference"] = OllamaDevicePreference(mode="cpu")
    coordinator.apply_device_preference(current["preference"])
    assert coordinator.device_preference_application() == (True, False)
    assert len(procs) == 1
    assert procs[0].poll() is None

    release.set()
    call.join(timeout=5.0)
    _wait_until(
        lambda: len(procs) == 2 and coordinator.device_preference_application() == (False, False)
    )
    _cpu_env(procs[1].env)
    assert coordinator._restarts == 0
    # The load that was in flight used the previous server, so it is not verified.
    coordinator.after_model_load()
    assert len(procs) == 2
    assert coordinator._restarts == 0


def test_ensure_running_applies_a_deferred_choice_without_the_restart_deadline() -> None:
    current = {"preference": OllamaDevicePreference()}
    coordinator, procs, _accepting = _owned_server(lambda: current["preference"], clock=FakeClock())
    assert coordinator.ensure_running() is True

    entered = threading.Event()
    release = threading.Event()

    def admitted() -> None:
        with coordinator.admission():
            entered.set()
            assert release.wait(timeout=5.0)

    call = threading.Thread(target=admitted)
    call.start()
    assert entered.wait(timeout=5.0)
    current["preference"] = OllamaDevicePreference(mode="cpu")
    coordinator.apply_device_preference(current["preference"])
    assert coordinator.ensure_running() is True
    assert len(procs) == 1
    assert procs[0].poll() is None

    release.set()
    call.join(timeout=5.0)
    _wait_until(
        lambda: len(procs) == 2 and coordinator.device_preference_application() == (False, False)
    )
    _cpu_env(procs[1].env)
    assert coordinator.ensure_running() is True
    assert len(procs) == 2


def test_apply_does_not_reconfigure_an_external_server() -> None:
    spawned = {"count": 0}

    def factory(*_args, **_kwargs):
        spawned["count"] += 1
        raise AssertionError("an external server must not be spawned")

    coordinator = OllamaServerCoordinator(
        host="http://127.0.0.1:11434",
        inventory_provider=_sample_inventory,
        executable_resolver=lambda: Path("ollama"),
        process_factory=factory,
        api_probe=lambda _host: True,
        platform_name="Windows",
        preference_provider=lambda: OllamaDevicePreference(mode="cpu"),
    )
    assert coordinator.ensure_running() is True
    assert coordinator.ownership == "external"
    coordinator.apply_device_preference(OllamaDevicePreference(mode="cpu"))
    assert spawned["count"] == 0
    assert coordinator.device_preference_application() == (False, True)
    assert coordinator.cpu_request_override() == USER_CHOSEN_CPU_EXECUTION_WARNING


def test_apply_with_nothing_running_uses_the_choice_at_the_next_start() -> None:
    coordinator, procs, _accepting = _owned_server(
        lambda: OllamaDevicePreference(mode="cpu"),
        clock=FakeClock(),
    )
    coordinator.apply_device_preference(OllamaDevicePreference(mode="cpu"))
    assert procs == []
    assert coordinator.device_preference_application() == (False, False)
    assert coordinator.ensure_running() is True
    assert len(procs) == 1
    _cpu_env(procs[0].env)


def test_a_new_choice_gets_its_own_corrective_restart() -> None:
    current = {"preference": OllamaDevicePreference()}
    coordinator, procs, _accepting = _owned_server(lambda: current["preference"], clock=FakeClock())
    real_spawn = coordinator._process_factory
    logs = {0: _ROCM_MISMATCH_LOG, 3: _ROCM_MISMATCH_LOG}

    def spawn(*args, **kwargs):
        proc = real_spawn(*args, **kwargs)
        log = logs.get(len(procs) - 1)
        if log is not None:
            proc.stdout = FakeStdout(log.encode("utf-8"))
        return proc

    coordinator._process_factory = spawn
    assert coordinator.ensure_running() is True
    assert procs[0].wait_drained() is True
    coordinator.after_model_load()
    assert len(procs) == 2
    assert coordinator._restarts == 1

    current["preference"] = OllamaDevicePreference(mode="cpu")
    coordinator.apply_device_preference(current["preference"])
    # The new choice's server starts with its own corrective restart.
    _wait_until(lambda: len(procs) == 3)
    assert coordinator._restarts == 0
    _cpu_env(procs[2].env)

    current["preference"] = OllamaDevicePreference()
    coordinator.apply_device_preference(current["preference"])
    _wait_until(lambda: len(procs) == 4 and procs[3].poll() is None)
    assert procs[3].env is not None
    assert procs[3].env["CUDA_VISIBLE_DEVICES"] == _RTX_UUID
    assert procs[3].wait_drained() is True
    coordinator.after_model_load()
    assert len(procs) == 5
    assert coordinator._restarts == 1
    coordinator.after_model_load()
    assert len(procs) == 5
    assert coordinator._restarts == 1


def test_a_failed_call_applies_a_pending_switch_when_admission_ends() -> None:
    current = {"preference": OllamaDevicePreference()}
    coordinator, procs, _accepting = _owned_server(lambda: current["preference"], clock=FakeClock())
    assert coordinator.ensure_running() is True
    entered = threading.Event()
    release = threading.Event()
    failed = threading.Event()

    def admitted() -> None:
        try:
            with coordinator.admission():
                entered.set()
                assert release.wait(timeout=5.0)
                raise RuntimeError("model load failed")
        except RuntimeError:
            failed.set()

    call = threading.Thread(target=admitted)
    call.start()
    assert entered.wait(timeout=5.0)
    current["preference"] = OllamaDevicePreference(mode="cpu")
    coordinator.apply_device_preference(current["preference"])
    assert coordinator.device_preference_application() == (True, False)
    assert len(procs) == 1
    release.set()
    call.join(timeout=5.0)
    assert failed.is_set()
    _wait_until(
        lambda: len(procs) == 2 and coordinator.device_preference_application() == (False, False)
    )
    _cpu_env(procs[1].env)
    assert procs[0].poll() is not None


def _radeon_preference() -> OllamaDevicePreference:
    radeon = next(
        accelerator
        for accelerator in _sample_inventory().accelerators
        if accelerator.classification == "integrated"
    )
    return OllamaDevicePreference(
        mode="adapter",
        adapter_key=adapter_key(radeon),
        adapter_name=radeon.name,
        pci_vendor_id=radeon.pci_vendor_id,
        pci_device_id=radeon.pci_device_id,
    )


def _igpu_env(env: dict[str, str] | None) -> None:
    assert env is not None
    assert env["OLLAMA_IGPU_ENABLE"] == "1"
    assert env["CUDA_VISIBLE_DEVICES"] == "-1"


def _hold_a_call(coordinator: OllamaServerCoordinator, *, long_running: bool = False):
    """Start a call on its own thread that holds an admission until ``release`` is set."""

    entered = threading.Event()
    release = threading.Event()

    def admitted() -> None:
        with coordinator.admission(long_running=long_running):
            entered.set()
            assert release.wait(timeout=5.0)

    call = threading.Thread(target=admitted)
    call.start()
    assert entered.wait(timeout=5.0)
    return call, release


def test_two_choices_during_a_call_switch_once_to_the_latest() -> None:
    current = {"preference": OllamaDevicePreference()}
    coordinator, procs, _accepting = _owned_server(lambda: current["preference"], clock=FakeClock())
    assert coordinator.ensure_running() is True
    call, release = _hold_a_call(coordinator)
    current["preference"] = OllamaDevicePreference(mode="cpu")
    coordinator.apply_device_preference(current["preference"])
    current["preference"] = _radeon_preference()
    coordinator.apply_device_preference(current["preference"])
    assert len(procs) == 1
    release.set()
    call.join(timeout=5.0)
    _wait_until(
        lambda: len(procs) == 2 and coordinator.device_preference_application() == (False, False)
    )
    _igpu_env(procs[1].env)
    assert [proc for proc in procs if proc.is_running] == [procs[1]]


def test_a_choice_changed_back_during_a_call_restarts_nothing() -> None:
    current = {"preference": OllamaDevicePreference()}
    coordinator, procs, _accepting = _owned_server(lambda: current["preference"], clock=FakeClock())
    assert coordinator.ensure_running() is True
    call, release = _hold_a_call(coordinator)
    current["preference"] = OllamaDevicePreference(mode="cpu")
    coordinator.apply_device_preference(current["preference"])
    current["preference"] = OllamaDevicePreference()
    coordinator.apply_device_preference(current["preference"])
    _wait_until(lambda: coordinator.device_preference_application() == (False, False))
    release.set()
    call.join(timeout=5.0)
    assert not coordinator._switch_waiting
    assert len(procs) == 1
    assert procs[0].is_running


def test_a_failed_start_stays_pending_until_ensure_running() -> None:
    current = {"preference": OllamaDevicePreference()}
    coordinator, procs, _accepting = _owned_server(lambda: current["preference"], clock=FakeClock())
    assert coordinator.ensure_running() is True
    real_spawn = coordinator._process_factory

    def spawn(*args, **kwargs):
        proc = real_spawn(*args, **kwargs)
        proc._returncode = 0
        return proc

    coordinator._process_factory = spawn
    current["preference"] = OllamaDevicePreference(mode="cpu")
    coordinator.apply_device_preference(current["preference"])
    _wait_until(
        lambda: coordinator.device_preference_application()[0]
        and coordinator.device_status().server == "not_running"
        and not coordinator._restarting
    )
    spawned_after_failure = len(procs)
    coordinator.after_model_load()
    assert len(procs) == spawned_after_failure
    assert coordinator.device_preference_application() == (True, False)
    assert coordinator.device_status().server == "not_running"

    coordinator._process_factory = real_spawn
    assert coordinator.ensure_running() is True
    assert coordinator.device_preference_application() == (False, False)
    assert coordinator.device_status().server == "owned"
    _cpu_env(procs[-1].env)


def test_resending_a_choice_after_a_failed_switch_keeps_it_pending_until_start() -> None:
    current = {"preference": OllamaDevicePreference()}
    coordinator, procs, accepting = _owned_server(lambda: current["preference"], clock=FakeClock())
    assert coordinator.ensure_running() is True
    accepting["value"] = False
    current["preference"] = OllamaDevicePreference(mode="cpu")
    coordinator.apply_device_preference(current["preference"])

    def generate() -> None:
        with coordinator.admission():
            pass

    _wait_until(lambda: len(procs) == 2 and not procs[1].is_running)
    _promptly(generate)
    assert not any(proc.is_running for proc in procs)
    assert coordinator.device_preference_application() == (True, False)

    probed = threading.Event()
    real_probe = coordinator._api_probe

    def probe(host: str) -> bool:
        answered = real_probe(host)
        probed.set()
        return answered

    coordinator._api_probe = probe
    coordinator.apply_device_preference(current["preference"])
    # With no owned server, this probe follows the switch thread's status update.
    assert probed.wait(timeout=5.0)
    assert coordinator.device_preference_application() == (True, False)
    assert len(procs) == 2

    # A start that fails too does not make the choice look applied.
    assert coordinator.ensure_running() is False
    assert len(procs) == 3
    assert not procs[2].is_running
    probed.clear()
    coordinator.apply_device_preference(current["preference"])
    assert probed.wait(timeout=5.0)
    assert coordinator.device_preference_application() == (True, False)
    assert len(procs) == 3

    accepting["value"] = True
    assert coordinator.ensure_running() is True
    assert len(procs) == 4
    assert procs[3].is_running
    _cpu_env(procs[3].env)
    assert coordinator.device_preference_application() == (False, False)
    coordinator.close()


def test_a_failed_stop_holds_no_later_call_and_the_next_start_retries_it() -> None:
    current = {"preference": OllamaDevicePreference()}
    coordinator, procs, accepting = _owned_server(lambda: current["preference"], clock=FakeClock())
    assert coordinator.ensure_running() is True
    stops = {"count": 0}
    stuck = {"value": True}
    stop_tried = threading.Event()

    def terminate(pid: int) -> None:
        stops["count"] += 1
        stop_tried.set()
        if stuck["value"]:
            return
        for proc in procs:
            if proc.pid == pid:
                proc._returncode = 0
        accepting["value"] = True

    coordinator._tree_terminator = terminate
    procs[0].kill = lambda: None  # type: ignore[method-assign]

    current["preference"] = OllamaDevicePreference(mode="cpu")
    coordinator.apply_device_preference(current["preference"])
    assert stop_tried.wait(timeout=5.0)
    _wait_until(lambda: not coordinator._preference_switch_running)
    assert not coordinator._restarting
    assert coordinator.device_preference_application() == (True, False)
    assert procs[0].poll() is None
    assert len(procs) == 1
    attempts = stops["count"]
    assert attempts >= 1

    # A later call is admitted at once, and neither it nor its verification retries the stop.
    entered = threading.Event()

    def admitted() -> None:
        with coordinator.admission():
            entered.set()

    call = threading.Thread(target=admitted)
    call.start()
    assert entered.wait(timeout=5.0)
    call.join(timeout=5.0)
    coordinator.after_model_load()
    # The old server still answers, so there is nothing to start.
    assert coordinator.ensure_running() is True
    assert stops["count"] == attempts
    assert coordinator.device_preference_application() == (True, False)

    # Once it stops answering, the start path stops it and starts the stored choice.
    stuck["value"] = False
    accepting["value"] = False
    assert coordinator.ensure_running() is True
    assert stops["count"] > attempts
    assert procs[0].poll() is not None
    assert len(procs) == 2
    _cpu_env(procs[1].env)
    assert coordinator.device_preference_application() == (False, False)
    assert coordinator.device_status().server == "owned"


def _hold_the_next_start(coordinator: OllamaServerCoordinator, procs: list[FakeProcess]):
    """Block the next spawn until ``release`` is set. ``entered`` is set when it starts."""

    entered = threading.Event()
    release = threading.Event()
    held = len(procs)
    real_spawn = coordinator._process_factory

    def spawn(*args, **kwargs):
        if len(procs) == held:
            entered.set()
            assert release.wait(timeout=5.0)
        return real_spawn(*args, **kwargs)

    coordinator._process_factory = spawn
    return entered, release


def test_a_choice_stored_while_the_switch_starts_ends_on_the_latest_choice() -> None:
    current = {"preference": OllamaDevicePreference()}
    coordinator, procs, _accepting = _owned_server(lambda: current["preference"], clock=FakeClock())
    assert coordinator.ensure_running() is True
    entered, release = _hold_the_next_start(coordinator, procs)

    current["preference"] = OllamaDevicePreference(mode="cpu")
    coordinator.apply_device_preference(current["preference"])
    assert entered.wait(timeout=5.0)
    # The old server is stopped and the new one is held in its start. Reads and
    # a new choice answer without waiting for it.
    assert _promptly(coordinator.device_preference_application) == (True, False)
    assert _promptly(coordinator.device_status).server == "not_running"
    assert len(procs) == 1

    current["preference"] = OllamaDevicePreference()
    _promptly(lambda: coordinator.apply_device_preference(current["preference"]))
    assert coordinator.device_preference_application() == (True, False)
    release.set()
    _wait_until(
        lambda: len(procs) == 3 and coordinator.device_preference_application() == (False, False)
    )
    _cpu_env(procs[1].env)
    assert procs[2].env is not None
    assert procs[2].env["CUDA_VISIBLE_DEVICES"] == _RTX_UUID
    assert [proc for proc in procs if proc.is_running] == [procs[2]]
    assert coordinator.device_status().server == "owned"


def test_the_same_choice_stored_again_during_a_switch_starts_once() -> None:
    current = {"preference": OllamaDevicePreference()}
    coordinator, procs, _accepting = _owned_server(lambda: current["preference"], clock=FakeClock())
    assert coordinator.ensure_running() is True
    entered, release = _hold_the_next_start(coordinator, procs)

    current["preference"] = OllamaDevicePreference(mode="cpu")
    coordinator.apply_device_preference(current["preference"])
    assert entered.wait(timeout=5.0)
    coordinator.apply_device_preference(current["preference"])
    release.set()
    _wait_until(
        lambda: coordinator.device_preference_application() == (False, False)
        and not coordinator._preference_switch_running
    )
    assert len(procs) == 2
    _cpu_env(procs[1].env)
    assert procs[1].is_running


class _GatedProfileClient:
    """Ollama client whose pull and create each wait for the test."""

    def __init__(self) -> None:
        self.models: list[str] = []
        self.in_pull = threading.Event()
        self.finish_pull = threading.Event()
        self.in_create = threading.Event()
        self.finish_create = threading.Event()

    def list(self):
        return {"models": [{"model": model} for model in self.models]}

    def pull(self, _model: str, *, stream: bool):
        self.in_pull.set()
        assert self.finish_pull.wait(timeout=5.0)
        yield {"status": "success"}

    def create(self, **kwargs):
        self.in_create.set()
        assert self.finish_create.wait(timeout=5.0)
        self.models.append(kwargs["model"])
        yield {"status": "success"}


def test_a_profile_pull_and_create_in_flight_are_not_interrupted_by_a_switch() -> None:
    current = {"preference": OllamaDevicePreference()}
    coordinator, procs, _accepting = _owned_server(lambda: current["preference"], clock=FakeClock())
    assert coordinator.ensure_running() is True
    client = _GatedProfileClient()
    installer = OllamaProfileInstaller(
        profile_by_id(DEFAULT_PROFILE_ID),
        client=client,
        server=coordinator,
    )
    results: list[str] = []

    def install() -> None:
        results.append(installer.install(lambda _progress: None).value)

    worker = threading.Thread(target=install)
    worker.start()
    assert client.in_pull.wait(timeout=5.0)
    current["preference"] = OllamaDevicePreference(mode="cpu")
    coordinator.apply_device_preference(current["preference"])
    assert coordinator.device_preference_application() == (True, False)

    client.finish_pull.set()
    assert client.in_create.wait(timeout=5.0)
    # The switch did not slip in between the download and the create.
    assert len(procs) == 1
    assert procs[0].is_running
    client.finish_create.set()
    worker.join(timeout=5.0)
    assert results == ["succeeded"]

    _wait_until(
        lambda: len(procs) == 2 and coordinator.device_preference_application() == (False, False)
    )
    assert procs[0].poll() is not None
    _cpu_env(procs[1].env)


def test_close_cancels_a_switch_that_has_not_started() -> None:
    current = {"preference": OllamaDevicePreference()}
    coordinator, procs, _accepting = _owned_server(lambda: current["preference"], clock=FakeClock())
    assert coordinator.ensure_running() is True
    entered = threading.Event()
    release = threading.Event()

    def admitted() -> None:
        with coordinator.admission():
            entered.set()
            assert release.wait(timeout=5.0)

    call = threading.Thread(target=admitted)
    call.start()
    assert entered.wait(timeout=5.0)
    current["preference"] = OllamaDevicePreference(mode="cpu")
    coordinator.apply_device_preference(current["preference"])
    assert coordinator.device_preference_application() == (True, False)
    switch_thread = coordinator._switch_thread
    assert switch_thread is not None
    coordinator.close()
    release.set()
    call.join(timeout=5.0)
    switch_thread.join(timeout=5.0)
    assert not switch_thread.is_alive()
    assert len(procs) == 1
    assert procs[0].poll() is not None
    assert coordinator.device_preference_application() == (False, False)


def test_a_choice_stored_during_a_failed_stop_is_applied_afterwards() -> None:
    current = {"preference": OllamaDevicePreference()}
    coordinator, procs, _accepting = _owned_server(lambda: current["preference"], clock=FakeClock())
    assert coordinator.ensure_running() is True
    in_stop = threading.Event()
    finish_stop = threading.Event()
    attempts = {"count": 0}

    def terminate(pid: int) -> None:
        attempts["count"] += 1
        if attempts["count"] == 1:
            # The first stop fails: the old server does not exit.
            in_stop.set()
            assert finish_stop.wait(timeout=5.0)
            return
        for proc in procs:
            if proc.pid == pid:
                proc._returncode = 0

    coordinator._tree_terminator = terminate
    procs[0].kill = lambda: None  # type: ignore[method-assign]

    current["preference"] = OllamaDevicePreference(mode="cpu")
    coordinator.apply_device_preference(current["preference"])
    assert in_stop.wait(timeout=5.0)
    current["preference"] = _radeon_preference()
    coordinator.apply_device_preference(current["preference"])
    finish_stop.set()

    _wait_until(
        lambda: len(procs) == 2 and coordinator.device_preference_application() == (False, False)
    )
    assert attempts["count"] == 2
    assert procs[0].poll() is not None
    _igpu_env(procs[1].env)


def test_resending_the_running_choice_while_idle_restarts_nothing() -> None:
    current = {"preference": OllamaDevicePreference()}
    coordinator, procs, _accepting = _owned_server(lambda: current["preference"], clock=FakeClock())
    real_spawn = coordinator._process_factory

    def spawn(*args, **kwargs):
        proc = real_spawn(*args, **kwargs)
        if len(procs) == 1:
            proc.stdout = FakeStdout(_ROCM_MISMATCH_LOG.encode("utf-8"))
        return proc

    coordinator._process_factory = spawn
    assert coordinator.ensure_running() is True
    assert procs[0].wait_drained() is True
    coordinator.after_model_load()
    assert len(procs) == 2
    assert coordinator._restarts == 1
    corrected = coordinator.policy

    coordinator.apply_device_preference(current["preference"])
    assert coordinator.device_preference_application() == (False, False)
    _wait_until(lambda: coordinator._handled_epoch == coordinator._requested_epoch)
    assert coordinator.device_preference_application() == (False, False)
    assert len(procs) == 2
    assert procs[1].is_running
    assert coordinator._restarts == 1
    assert coordinator.policy is corrected
    assert coordinator._policy_is_correction is True


def test_a_waiting_switch_holds_new_calls_until_it_has_run() -> None:
    current = {"preference": OllamaDevicePreference()}
    coordinator, procs, _accepting = _owned_server(lambda: current["preference"], clock=FakeClock())
    assert coordinator.ensure_running() is True
    first, release_first = _hold_a_call(coordinator)
    current["preference"] = OllamaDevicePreference(mode="cpu")
    coordinator.apply_device_preference(current["preference"])
    _wait_until(lambda: coordinator._switch_waiting)

    servers_seen: list[int] = []
    second_entered = threading.Event()

    def second() -> None:
        with coordinator.admission():
            servers_seen.append(len(procs))
            second_entered.set()

    later = threading.Thread(target=second)
    later.start()
    release_first.set()
    first.join(timeout=5.0)
    assert second_entered.wait(timeout=5.0)
    later.join(timeout=5.0)
    # The call that arrived while the switch waited ran on the new server.
    assert servers_seen == [2]
    _cpu_env(procs[1].env)
    assert procs[0].poll() is not None


def test_a_long_download_does_not_hold_back_calls_while_a_switch_waits() -> None:
    current = {"preference": OllamaDevicePreference()}
    coordinator, procs, _accepting = _owned_server(lambda: current["preference"], clock=FakeClock())
    assert coordinator.ensure_running() is True
    download, finish_download = _hold_a_call(coordinator, long_running=True)
    current["preference"] = OllamaDevicePreference(mode="cpu")
    coordinator.apply_device_preference(current["preference"])
    _wait_until(lambda: coordinator._switch_waiting)

    servers_seen: list[int] = []

    def generate() -> None:
        with coordinator.admission():
            servers_seen.append(len(procs))

    _promptly(generate)
    # Admitted during the download, on the old server, which still runs.
    assert servers_seen == [1]
    assert procs[0].is_running
    assert coordinator.device_preference_application() == (True, False)

    finish_download.set()
    download.join(timeout=5.0)
    _wait_until(
        lambda: len(procs) == 2 and coordinator.device_preference_application() == (False, False)
    )
    assert procs[0].poll() is not None
    _cpu_env(procs[1].env)


def test_a_mismatch_during_a_download_defers_the_corrective_restart() -> None:
    fleet = _ProcessFleet(_ROCM_MISMATCH_LOG, _CUDA_VERIFIED_LOG)
    coordinator = fleet.coordinator(clock=FakeClock())
    assert coordinator.ensure_running() is True
    assert fleet.procs[0].wait_drained() is True
    download, finish_download = _hold_a_call(coordinator, long_running=True)

    execution = coordinator.after_model_load()
    assert execution is not None
    assert execution.state == "mismatch"
    # The server under the download is not stopped and nothing is held back.
    assert len(fleet.procs) == 1
    assert fleet.procs[0].is_running
    assert coordinator._restarts == 0
    assert not coordinator._restarting
    assert coordinator.device_status().verification == "pending"

    def generate() -> None:
        with coordinator.admission():
            pass

    _promptly(generate)

    finish_download.set()
    download.join(timeout=5.0)
    # The next model load with nothing LONG in flight takes the corrective restart.
    coordinator.after_model_load()
    assert len(fleet.procs) == 2
    assert coordinator._restarts == 1
    assert not fleet.procs[0].is_running


def test_choices_and_status_answer_while_a_corrective_restart_waits() -> None:
    fleet = _ProcessFleet(_ROCM_MISMATCH_LOG, _CUDA_VERIFIED_LOG)
    coordinator = fleet.coordinator()
    assert coordinator.ensure_running() is True
    assert fleet.procs[0].wait_drained() is True
    call, release = _hold_a_call(coordinator)
    verification = threading.Thread(target=coordinator.after_model_load)
    verification.start()
    _wait_until(lambda: coordinator._restarting)

    _promptly(lambda: coordinator.apply_device_preference(OllamaDevicePreference(mode="cpu")))
    assert _promptly(coordinator.device_preference_application) == (True, False)
    status = _promptly(coordinator.device_status)
    assert status.verification == "pending"
    assert status.corrective_restarts == 1

    release.set()
    call.join(timeout=5.0)
    verification.join(timeout=5.0)
    assert len(fleet.procs) == 2
    # The stored choice is still Auto here, which the corrected server already runs.
    _wait_until(lambda: coordinator.device_preference_application() == (False, False))
    assert len(fleet.procs) == 2


def test_choices_and_status_answer_while_ensure_running_starts_the_server() -> None:
    current = {"preference": OllamaDevicePreference()}
    coordinator, procs, _accepting = _owned_server(lambda: current["preference"], clock=FakeClock())
    entered, release = _hold_the_next_start(coordinator, procs)
    starter = threading.Thread(target=coordinator.ensure_running)
    starter.start()
    assert entered.wait(timeout=5.0)

    current["preference"] = OllamaDevicePreference(mode="cpu")
    _promptly(lambda: coordinator.apply_device_preference(current["preference"]))
    assert _promptly(coordinator.device_preference_application) == (False, False)
    assert _promptly(coordinator.device_status).server == "not_running"
    _promptly(coordinator.note_api_answered)

    release.set()
    starter.join(timeout=5.0)
    # That start had read Auto; the choice stored meanwhile is applied after it.
    _wait_until(
        lambda: len(procs) == 2 and coordinator.device_preference_application() == (False, False)
    )
    assert procs[0].poll() is not None
    _cpu_env(procs[1].env)


def test_a_failing_preference_read_in_the_switch_thread_leaves_calls_free() -> None:
    state = {"preference": OllamaDevicePreference(), "fail": False}
    failed = threading.Event()

    def provider() -> OllamaDevicePreference:
        if state["fail"]:
            failed.set()
            raise RuntimeError("database is locked")
        return state["preference"]

    coordinator, procs, _accepting = _owned_server(provider, clock=FakeClock())
    assert coordinator.ensure_running() is True
    state["fail"] = True
    coordinator.apply_device_preference(OllamaDevicePreference(mode="cpu"))
    assert failed.wait(timeout=5.0)
    _wait_until(lambda: coordinator._handled_epoch == coordinator._requested_epoch)

    def generate() -> None:
        with coordinator.admission():
            pass

    _promptly(generate)
    assert not coordinator._restarting
    assert not coordinator._switch_waiting
    assert not coordinator._preference_switch_running
    assert len(procs) == 1

    # A later choice still works, and the thread is still alive.
    state["fail"] = False
    state["preference"] = OllamaDevicePreference(mode="cpu")
    coordinator.apply_device_preference(state["preference"])
    _wait_until(
        lambda: len(procs) == 2 and coordinator.device_preference_application() == (False, False)
    )
    _cpu_env(procs[1].env)


def test_a_failing_newer_preference_read_keeps_the_running_choice_pending() -> None:
    current = {"preference": OllamaDevicePreference()}
    failing = threading.Event()
    failed = threading.Event()

    def provider() -> OllamaDevicePreference:
        if failing.is_set():
            failed.set()
            raise RuntimeError("database is locked")
        return current["preference"]

    coordinator, procs, _accepting = _owned_server(provider, clock=FakeClock())
    assert coordinator.ensure_running() is True
    entered, release = _hold_the_next_start(coordinator, procs)
    current["preference"] = OllamaDevicePreference(mode="cpu")
    coordinator.apply_device_preference(current["preference"])
    assert entered.wait(timeout=5.0)
    current["preference"] = _radeon_preference()
    coordinator.apply_device_preference(current["preference"])
    failing.set()
    release.set()
    assert failed.wait(timeout=5.0)

    def generate() -> None:
        with coordinator.admission():
            pass

    _promptly(generate)
    assert len(procs) == 2
    assert [proc for proc in procs if proc.is_running] == [procs[1]]
    _cpu_env(procs[1].env)
    assert coordinator.device_preference_application() == (True, False)

    failing.clear()
    coordinator.apply_device_preference(current["preference"])
    _wait_until(
        lambda: len(procs) == 3 and coordinator.device_preference_application() == (False, False)
    )
    assert [proc for proc in procs if proc.is_running] == [procs[2]]
    _igpu_env(procs[2].env)
    coordinator.close()


def test_a_failing_probe_during_a_switch_clears_the_hold() -> None:
    current = {"preference": OllamaDevicePreference()}
    coordinator, procs, _accepting = _owned_server(lambda: current["preference"], clock=FakeClock())
    assert coordinator.ensure_running() is True
    real_probe = coordinator._api_probe
    armed = {"value": True}
    raised = threading.Event()

    def probe(host: str) -> bool:
        if armed["value"] and threading.current_thread().name == "ollama-device-switch":
            raised.set()
            raise RuntimeError("probe failed")
        return real_probe(host)

    coordinator._api_probe = probe
    current["preference"] = OllamaDevicePreference(mode="cpu")
    coordinator.apply_device_preference(current["preference"])
    assert raised.wait(timeout=5.0)
    _wait_until(lambda: not coordinator._preference_switch_running)
    assert not coordinator._restarting

    def generate() -> None:
        with coordinator.admission():
            pass

    _promptly(generate)

    # A later choice still switches the server.
    armed["value"] = False
    current["preference"] = OllamaDevicePreference()
    coordinator.apply_device_preference(current["preference"])
    _wait_until(
        lambda: len(procs) == 3 and coordinator.device_preference_application() == (False, False)
    )
    assert procs[2].env is not None
    assert procs[2].env["CUDA_VISIBLE_DEVICES"] == _RTX_UUID
    assert [proc for proc in procs if proc.is_running] == [procs[2]]


def _close_on_a_thread(coordinator: OllamaServerCoordinator) -> threading.Event:
    closed = threading.Event()

    def close() -> None:
        coordinator.close()
        closed.set()

    threading.Thread(target=close, daemon=True).start()
    _wait_until(lambda: coordinator._closed)
    return closed


def test_close_during_the_stop_of_a_switch_leaves_no_server_and_no_thread() -> None:
    current = {"preference": OllamaDevicePreference()}
    coordinator, procs, _accepting = _owned_server(lambda: current["preference"], clock=FakeClock())
    assert coordinator.ensure_running() is True
    in_stop = threading.Event()
    finish_stop = threading.Event()
    real_terminate = coordinator._tree_terminator

    def terminate(pid: int) -> None:
        if threading.current_thread().name == "ollama-device-switch" and not in_stop.is_set():
            in_stop.set()
            assert finish_stop.wait(timeout=5.0)
        real_terminate(pid)

    coordinator._tree_terminator = terminate
    current["preference"] = OllamaDevicePreference(mode="cpu")
    coordinator.apply_device_preference(current["preference"])
    assert in_stop.wait(timeout=5.0)
    switch_thread = coordinator._switch_thread
    assert switch_thread is not None

    closed = _close_on_a_thread(coordinator)
    finish_stop.set()
    assert closed.wait(timeout=5.0)
    assert not switch_thread.is_alive()
    assert len(procs) == 1
    assert not any(proc.is_running for proc in procs)
    assert coordinator.ownership == "none"


def test_close_while_a_switch_creates_its_child_stops_that_child() -> None:
    current = {"preference": OllamaDevicePreference()}
    coordinator, procs, _accepting = _owned_server(lambda: current["preference"], clock=FakeClock())
    assert coordinator.ensure_running() is True
    entered, release = _hold_the_next_start(coordinator, procs)
    current["preference"] = OllamaDevicePreference(mode="cpu")
    coordinator.apply_device_preference(current["preference"])
    assert entered.wait(timeout=5.0)
    switch_thread = coordinator._switch_thread
    assert switch_thread is not None

    closed = _close_on_a_thread(coordinator)
    # The child is created only after close() has started.
    release.set()
    assert closed.wait(timeout=5.0)
    assert not switch_thread.is_alive()
    assert len(procs) == 2
    assert not any(proc.is_running for proc in procs)
    assert coordinator.ownership == "none"


def test_close_during_the_readiness_wait_of_a_switch_stops_the_new_server() -> None:
    current = {"preference": OllamaDevicePreference()}
    coordinator, procs, _accepting = _owned_server(lambda: current["preference"], clock=FakeClock())
    assert coordinator.ensure_running() is True
    # The readiness deadline never passes here: only close() ends the wait.
    coordinator._clock = lambda: 1000.0
    coordinator._sleep = lambda _seconds: threading.Event().wait(0.005)
    in_readiness = threading.Event()
    real_probe = coordinator._api_probe

    def probe(host: str) -> bool:
        if threading.current_thread().name == "ollama-device-switch":
            in_readiness.set()
            return False
        return real_probe(host)

    coordinator._api_probe = probe
    current["preference"] = OllamaDevicePreference(mode="cpu")
    coordinator.apply_device_preference(current["preference"])
    assert in_readiness.wait(timeout=5.0)
    switch_thread = coordinator._switch_thread
    assert switch_thread is not None

    closed = _close_on_a_thread(coordinator)
    assert closed.wait(timeout=5.0)
    assert not switch_thread.is_alive()
    assert len(procs) == 2
    assert not any(proc.is_running for proc in procs)
    assert coordinator.ownership == "none"


def test_close_retries_a_failed_stop_of_the_switched_in_child() -> None:
    current = {"preference": OllamaDevicePreference()}
    coordinator, procs, _accepting = _owned_server(lambda: current["preference"], clock=FakeClock())
    assert coordinator.ensure_running() is True
    in_readiness = threading.Event()
    finish_probe = threading.Event()
    real_probe = coordinator._api_probe
    real_terminate = coordinator._tree_terminator
    attempts: list[threading.Thread] = []

    def probe(host: str) -> bool:
        if threading.current_thread().name == "ollama-device-switch":
            in_readiness.set()
            assert finish_probe.wait(timeout=5.0)
            return False
        return real_probe(host)

    def terminate(pid: int) -> None:
        if len(procs) == 2 and pid == procs[1].pid:
            attempts.append(threading.current_thread())
            if len(attempts) == 1:
                return
        real_terminate(pid)

    coordinator._api_probe = probe
    coordinator._tree_terminator = terminate
    current["preference"] = OllamaDevicePreference(mode="cpu")
    coordinator.apply_device_preference(current["preference"])
    assert in_readiness.wait(timeout=5.0)
    procs[1].kill = lambda: None  # type: ignore[method-assign]

    closed = _close_on_a_thread(coordinator)
    finish_probe.set()
    assert closed.wait(timeout=5.0)
    assert procs[1].poll() is not None
    assert len(attempts) == 2
    assert attempts[0].name == "ollama-device-switch"
    assert attempts[1] is not attempts[0]
    assert not any(proc.is_running for proc in procs)
