from pathlib import Path
from types import SimpleNamespace
import threading
import time
from unittest.mock import Mock

import pytest

from cert_prep_backend.ai_providers.infrastructure import translation
from cert_prep_backend.platform.config import Settings
from cert_prep_contracts.hardware import (
    MachineAcceleratorSnapshot,
    MachineCpuSnapshot,
    MachineInventorySnapshot,
    MachineRamSnapshot,
    MachineStorageSnapshot,
)
from cert_prep_ollama.device_policy import OllamaDevicePreference
from cert_prep_ollama.server_coordinator import OllamaServerCoordinator


@pytest.mark.parametrize('keep_alive', [0, '5m'])
@pytest.mark.parametrize('content, expected', [('  譯文  ', '譯文'), (None, '')])
def test_translation_preserves_model_request(monkeypatch, keep_alive, content, expected):
    client = Mock()
    client.chat.return_value = SimpleNamespace(message=SimpleNamespace(content=content))
    factory = Mock(return_value=client)
    monkeypatch.setattr(translation, 'Client', factory)
    settings = Settings(ollama_host='http://localhost:1234', ollama_timeout_seconds=37)
    translator = translation.OllamaTraditionalChineseTranslator(settings, keep_alive=keep_alive)

    assert translator.translate('原文') == expected
    factory.assert_called_once_with(host=settings.ollama_host, timeout=37)
    client.chat.assert_called_once_with(
        model=settings.ollama_model,
        messages=[
            {
                'role': 'system',
                'content': (
                    'Translate Japanese into natural Traditional Chinese used in Taiwan. '
                    'Return only the translation. Preserve names, numbers, and meaning.'
                ),
            },
            {'role': 'user', 'content': '原文'},
        ],
        options={'temperature': 0, 'num_ctx': 2048, 'num_predict': 512},
        think=False,
        stream=False,
        keep_alive=keep_alive,
    )
    translator.release_resources()
    translator.release_resources()
    if keep_alive == 0:
        client.generate.assert_not_called()
    else:
        client.generate.assert_called_once_with(model=settings.ollama_model, keep_alive=0)


def test_translation_propagates_model_errors(monkeypatch):
    client = Mock()
    failure = RuntimeError('model unavailable')
    client.chat.side_effect = failure
    monkeypatch.setattr(translation, 'Client', Mock(return_value=client))

    with pytest.raises(RuntimeError) as raised:
        translation.OllamaTraditionalChineseTranslator(Settings()).translate('原文')
    assert raised.value is failure


def _windows_inventory(*, gpu: bool) -> MachineInventorySnapshot:
    accelerators = ()
    if gpu:
        accelerators = (
            MachineAcceleratorSnapshot(
                kind='gpu',
                name='NVIDIA GeForce RTX 4060 Laptop GPU',
                classification='dedicated',
                pci_vendor_id='10de',
                pci_device_id='28a0',
                device_id='GPU-3c990263-ad20-7ce7-1ad5-cae44a0d9df3',
                dedicated_memory_bytes=8_342_470_656,
            ),
        )
    return MachineInventorySnapshot(
        platform='Windows',
        platform_version='10.0.26100',
        architecture='AMD64',
        cpu=MachineCpuSnapshot(architecture='AMD64'),
        ram=MachineRamSnapshot(32 * 1024**3, 16 * 1024**3),
        storage=MachineStorageSnapshot('C:\\', 64 * 1024**3, 128 * 1024**3),
        accelerators=accelerators,
    )


class _Clock:
    def __init__(self) -> None:
        self.current = 1000.0

    def time(self) -> float:
        return self.current

    def sleep(self, seconds: float) -> None:
        self.current += seconds


class _Process:
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


def _coordinator(preference: OllamaDevicePreference, inventory: MachineInventorySnapshot, *, probe):
    clock = _Clock()
    procs: list[_Process] = []

    def spawn(*_args, **kwargs) -> _Process:
        proc = _Process(9000 + len(procs), dict(kwargs.get('env') or {}))
        procs.append(proc)
        return proc

    def terminate(pid: int) -> None:
        for proc in procs:
            if proc.pid == pid:
                proc.terminate()

    coordinator = OllamaServerCoordinator(
        host='http://127.0.0.1:11434',
        inventory_provider=lambda: inventory,
        executable_resolver=lambda: Path('ollama'),
        process_factory=spawn,
        api_probe=probe,
        tree_terminator=terminate,
        clock=clock.time,
        sleep=clock.sleep,
        base_environment={'PATH': 'C:\\Windows'},
        platform_name='Windows',
        preference_provider=lambda: preference,
    )
    return coordinator, procs


def _translate(monkeypatch, server) -> dict:
    client = Mock()
    client.chat.return_value = SimpleNamespace(message=SimpleNamespace(content='譯文'))
    monkeypatch.setattr(translation, 'Client', Mock(return_value=client))
    translator = translation.OllamaTraditionalChineseTranslator(Settings(), server=server)
    assert translator.translate('原文') == '譯文'
    return client.chat.call_args.kwargs['options']


def test_translation_sends_num_gpu_for_a_cpu_choice_on_an_owned_server(monkeypatch):
    preference = OllamaDevicePreference(mode='cpu')
    inventory = _windows_inventory(gpu=True)
    coordinator, procs = _coordinator(
        preference,
        inventory,
        probe=lambda _host: any(proc.poll() is None for proc in procs),
    )
    assert coordinator.ensure_running() is True
    assert coordinator.ownership == 'owned'
    options = _translate(monkeypatch, coordinator)
    assert options['num_gpu'] == 0
    assert options['temperature'] == 0
    assert options['num_ctx'] == 2048
    assert options['num_predict'] == 512


def test_translation_sends_num_gpu_for_a_cpu_choice_on_an_external_server(monkeypatch):
    coordinator, procs = _coordinator(
        OllamaDevicePreference(mode='cpu'),
        _windows_inventory(gpu=True),
        probe=lambda _host: True,
    )
    assert coordinator.ensure_running() is True
    assert coordinator.ownership == 'external'
    assert procs == []
    options = _translate(monkeypatch, coordinator)
    assert options['num_gpu'] == 0
    assert options['num_ctx'] == 2048


def test_translation_on_a_machine_with_no_gpu_keeps_auto_options(monkeypatch):
    coordinator, _procs = _coordinator(
        OllamaDevicePreference(),
        _windows_inventory(gpu=False),
        probe=lambda _host: True,
    )
    assert coordinator.cpu_request_override() is None
    options = _translate(monkeypatch, coordinator)
    assert options == {
        'temperature': 0,
        'num_ctx': 2048,
        'num_predict': 512,
    }


def test_a_translation_in_flight_is_not_interrupted_by_a_device_switch(monkeypatch):
    current = {'preference': OllamaDevicePreference()}
    inventory = _windows_inventory(gpu=True)
    clock = _Clock()
    procs: list[_Process] = []

    def spawn(*_args, **kwargs) -> _Process:
        proc = _Process(9100 + len(procs), dict(kwargs.get('env') or {}))
        procs.append(proc)
        return proc

    coordinator = OllamaServerCoordinator(
        host='http://127.0.0.1:11434',
        inventory_provider=lambda: inventory,
        executable_resolver=lambda: Path('ollama'),
        process_factory=spawn,
        api_probe=lambda _host: any(proc.poll() is None for proc in procs),
        tree_terminator=lambda pid: next(proc for proc in procs if proc.pid == pid).terminate(),
        clock=clock.time,
        sleep=clock.sleep,
        base_environment={'PATH': 'C:\\Windows'},
        platform_name='Windows',
        preference_provider=lambda: current['preference'],
    )
    assert coordinator.ensure_running() is True
    entered = threading.Event()
    release = threading.Event()
    client = Mock()

    def chat(**_kwargs):
        entered.set()
        assert release.wait(timeout=5.0)
        assert procs[0].poll() is None
        return SimpleNamespace(message=SimpleNamespace(content='譯文'))

    client.chat.side_effect = chat
    monkeypatch.setattr(translation, 'Client', Mock(return_value=client))
    translator = translation.OllamaTraditionalChineseTranslator(Settings(), server=coordinator)
    errors: list[BaseException] = []

    def run() -> None:
        try:
            assert translator.translate('原文') == '譯文'
        except BaseException as exc:  # noqa: BLE001 - the test thread must report it
            errors.append(exc)

    worker = threading.Thread(target=run)
    worker.start()
    assert entered.wait(timeout=5.0)
    current['preference'] = OllamaDevicePreference(mode='cpu')
    coordinator.apply_device_preference(current['preference'])
    assert coordinator.device_preference_application() == (True, False)
    assert procs[0].poll() is None
    release.set()
    worker.join(timeout=5.0)
    assert errors == []
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        if len(procs) == 2 and coordinator.device_preference_application() == (False, False):
            break
        threading.Event().wait(0.01)
    assert len(procs) == 2
    assert procs[0].poll() is not None
    assert procs[1].env['CUDA_VISIBLE_DEVICES'] == '-1'
    assert coordinator.device_preference_application() == (False, False)
