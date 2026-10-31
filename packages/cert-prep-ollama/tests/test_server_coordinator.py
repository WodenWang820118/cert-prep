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
        self, clock: FakeClock | None = None, host: str = "http://127.0.0.1:11434"
    ) -> OllamaServerCoordinator:
        timing = {} if clock is None else {"clock": clock.time, "sleep": clock.sleep}
        return OllamaServerCoordinator(
            host=host,
            inventory_provider=_sample_inventory,
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
