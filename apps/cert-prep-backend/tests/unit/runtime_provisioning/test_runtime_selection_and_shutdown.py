"""Selection and shutdown behavior pinned before extracting application orchestration."""

from types import SimpleNamespace
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest

from cert_prep_backend.platform.config import Settings
from cert_prep_backend.platform.errors import ProviderUnavailableError
from cert_prep_backend.ai_providers.infrastructure import runtime_installers
from cert_prep_backend.runtime_provisioning.infrastructure.manager import RuntimeInstallationManager
from cert_prep_contracts.runtime import RuntimeInstallationStatus as Status
from cert_prep_contracts.runtime import RuntimeRequirementKind as Kind
from llm_test_fakes import FakeProfileInstaller, GIB, _profile_inventory
from runtime_characterization_support import (
    ScriptedInstaller,
    installer as installer,
    make_manager as make_manager,
    no_ollama_start as no_ollama_start,
    runtime_clock as runtime_clock,
    worker_gates as worker_gates,
)


@pytest.mark.parametrize("overrides", [None, []])
@pytest.mark.parametrize("profile_enabled", [False, True])
def test_default_catalog_lazy_selection_and_empty_override(
    tmp_path, monkeypatch, overrides, profile_enabled,
):
    from cert_prep_ollama import profile_installer

    events = []
    probes = []
    monkeypatch.setattr(
        profile_installer, "OllamaProfileInstaller",
        lambda selected, **kwargs: FakeProfileInstaller(selected, events),
    )
    inventory = _profile_inventory(total_ram=16 * GIB, free_disk=64 * GIB)
    machine = SimpleNamespace(inventory=lambda: probes.append("inventory") or inventory)
    provider = SimpleNamespace(provider="ollama", model="raw", runtime_requirement_kind=Kind.OLLAMA)
    manager = RuntimeInstallationManager(
        settings=Settings(data_dir=tmp_path, llm_provider="ollama", ollama_profile_enabled=profile_enabled),
        llm_provider=provider, machine_inventory=machine, installers=overrides, async_jobs=False,
    )
    try:
        assert list(manager._installers) == [Kind.OLLAMA, Kind.OLLAMA_MODEL]
        assert probes == events == []
        model = manager._installers[Kind.OLLAMA_MODEL]
        assert model.model == ("ollama-profile:auto" if profile_enabled else "raw")
        first = manager.requirement(Kind.OLLAMA_MODEL)
        second = manager.requirement(Kind.OLLAMA_MODEL)
        assert first == second
        assert probes == (["inventory"] if profile_enabled else [])
        assert len(events) == (1 if profile_enabled else 0)
    finally:
        manager.close()


def test_disabled_profile_uses_provider_preselection_without_inventory(tmp_path, monkeypatch):
    from cert_prep_ollama import profile_installer

    events = []
    selected = SimpleNamespace(local_model="chosen", profile_id="chosen-profile")
    monkeypatch.setattr(
        profile_installer, "OllamaProfileInstaller",
        lambda profile, **kwargs: FakeProfileInstaller(profile, events),
    )
    manager = RuntimeInstallationManager(
        settings=Settings(data_dir=tmp_path, llm_provider="ollama", ollama_profile_enabled=False),
        llm_provider=SimpleNamespace(
            provider="ollama", model="raw", runtime_requirement_kind=Kind.OLLAMA,
            profile_selection=SimpleNamespace(selected_profile=selected),
        ),
        machine_inventory=object(), async_jobs=False,
    )
    try:
        assert events == [("init", "chosen-profile")]
        assert manager.start_model_installation().model == "chosen"
    finally:
        manager.close()


def test_provider_name_alone_does_not_enable_a_runtime_or_profile(tmp_path):
    provider = SimpleNamespace(provider="ollama", model="raw", profile_selection=object())
    fallback = object()
    runtimes, model = runtime_installers.configured_installer_choices(
        Settings(data_dir=tmp_path, llm_provider="ollama"), provider, object(), lambda: fallback,
    )
    assert runtimes == [] and model is fallback


def test_failed_lazy_profile_selection_is_retried_and_success_is_cached(tmp_path, monkeypatch):
    from cert_prep_ollama import profile_installer

    settings = Settings(data_dir=tmp_path, llm_provider="ollama")
    attempts, events = [], []
    selected = SimpleNamespace(local_model="cached-model", profile_id="cached-profile")

    def choose(*args, **kwargs):
        attempts.append(kwargs)
        return None if len(attempts) == 1 else SimpleNamespace(selected_profile=selected)

    monkeypatch.setattr(runtime_installers, "choose_ollama_profile", choose)
    monkeypatch.setattr(
        profile_installer, "OllamaProfileInstaller",
        lambda profile, **kwargs: FakeProfileInstaller(profile, events),
    )
    lazy = runtime_installers.LazyOllamaProfileInstaller(settings, SimpleNamespace(inventory=object()))
    assert lazy.model == "ollama-profile:auto"
    with pytest.raises(ProviderUnavailableError, match="Ollama profile selection is not available."):
        lazy.requirement()
    lazy.validate_installable()
    assert lazy.model == "cached-model"
    lazy.requirement()
    lazy.install(lambda progress: None)
    assert attempts == [{"provider_selected": True}, {"provider_selected": True}]
    assert events == [("init", "cached-profile"), ("install", "cached-model")]


def test_concurrent_lazy_profile_probes_construct_one_installer(tmp_path, monkeypatch):
    from cert_prep_ollama import profile_installer

    entered, release = Event(), Event()
    events = []
    selected = SimpleNamespace(local_model="cached-model", profile_id="cached-profile")
    monkeypatch.setattr(
        runtime_installers, "choose_ollama_profile",
        lambda *args, **kwargs: SimpleNamespace(selected_profile=selected),
    )

    def create(profile, **kwargs):
        entered.set()
        assert release.wait(timeout=5)
        return FakeProfileInstaller(profile, events)

    monkeypatch.setattr(profile_installer, "OllamaProfileInstaller", create)
    lazy = runtime_installers.LazyOllamaProfileInstaller(
        Settings(data_dir=tmp_path), SimpleNamespace(inventory=object()),
    )
    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(lazy.requirement)
        try:
            assert entered.wait(timeout=5)
            second = executor.submit(lazy.requirement)
        finally:
            release.set()
        assert first.result(timeout=5) == second.result(timeout=5)
    assert events == [("init", "cached-profile")]


def test_override_catalog_last_duplicate_wins_and_requirements_follow_enum(make_manager):
    first = ScriptedInstaller(Kind.OLLAMA_MODEL)
    replacement = ScriptedInstaller(Kind.OLLAMA_MODEL)
    runtime = ScriptedInstaller(Kind.OLLAMA)
    manager = make_manager(installers=[first, runtime, replacement])
    assert [item.kind for item in manager.requirements()] == list(Kind)
    assert first.calls == []
    assert replacement.calls == runtime.calls == ["requirement"]


def test_shutdown_cancels_queued_work_and_joins_with_bound(make_manager, worker_gates, monkeypatch):
    manager = make_manager(async_jobs=True)
    queued = manager.start_installation(Kind.OLLAMA)
    joins = []
    worker = worker_gates[0][2]
    original_join = worker.join
    monkeypatch.setattr(worker, "join", lambda timeout: joins.append(timeout))
    manager.close()
    assert joins == [1]
    assert manager.get_installation(queued.id).status == Status.CANCELED
    monkeypatch.setattr(worker, "join", original_join)


def test_shutdown_keeps_committing_jobs(make_manager, installer):
    from cert_prep_contracts.runtime import RuntimeInstallProgress

    manager = make_manager()

    def install(progress):
        progress(RuntimeInstallProgress("commit", phase="committing", cancellable=False))
        manager.close()
        assert manager.get_installation(next(iter(manager._jobs))).status == Status.RUNNING
        return Status.SUCCEEDED

    installer.action = install
    assert manager.start_installation(Kind.OLLAMA).status == Status.SUCCEEDED
