"""Stored Ollama device choice: HTTP, persistence, and when the owned server switches."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
import threading
import time

from fastapi.testclient import TestClient
import pytest

from cert_prep_backend.ai_providers.infrastructure import machine_inventory as inventory_module
from cert_prep_backend.ai_providers.infrastructure import ollama_transport
from cert_prep_backend.bootstrap.app import create_app
from cert_prep_backend.platform.config import Settings
from cert_prep_contracts.hardware import (
    MachineAcceleratorSnapshot,
    MachineCpuSnapshot,
    MachineInventorySnapshot,
    MachineRamSnapshot,
    MachineStorageSnapshot,
)
from cert_prep_ollama.device_policy import USER_CHOSEN_CPU_EXECUTION_WARNING, adapter_key
from conftest import AUTH_TOKEN, TestCaptureRuntimeClient
from llm_test_fakes import FailingListOllamaClient, RecordingOllamaClient

_RTX = "NVIDIA GeForce RTX 4060 Laptop GPU"
_RTX_UUID = "GPU-3c990263-ad20-7ce7-1ad5-cae44a0d9df3"
_RADEON = "AMD Radeon(TM) 880M Graphics"
_IGPU = "AMD Radeon(TM) 780M"
_HEADERS = {"Authorization": f"Bearer {AUTH_TOKEN}"}


def _accelerator(name: str, **kwargs) -> MachineAcceleratorSnapshot:
    return MachineAcceleratorSnapshot(kind="gpu", name=name, **kwargs)


def _rtx(**overrides) -> MachineAcceleratorSnapshot:
    fields = {
        "classification": "dedicated",
        "vendor": "nvidia",
        "pci_vendor_id": "10de",
        "pci_device_id": "28a0",
        "device_id": _RTX_UUID,
        "dedicated_memory_bytes": 8_342_470_656,
    }
    fields.update(overrides)
    return _accelerator(_RTX, **fields)


def _radeon() -> MachineAcceleratorSnapshot:
    return _accelerator(
        _RADEON,
        classification="integrated",
        vendor="amd",
        pci_vendor_id="1002",
        pci_device_id="150e",
        dedicated_memory_bytes=298_012_672,
        shared_memory_bytes=16_706_365_440,
    )


def _igpu() -> MachineAcceleratorSnapshot:
    return _accelerator(
        _IGPU,
        classification="integrated",
        vendor="amd",
        pci_vendor_id="1002",
        pci_device_id="15bf",
        dedicated_memory_bytes=512 * 1024**2,
        shared_memory_bytes=16 * 1024**3,
    )


def _software() -> MachineAcceleratorSnapshot:
    return _accelerator(
        "Microsoft Basic Render Driver",
        classification="software",
        pci_vendor_id="1414",
        pci_device_id="008c",
    )


def _unknown() -> MachineAcceleratorSnapshot:
    return _accelerator(
        "Generic Display Adapter",
        classification="unknown",
        pci_vendor_id="1234",
        pci_device_id="5678",
    )


def _inventory(
    accelerators: list[MachineAcceleratorSnapshot],
    *,
    platform_name: str = "Windows",
) -> MachineInventorySnapshot:
    return MachineInventorySnapshot(
        platform=platform_name,
        platform_version="10.0.26100",
        architecture="AMD64",
        cpu=MachineCpuSnapshot(architecture="AMD64"),
        ram=MachineRamSnapshot(32 * 1024**3, 16 * 1024**3),
        storage=MachineStorageSnapshot("C:\\", 64 * 1024**3, 128 * 1024**3),
        accelerators=tuple(accelerators),
    )


def _laptop() -> MachineInventorySnapshot:
    return _inventory([_radeon(), _rtx(), _software()])


class _RecordedProcess:
    def __init__(self, pid: int, env: dict[str, str]) -> None:
        self.pid = pid
        self.env = env
        self.stdout = None
        self._returncode: int | None = None

    def poll(self) -> int | None:
        return self._returncode

    def terminate(self) -> None:
        self._returncode = 0

    def kill(self) -> None:
        self.terminate()


def _quiesce(coordinator) -> None:
    state = {"now": 1000.0}

    def clock() -> float:
        return state["now"]

    def sleep(seconds: float) -> None:
        state["now"] += seconds

    coordinator._clock = clock
    coordinator._sleep = sleep


def _own_the_server(coordinator) -> list[_RecordedProcess]:
    """Replace process control so a test never starts a real Ollama."""

    procs: list[_RecordedProcess] = []

    def spawn(*_args, **kwargs) -> _RecordedProcess:
        proc = _RecordedProcess(7000 + len(procs), dict(kwargs.get("env") or {}))
        procs.append(proc)
        return proc

    def terminate(pid: int) -> None:
        for proc in procs:
            if proc.pid == pid:
                proc.terminate()

    def probe(_host: str) -> bool:
        return any(proc.poll() is None for proc in procs)

    coordinator._process_factory = spawn
    coordinator._tree_terminator = terminate
    coordinator._api_probe = probe
    coordinator._executable_resolver = lambda: Path("ollama")
    _quiesce(coordinator)
    return procs


def _wait_until(predicate, timeout: float = 5.0) -> None:
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
    assert done.wait(timeout=timeout), "the request waited instead of answering"
    value = result[0]
    if isinstance(value, BaseException):
        raise value
    return value


def _drop_inventory_cache() -> None:
    inventory_module._inventory_cache.clear()


def _patch_inventory(monkeypatch: pytest.MonkeyPatch, holder: dict[str, MachineInventorySnapshot]) -> None:
    """Replace the collector ``collect_ollama_machine_inventory`` calls.

    That function passes ``model_storage_path`` and ``timeout_seconds``. A
    refresh updates the process cache both the use case and the coordinator read.
    """

    def collect(**_kwargs: object) -> MachineInventorySnapshot:
        return holder["inventory"]

    monkeypatch.setattr(inventory_module, "collect_machine_inventory", collect)


@contextmanager
def _app(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
    inventory: MachineInventorySnapshot,
    *,
    llm_provider: str = "fake",
) -> Iterator[tuple[TestClient, object, list[_RecordedProcess], dict[str, MachineInventorySnapshot]]]:
    holder = {"inventory": inventory}
    _patch_inventory(monkeypatch, holder)
    settings = Settings(
        data_dir=tmp_path,
        api_token=AUTH_TOKEN,
        llm_provider=llm_provider,
        ollama_profile_enabled=False,
    )
    app = create_app(
        settings=settings,
        capture_runtime_client=TestCaptureRuntimeClient(),
        document_processing_async_jobs=False,
    )
    procs = _own_the_server(app.state.ollama_server)
    with TestClient(app) as client:
        yield client, app, procs, holder


def _choice(body: dict, name: str) -> dict:
    return next(choice for choice in body["choices"] if choice["name"] == name)


def test_get_without_a_row_is_auto_and_lists_the_current_adapters(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with _app(tmp_path, monkeypatch, _laptop()) as (client, _app_state, _procs, holder):
        body = client.get("/llm/device-preference", headers=_HEADERS).json()
        assert body["mode"] == "auto"
        assert body["adapter_key"] is None
        assert body["adapter_name"] is None
        assert body["status"] == "active"
        assert [choice["name"] for choice in body["choices"]] == [_RADEON, _RTX]
        dedicated = _choice(body, _RTX)
        integrated = _choice(body, _RADEON)
        assert dedicated["selectable"] is True
        assert dedicated["classification"] == "dedicated"
        assert dedicated["backend"] == "cuda"
        assert dedicated["adapter_key"] == adapter_key(_rtx())
        assert integrated["selectable"] is True
        assert integrated["classification"] == "integrated"
        assert integrated["backend"] == "vulkan"

        holder["inventory"] = _inventory([_igpu()])
        cached = client.get("/llm/device-preference", headers=_HEADERS).json()
        assert [choice["name"] for choice in cached["choices"]] == [_RADEON, _RTX]
        _drop_inventory_cache()

        holder["inventory"] = _inventory([_igpu()])
        igpu_only = client.get("/llm/device-preference", headers=_HEADERS).json()
        assert igpu_only["status"] == "active"
        assert len(igpu_only["choices"]) == 1
        assert igpu_only["choices"][0]["name"] == _IGPU
        assert igpu_only["choices"][0]["selectable"] is True
        assert igpu_only["choices"][0]["backend"] == "vulkan"
        assert igpu_only["choices"][0]["classification"] == "integrated"

        _drop_inventory_cache()
        holder["inventory"] = _inventory([_unknown()])
        unknown = client.get("/llm/device-preference", headers=_HEADERS).json()
        assert unknown["choices"][0]["selectable"] is False
        assert unknown["choices"][0]["classification"] == "unknown"
        assert unknown["choices"][0]["backend"] is None

        _drop_inventory_cache()
        shared = r"PCI\VEN_10DE&DEV_28A0&SUBSYS_00000000&REV_A1\4&123456&0&0008"
        holder["inventory"] = _inventory(
            [
                _rtx(pnp_device_id=shared),
                _accelerator(
                    "NVIDIA GeForce RTX 4060 Laptop GPU Copy",
                    classification="dedicated",
                    vendor="nvidia",
                    pci_vendor_id="10de",
                    pci_device_id="28a0",
                    device_id="GPU-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                    pnp_device_id=shared,
                ),
            ]
        )
        duplicated = client.get("/llm/device-preference", headers=_HEADERS).json()
        assert len(duplicated["choices"]) == 2
        assert duplicated["choices"][0]["adapter_key"] == duplicated["choices"][1]["adapter_key"]
        assert all(choice["selectable"] is False for choice in duplicated["choices"])

        _drop_inventory_cache()
        holder["inventory"] = _inventory([_rtx()], platform_name="Linux")
        off_windows = client.get("/llm/device-preference", headers=_HEADERS).json()
        assert off_windows["mode"] == "auto"
        assert off_windows["status"] == "not_applicable"
        assert off_windows["choices"] == []


def test_put_then_get_survives_a_new_app(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    holder = {"inventory": _laptop()}
    _patch_inventory(monkeypatch, holder)
    settings = Settings(
        data_dir=tmp_path,
        api_token=AUTH_TOKEN,
        llm_provider="fake",
        ollama_profile_enabled=False,
    )
    first = create_app(
        settings=settings,
        capture_runtime_client=TestCaptureRuntimeClient(),
        document_processing_async_jobs=False,
    )
    _own_the_server(first.state.ollama_server)
    with TestClient(first) as client:
        stored = client.put("/llm/device-preference", headers=_HEADERS, json={"mode": "cpu"})
        assert stored.status_code == 200
        assert stored.json()["mode"] == "cpu"
        assert stored.json()["adapter_key"] is None
        assert stored.json()["status"] == "active"
        assert client.get("/llm/device-preference", headers=_HEADERS).json()["mode"] == "cpu"

    second = create_app(
        settings=settings,
        capture_runtime_client=TestCaptureRuntimeClient(),
        document_processing_async_jobs=False,
    )
    _own_the_server(second.state.ollama_server)
    with TestClient(second) as client:
        body = client.get("/llm/device-preference", headers=_HEADERS).json()
    assert body["mode"] == "cpu"
    assert body["adapter_key"] is None
    assert body["status"] == "active"


def test_put_rejects_a_choice_this_machine_cannot_store(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with _app(tmp_path, monkeypatch, _laptop()) as (client, _app_state, _procs, holder):
        invalid = client.put("/llm/device-preference", headers=_HEADERS, json={"mode": "gpu"})
        assert invalid.status_code == 422
        assert invalid.json()["code"] == "validation_error"
        assert invalid.json()["message"] == "Request validation failed."

        for mode in ("auto", "cpu"):
            extra = client.put(
                "/llm/device-preference",
                headers=_HEADERS,
                json={"mode": mode, "adapter_key": adapter_key(_rtx())},
            )
            assert extra.status_code == 422
            assert extra.json() == {
                "code": "validation_error",
                "message": "adapter_key is only allowed when mode is adapter.",
            }

        for body in (
            {"mode": "adapter"},
            {"mode": "adapter", "adapter_key": None},
            {"mode": "adapter", "adapter_key": "   "},
        ):
            missing = client.put("/llm/device-preference", headers=_HEADERS, json=body)
            assert missing.status_code == 422
            assert missing.json() == {
                "code": "unknown_device",
                "message": "Choosing an adapter requires adapter_key.",
            }

        unknown_key = client.put(
            "/llm/device-preference",
            headers=_HEADERS,
            json={"mode": "adapter", "adapter_key": "0123456789abcdef"},
        )
        assert unknown_key.status_code == 422
        assert unknown_key.json()["code"] == "unknown_device"
        assert unknown_key.json()["message"] == (
            "That adapter is not a selectable choice on this machine."
        )

        _drop_inventory_cache()
        holder["inventory"] = _inventory([_unknown()])
        listed = client.get("/llm/device-preference", headers=_HEADERS).json()
        rejected = client.put(
            "/llm/device-preference",
            headers=_HEADERS,
            json={"mode": "adapter", "adapter_key": listed["choices"][0]["adapter_key"]},
        )
        assert rejected.status_code == 422
        assert rejected.json()["code"] == "unknown_device"

        _drop_inventory_cache()
        shared = r"PCI\VEN_10DE&DEV_28A0&SUBSYS_00000000&REV_A1\4&123456&0&0008"
        holder["inventory"] = _inventory(
            [_rtx(pnp_device_id=shared), _rtx(pnp_device_id=shared, device_id="GPU-other")]
        )
        duplicated = client.get("/llm/device-preference", headers=_HEADERS).json()
        duplicate = client.put(
            "/llm/device-preference",
            headers=_HEADERS,
            json={"mode": "adapter", "adapter_key": duplicated["choices"][0]["adapter_key"]},
        )
        assert duplicate.status_code == 422
        assert duplicate.json()["code"] == "unknown_device"
        assert client.get("/llm/device-preference", headers=_HEADERS).json()["mode"] == "auto"


def test_an_idle_owned_server_restarts_once_for_the_stored_choice(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with _app(tmp_path, monkeypatch, _laptop()) as (client, app, procs, _holder):
        assert app.state.ollama_server.ensure_running() is True
        assert procs[0].env["CUDA_VISIBLE_DEVICES"] == _RTX_UUID
        chosen = client.put("/llm/device-preference", headers=_HEADERS, json={"mode": "cpu"})
        assert chosen.status_code == 200
        _wait_until(lambda: len(procs) == 2 and procs[0].poll() is not None and procs[1].poll() is None)
        assert procs[1].env["CUDA_VISIBLE_DEVICES"] == "-1"
        assert procs[1].env["OLLAMA_VULKAN"] == "0"
        assert procs[1].env["OLLAMA_IGPU_ENABLE"] == "0"
        assert client.get("/llm/device-preference", headers=_HEADERS).json()["status"] == "active"


def test_a_choice_during_a_call_stays_pending_until_the_call_finishes(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with _app(tmp_path, monkeypatch, _laptop()) as (client, app, procs, _holder):
        coordinator = app.state.ollama_server
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
        pending = client.put("/llm/device-preference", headers=_HEADERS, json={"mode": "cpu"})
        assert pending.status_code == 200
        assert pending.json()["mode"] == "cpu"
        assert pending.json()["status"] == "pending"
        assert len(procs) == 1
        assert procs[0].poll() is None
        release.set()
        call.join(timeout=5.0)
        _wait_until(lambda: len(procs) == 2 and procs[1].poll() is None)
        assert procs[1].env["CUDA_VISIBLE_DEVICES"] == "-1"
        assert client.get("/llm/device-preference", headers=_HEADERS).json()["status"] == "active"


def test_put_get_and_health_answer_while_a_start_is_held(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    recording = RecordingOllamaClient(models=["qwen3.5:4b"], chat_content="{}")
    monkeypatch.setattr(ollama_transport, "OllamaClient", lambda *_args, **_kwargs: recording)
    with _app(tmp_path, monkeypatch, _laptop(), llm_provider="ollama") as (
        client,
        app,
        procs,
        _holder,
    ):
        coordinator = app.state.ollama_server
        entered = threading.Event()
        release = threading.Event()
        real_spawn = coordinator._process_factory

        def spawn(*args, **kwargs):
            if not procs:
                entered.set()
                assert release.wait(timeout=10.0)
            return real_spawn(*args, **kwargs)

        coordinator._process_factory = spawn
        starter = threading.Thread(target=coordinator.ensure_running)
        starter.start()
        try:
            assert entered.wait(timeout=5.0)
            # ensure_running holds the lifecycle lock in its start; none of these wait for it.
            chosen = _promptly(
                lambda: client.put("/llm/device-preference", headers=_HEADERS, json={"mode": "cpu"})
            )
            assert chosen.status_code == 200
            assert chosen.json()["mode"] == "cpu"
            current = _promptly(lambda: client.get("/llm/device-preference", headers=_HEADERS))
            assert current.status_code == 200
            health = _promptly(lambda: client.get("/llm/health", headers=_HEADERS))
            assert health.status_code == 200
            assert health.json()["device"]["server"] == "not_running"
        finally:
            release.set()
            starter.join(timeout=5.0)
        # That start had read Auto; the CPU choice stored meanwhile replaces it.
        _wait_until(
            lambda: any(
                proc.poll() is None and proc.env.get("CUDA_VISIBLE_DEVICES") == "-1"
                for proc in procs
            )
        )
        _wait_until(
            lambda: client.get("/llm/device-preference", headers=_HEADERS).json()["status"]
            == "active"
        )
        assert len([proc for proc in procs if proc.poll() is None]) == 1


class _GatedPullClient:
    """Ollama client whose model download waits for the test."""

    def __init__(self) -> None:
        self.in_pull = threading.Event()
        self.finish_pull = threading.Event()

    def pull(self, _model: str, *, stream: bool):
        self.in_pull.set()
        assert self.finish_pull.wait(timeout=5.0)
        yield {"status": "success", "completed": 10, "total": 10}


def test_a_model_pull_in_flight_is_not_interrupted_by_a_choice(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with _app(tmp_path, monkeypatch, _laptop()) as (client, app, procs, _holder):
        coordinator = app.state.ollama_server
        assert coordinator.ensure_running() is True
        pulling = _GatedPullClient()
        provider = ollama_transport.OllamaProvider(
            host="http://127.0.0.1:11434",
            model="qwen3.5:4b",
            timeout_seconds=1.0,
            client=pulling,
            server=coordinator,
        )
        progress: list[object] = []
        download = threading.Thread(target=provider.pull_model, args=(progress.append,))
        download.start()
        assert pulling.in_pull.wait(timeout=5.0)

        chosen = client.put("/llm/device-preference", headers=_HEADERS, json={"mode": "cpu"})
        assert chosen.status_code == 200
        assert chosen.json()["status"] == "pending"
        assert len(procs) == 1
        assert procs[0].poll() is None

        pulling.finish_pull.set()
        download.join(timeout=5.0)
        assert len(progress) == 1
        _wait_until(lambda: len(procs) == 2 and procs[1].poll() is None)
        assert procs[0].poll() is not None
        assert procs[1].env["CUDA_VISIBLE_DEVICES"] == "-1"
        assert client.get("/llm/device-preference", headers=_HEADERS).json()["status"] == "active"


class _FailingChatClient:
    """The model is listed, and the chat waits for the test and then fails."""

    def __init__(self) -> None:
        self.in_chat = threading.Event()
        self.fail_chat = threading.Event()

    def list(self):
        return {"models": [{"model": "qwen3.5:4b"}]}

    def chat(self, **_kwargs):
        self.in_chat.set()
        assert self.fail_chat.wait(timeout=5.0)
        raise RuntimeError("model load failed")


def test_a_choice_made_during_a_failing_call_applies_after_it(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with _app(tmp_path, monkeypatch, _laptop()) as (client, app, procs, _holder):
        coordinator = app.state.ollama_server
        assert coordinator.ensure_running() is True
        failing = _FailingChatClient()
        provider = ollama_transport.OllamaProvider(
            host="http://127.0.0.1:11434",
            model="qwen3.5:4b",
            timeout_seconds=1.0,
            client=failing,
            server=coordinator,
        )
        errors: list[BaseException] = []

        def generate() -> None:
            try:
                provider.generate_structured_json(
                    messages=[{"role": "user", "content": "hi"}],
                    json_schema={"type": "object"},
                )
            except Exception as exc:  # noqa: BLE001 - the call is expected to fail
                errors.append(exc)

        call = threading.Thread(target=generate)
        call.start()
        assert failing.in_chat.wait(timeout=5.0)
        chosen = client.put("/llm/device-preference", headers=_HEADERS, json={"mode": "cpu"})
        assert chosen.json()["status"] == "pending"
        failing.fail_chat.set()
        call.join(timeout=5.0)
        assert len(errors) == 1
        _wait_until(lambda: len(procs) == 2 and procs[1].poll() is None)
        assert procs[0].poll() is not None
        assert procs[1].env["CUDA_VISIBLE_DEVICES"] == "-1"
        assert client.get("/llm/device-preference", headers=_HEADERS).json()["status"] == "active"


def test_an_external_server_is_saved_and_cpu_requests_still_set_num_gpu(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    recording = RecordingOllamaClient(models=["qwen3.5:4b"], chat_content="{}")
    monkeypatch.setattr(ollama_transport, "OllamaClient", lambda *_args, **_kwargs: recording)
    holder = {"inventory": _laptop()}
    _patch_inventory(monkeypatch, holder)
    settings = Settings(
        data_dir=tmp_path,
        api_token=AUTH_TOKEN,
        llm_provider="ollama",
        ollama_profile_enabled=False,
    )
    app = create_app(
        settings=settings,
        capture_runtime_client=TestCaptureRuntimeClient(),
        document_processing_async_jobs=False,
    )
    spawned: list[object] = []
    app.state.ollama_server._api_probe = lambda _host: True
    app.state.ollama_server._process_factory = lambda *_args, **_kwargs: spawned.append(True)
    app.state.ollama_server._executable_resolver = lambda: Path("ollama")
    with TestClient(app) as client:
        stored = client.put("/llm/device-preference", headers=_HEADERS, json={"mode": "cpu"})
        assert stored.status_code == 200
        # PUT does no I/O: nothing owned runs, so it answers from the snapshot. The
        # switch thread then probes once and finds the answering API external.
        assert stored.json()["status"] in ("active", "external_server")
        assert stored.json()["mode"] == "cpu"
        _wait_until(
            lambda: client.get("/llm/device-preference", headers=_HEADERS).json()["status"]
            == "external_server"
        )
        assert spawned == []
        health = client.get("/llm/health", headers=_HEADERS).json()
        assert health["execution_mode"] == "cpu"
        assert health["execution_warning"] == USER_CHOSEN_CPU_EXECUTION_WARNING
        assert health["device"]["server"] == "external"
        app.state.llm_provider.generate_structured_json(
            messages=[{"role": "user", "content": "hi"}],
            json_schema={"type": "object"},
        )
    assert recording.chat_calls[0]["options"]["num_gpu"] == 0
    assert spawned == []


def test_a_cpu_choice_sets_execution_mode_and_num_gpu_on_an_owned_server(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    recording = RecordingOllamaClient(models=["qwen3.5:4b"], chat_content="{}")
    monkeypatch.setattr(ollama_transport, "OllamaClient", lambda *_args, **_kwargs: recording)
    with _app(tmp_path, monkeypatch, _laptop(), llm_provider="ollama") as (client, app, procs, _holder):
        coordinator = app.state.ollama_server
        assert coordinator.ensure_running() is True
        before = client.get("/llm/health", headers=_HEADERS).json()
        assert before["execution_mode"] == "auto"
        assert before["execution_warning"] is None
        chosen = client.put("/llm/device-preference", headers=_HEADERS, json={"mode": "cpu"})
        assert chosen.status_code == 200
        _wait_until(lambda: len(procs) == 2 and procs[1].poll() is None)
        health = client.get("/llm/health", headers=_HEADERS).json()
        assert health["execution_mode"] == "cpu"
        assert health["execution_warning"] == USER_CHOSEN_CPU_EXECUTION_WARNING
        assert health["device"]["server"] == "owned"
        assert health["device"]["requested"]["target"] == "cpu"
        assert health["device"]["verification"] == "pending"
        app.state.llm_provider.generate_structured_json(
            messages=[{"role": "user", "content": "hi"}],
            json_schema={"type": "object"},
        )
        assert len(procs) == 2
        assert procs[1].env["CUDA_VISIBLE_DEVICES"] == "-1"
    assert recording.chat_calls[0]["options"]["num_gpu"] == 0


def test_a_missing_adapter_keeps_the_choice_and_the_next_start_uses_auto(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with _app(tmp_path, monkeypatch, _laptop()) as (client, app, procs, holder):
        key = adapter_key(_rtx())
        stored = client.put(
            "/llm/device-preference",
            headers=_HEADERS,
            json={"mode": "adapter", "adapter_key": key},
        )
        assert stored.status_code == 200
        assert stored.json()["mode"] == "adapter"
        assert stored.json()["adapter_key"] == key
        assert stored.json()["adapter_name"] == _RTX
        assert stored.json()["status"] == "active"
        _drop_inventory_cache()
        holder["inventory"] = _inventory([_igpu()])
        missing = client.get("/llm/device-preference", headers=_HEADERS).json()
        assert missing["mode"] == "adapter"
        assert missing["adapter_key"] == key
        assert missing["adapter_name"] == _RTX
        assert missing["status"] == "adapter_missing"
        assert app.state.ollama_server.ensure_running() is True
        assert procs[0].env["OLLAMA_VULKAN"] == "1"
        assert procs[0].env["OLLAMA_IGPU_ENABLE"] == "1"
        assert procs[0].env["CUDA_VISIBLE_DEVICES"] == "-1"
        assert _RTX_UUID not in procs[0].env.values()


def test_cpu_on_a_non_windows_machine_is_stored_as_not_applicable(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    inventory = _inventory([_rtx()], platform_name="Linux")
    with _app(tmp_path, monkeypatch, inventory) as (client, _app_state, _procs, _holder):
        stored = client.put("/llm/device-preference", headers=_HEADERS, json={"mode": "cpu"})
        assert stored.status_code == 200
        assert stored.json()["mode"] == "cpu"
        assert stored.json()["status"] == "not_applicable"
        rejected = client.put(
            "/llm/device-preference",
            headers=_HEADERS,
            json={"mode": "adapter", "adapter_key": adapter_key(_rtx())},
        )
        assert rejected.status_code == 422
        assert rejected.json()["code"] == "unknown_device"


def test_put_refreshes_inventory_only_when_the_adapter_is_not_cached(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    holder = {"inventory": _laptop()}
    calls = {"count": 0}

    def collect(**_kwargs: object) -> MachineInventorySnapshot:
        calls["count"] += 1
        return holder["inventory"]

    monkeypatch.setattr(inventory_module, "collect_machine_inventory", collect)
    settings = Settings(
        data_dir=tmp_path,
        api_token=AUTH_TOKEN,
        llm_provider="fake",
        ollama_profile_enabled=False,
    )
    app = create_app(
        settings=settings,
        capture_runtime_client=TestCaptureRuntimeClient(),
        document_processing_async_jobs=False,
    )
    _own_the_server(app.state.ollama_server)
    with TestClient(app) as client:
        listed = client.get("/llm/device-preference", headers=_HEADERS)
        assert listed.status_code == 200
        after_get = calls["count"]
        assert after_get >= 1
        known = client.put(
            "/llm/device-preference",
            headers=_HEADERS,
            json={"mode": "adapter", "adapter_key": adapter_key(_rtx())},
        )
        assert known.status_code == 200
        assert known.json()["adapter_name"] == _RTX
        assert calls["count"] == after_get

        missing = client.put(
            "/llm/device-preference",
            headers=_HEADERS,
            json={"mode": "adapter", "adapter_key": "0123456789abcdef"},
        )
        assert missing.status_code == 422
        assert calls["count"] == after_get + 1

        holder["inventory"] = _inventory([_igpu(), _rtx()])
        appeared = client.put(
            "/llm/device-preference",
            headers=_HEADERS,
            json={"mode": "adapter", "adapter_key": adapter_key(_igpu())},
        )
        assert appeared.status_code == 200
        assert appeared.json()["adapter_name"] == _IGPU
        assert calls["count"] == after_get + 2


def test_put_returns_before_the_restart_and_the_last_choice_wins(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    recording = RecordingOllamaClient(models=["qwen3.5:4b"], chat_content="{}")
    monkeypatch.setattr(ollama_transport, "OllamaClient", lambda *_args, **_kwargs: recording)
    with _app(tmp_path, monkeypatch, _laptop(), llm_provider="ollama") as (
        client,
        app,
        procs,
        _holder,
    ):
        coordinator = app.state.ollama_server
        assert coordinator.ensure_running() is True
        entered = threading.Event()
        release = threading.Event()
        real_spawn = coordinator._process_factory

        def spawn(*_args, **kwargs):
            entered.set()
            assert release.wait(timeout=5.0)
            return real_spawn(*_args, **kwargs)

        coordinator._process_factory = spawn
        try:
            chosen = client.put("/llm/device-preference", headers=_HEADERS, json={"mode": "cpu"})
            assert chosen.status_code == 200
            assert chosen.json()["status"] == "pending"
            assert chosen.json()["mode"] == "cpu"
            assert entered.wait(timeout=5.0)
            health = client.get("/llm/health", headers=_HEADERS)
            assert health.status_code == 200
            current = client.get("/llm/device-preference", headers=_HEADERS)
            assert current.status_code == 200
            assert current.json()["status"] == "pending"
            latest = client.put("/llm/device-preference", headers=_HEADERS, json={"mode": "auto"})
            assert latest.status_code == 200
            assert latest.json()["mode"] == "auto"
            assert latest.json()["status"] == "pending"
        finally:
            release.set()
        _wait_until(
            lambda: any(
                proc.poll() is None and (proc.env or {}).get("CUDA_VISIBLE_DEVICES") == _RTX_UUID
                for proc in procs
            )
        )
        running = [proc for proc in procs if proc.poll() is None]
        assert len(running) == 1
        assert running[0].env["CUDA_VISIBLE_DEVICES"] == _RTX_UUID
        body = client.get("/llm/device-preference", headers=_HEADERS).json()
        assert body["mode"] == "auto"
        assert body["status"] == "active"


def test_a_failed_start_stays_pending_and_ensure_running_applies_it(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        ollama_transport,
        "OllamaClient",
        lambda *_args, **_kwargs: FailingListOllamaClient(),
    )
    with _app(tmp_path, monkeypatch, _laptop(), llm_provider="ollama") as (
        client,
        app,
        procs,
        _holder,
    ):
        coordinator = app.state.ollama_server
        assert coordinator.ensure_running() is True
        real_spawn = coordinator._process_factory

        def spawn(*_args, **kwargs):
            proc = real_spawn(*_args, **kwargs)
            proc._returncode = 0
            return proc

        coordinator._process_factory = spawn
        chosen = client.put("/llm/device-preference", headers=_HEADERS, json={"mode": "cpu"})
        assert chosen.status_code == 200
        assert chosen.json()["status"] == "pending"
        _wait_until(
            lambda: coordinator.device_preference_application()[0]
            and coordinator.device_status().server == "not_running"
            and not coordinator._restarting
        )
        assert client.get("/llm/device-preference", headers=_HEADERS).json()["status"] == "pending"
        health = client.get("/llm/health", headers=_HEADERS)
        assert health.status_code == 200
        assert health.json()["device"]["server"] == "not_running"
        assert client.get("/llm/device-preference", headers=_HEADERS).json()["status"] == "pending"

        coordinator._process_factory = real_spawn
        assert coordinator.ensure_running() is True
        assert client.get("/llm/device-preference", headers=_HEADERS).json()["status"] == "active"
        running = [proc for proc in procs if proc.poll() is None]
        assert len(running) == 1
        assert running[0].env["CUDA_VISIBLE_DEVICES"] == "-1"
