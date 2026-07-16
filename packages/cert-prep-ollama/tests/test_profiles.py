from __future__ import annotations

import pytest

from cert_prep_contracts.hardware import (
    MachineAcceleratorSnapshot,
    MachineCpuSnapshot,
    MachineInventorySnapshot,
    MachineRamSnapshot,
    MachineStorageSnapshot,
)
from cert_prep_contracts.llm import LLMExecutionMode, ModelPullProgress
from cert_prep_contracts.llm_profiles import OllamaProfileSupportStatus
from cert_prep_ollama import profile_installer as profile_installer_module
from cert_prep_ollama.modelfiles import modelfile_sha256, render_modelfile
from cert_prep_ollama.profile_installer import OllamaProfileInstaller
from cert_prep_ollama.profiles import (
    DEFAULT_PROFILE_ID,
    GIB,
    profile_by_id,
    profile_catalog,
    select_ollama_execution_policy,
    select_ollama_profile,
)


def test_profile_catalog_contains_only_fixed_4b_study_profile() -> None:
    profiles = profile_catalog()

    assert [profile.profile_id for profile in profiles] == [DEFAULT_PROFILE_ID]
    assert profiles[0].base_model == "qwen3.5:4b"
    assert profiles[0].fallback_profile_ids == ()


def test_modelfile_rendering_is_deterministic() -> None:
    profile = profile_by_id(DEFAULT_PROFILE_ID)

    first = render_modelfile(profile)
    second = render_modelfile(profile)

    assert first == second
    assert first.startswith("FROM qwen3.5:4b\n")
    assert "PARAMETER num_ctx 8192\n" in first
    assert modelfile_sha256(profile) == modelfile_sha256(profile)


def test_auto_selection_keeps_fixed_4b_for_low_inventory() -> None:
    selection = select_ollama_profile(
        _inventory(total_ram=6 * GIB, available_ram=3 * GIB, free_disk=7 * GIB)
    )

    assert selection.profile_id == DEFAULT_PROFILE_ID
    assert selection.selected_profile.base_model == "qwen3.5:4b"
    assert selection.fallback_profiles == ()
    assert selection.support_status == OllamaProfileSupportStatus.WARNING


def test_auto_selection_keeps_fixed_4b_when_available_ram_is_low() -> None:
    selection = select_ollama_profile(
        _inventory(total_ram=12 * GIB, available_ram=1 * GIB, free_disk=32 * GIB)
    )

    assert selection.profile_id == DEFAULT_PROFILE_ID
    assert "Available RAM is below" in selection.warnings[0]


def test_whitespace_profile_id_falls_back_to_auto() -> None:
    selection = select_ollama_profile(
        _inventory(total_ram=16 * GIB, available_ram=8 * GIB, free_disk=64 * GIB),
        profile_id="   ",
    )

    assert selection.profile_id == DEFAULT_PROFILE_ID


def test_auto_selection_keeps_default_profile_when_inventory_is_incomplete() -> None:
    selection = select_ollama_profile(
        _inventory(total_ram=None, available_ram=None, free_disk=None)
    )

    assert selection.profile_id == DEFAULT_PROFILE_ID
    assert selection.support_status == OllamaProfileSupportStatus.WARNING
    assert "fixed 4B profile" in selection.reason


def test_auto_selection_default_profile_reports_requirement_warnings() -> None:
    selection = select_ollama_profile(
        _inventory(total_ram=12 * GIB, available_ram=None, free_disk=32 * GIB)
    )

    assert selection.profile_id == DEFAULT_PROFILE_ID
    assert selection.support_status == OllamaProfileSupportStatus.WARNING
    assert "Available RAM is unknown." in selection.warnings


def test_auto_selection_never_changes_profile_on_large_machine() -> None:
    selection = select_ollama_profile(
        _inventory(
            total_ram=32 * GIB,
            available_ram=16 * GIB,
            free_disk=128 * GIB,
            gpu_memory=12 * GIB,
        )
    )

    assert selection.profile_id == DEFAULT_PROFILE_ID
    assert selection.selected_profile.base_model == "qwen3.5:4b"
    assert selection.fallback_profiles == ()


def test_windows_execution_policy_forces_cpu_without_gpu() -> None:
    policy = select_ollama_execution_policy(
        _inventory(total_ram=16 * GIB, available_ram=8 * GIB, free_disk=64 * GIB)
    )

    assert policy.mode == LLMExecutionMode.CPU
    assert policy.warning is not None
    assert "forced CPU mode" in policy.warning


def test_windows_execution_policy_keeps_generic_gpu_in_auto_mode() -> None:
    policy = select_ollama_execution_policy(
        _inventory(
            total_ram=16 * GIB,
            available_ram=8 * GIB,
            free_disk=64 * GIB,
            gpu_memory=4 * GIB,
            gpu_vendor=None,
            gpu_name="Generic Graphics Adapter",
        )
    )

    assert policy.mode == LLMExecutionMode.AUTO
    assert policy.warning is None


def test_execution_policy_keeps_non_windows_and_unknown_inventory_in_auto_mode() -> None:
    policy = select_ollama_execution_policy(None, platform_name="Linux")

    assert policy.mode == LLMExecutionMode.AUTO
    assert policy.warning is None


def test_windows_execution_policy_forces_cpu_when_inventory_failed() -> None:
    policy = select_ollama_execution_policy(None, platform_name="Windows")

    assert policy.mode == LLMExecutionMode.CPU
    assert policy.warning is not None


def test_removed_profile_id_is_rejected() -> None:
    with pytest.raises(ValueError, match="Unknown Ollama profile id"):
        select_ollama_profile(
            _inventory(total_ram=8 * GIB, available_ram=4 * GIB, free_disk=20 * GIB),
            profile_id="qwen3.5-9b-study-16k",
        )


def test_profile_installer_pulls_base_model_and_creates_local_profile() -> None:
    profile = profile_by_id(DEFAULT_PROFILE_ID)
    client = FakeOllamaClient()
    progress: list[tuple[str, int | None, int | None, str | None, bool | None]] = []
    installer = OllamaProfileInstaller(
        profile,
        client=client,
        ensure_server=False,
    )

    status = installer.install(
        lambda item: progress.append(
            (
                item.detail,
                item.completed,
                item.total,
                item.phase,
                item.cancellable,
            )
        )
    )

    assert status.value == "succeeded"
    assert client.pull_calls == [(profile.base_model, True)]
    assert client.create_calls == [
        {
            "model": profile.local_model,
            "from_": profile.base_model,
            "system": profile.system_prompt,
            "parameters": {
                "num_ctx": 8192,
                "num_predict": 4096,
                "temperature": 0,
            },
            "stream": True,
        }
    ]
    assert progress == [
        (
            f"Pulling base model {profile.base_model}.",
            None,
            None,
            "model_download",
            True,
        ),
        ("pulling manifest", None, None, "model_download", True),
        ("downloading", 50, 100, "model_download", True),
        ("Committing Ollama profile model.", 50, 100, "committing", False),
        (
            f"Creating profile model {profile.local_model}.",
            50,
            100,
            "committing",
            False,
        ),
        ("creating profile", 50, 100, "committing", False),
        ("success", 23, 23, "committing", False),
        ("Verifying Ollama profile registration.", 23, 23, "committing", False),
        ("Ollama profile registration verified.", 23, 23, "committing", False),
    ]


def test_profile_installer_accepts_running_api_without_cli(monkeypatch) -> None:
    profile = profile_by_id(DEFAULT_PROFILE_ID)
    client = FakeOllamaClient()
    monkeypatch.setattr(
        profile_installer_module,
        "resolve_ollama_executable",
        lambda: None,
    )
    monkeypatch.setattr(
        profile_installer_module,
        "ensure_ollama_server_running",
        lambda _host, *, executable=None, timeout_seconds=30.0: True,
    )
    installer = OllamaProfileInstaller(profile, client=client)

    requirement = installer.requirement()

    assert requirement.available is False
    assert requirement.unavailable_reason == "model_missing"


def test_profile_installer_accepts_implicit_latest_profile_alias() -> None:
    profile = profile_by_id(DEFAULT_PROFILE_ID)
    client = FakeOllamaClient(list_created_models_with_latest_tag=True)
    installer = OllamaProfileInstaller(
        profile,
        client=client,
        ensure_server=False,
    )

    status = installer.install(lambda _item: None)

    assert status.value == "succeeded"
    assert client.models == [profile.local_model]


def test_profile_installer_exposes_no_fallback_profiles() -> None:
    profile = profile_by_id(DEFAULT_PROFILE_ID)
    client = FakeOllamaClient()
    installer = OllamaProfileInstaller(
        profile,
        client=client,
        ensure_server=False,
    )

    assert installer.fallback_profiles == ()


def test_profile_installer_reports_missing_registration() -> None:
    profile = profile_by_id(DEFAULT_PROFILE_ID)
    client = FakeOllamaClient(register_created_models=False)
    installer = OllamaProfileInstaller(
        profile,
        client=client,
        ensure_server=False,
    )

    try:
        installer.install(lambda _item: None)
    except Exception as exc:
        assert "was not registered" in str(exc)
    else:
        raise AssertionError("Expected missing registration to fail.")


def test_profile_installer_fails_create_stream_error() -> None:
    profile = profile_by_id(DEFAULT_PROFILE_ID)
    client = FakeOllamaClient(create_error="template parse failed")
    installer = OllamaProfileInstaller(
        profile,
        client=client,
        ensure_server=False,
    )

    try:
        installer.install(lambda _item: None)
    except Exception as exc:
        assert "profile creation failed" in str(exc)
        assert getattr(exc, "code", None) == "ollama_create_failed"
    else:
        raise AssertionError("Expected create stream error to fail.")


class FakeOllamaClient:
    def __init__(
        self,
        *,
        register_created_models: bool = True,
        create_error: str | None = None,
        list_created_models_with_latest_tag: bool = False,
    ) -> None:
        self.models: list[str] = []
        self.pull_calls: list[tuple[str, bool]] = []
        self.create_calls: list[dict[str, object]] = []
        self.register_created_models = register_created_models
        self.create_error = create_error
        self.list_created_models_with_latest_tag = list_created_models_with_latest_tag

    def list(self):
        models = (
            [f"{model}:latest" for model in self.models]
            if self.list_created_models_with_latest_tag
            else self.models
        )
        return {"models": [{"model": model} for model in models]}

    def pull(self, model: str, *, stream: bool):
        self.pull_calls.append((model, stream))
        yield {"status": "pulling manifest"}
        yield {"status": "downloading", "completed": 50, "total": 100}

    def create(self, **kwargs):
        self.create_calls.append(kwargs)
        if self.create_error is not None:
            yield {"error": self.create_error}
            return
        model = kwargs.get("model")
        if self.register_created_models and isinstance(model, str):
            self.models.append(model)
        yield {"status": "creating profile"}
        yield ModelPullProgress(status="success", completed=23, total=23)


def _inventory(
    *,
    total_ram: int | None,
    available_ram: int | None,
    free_disk: int | None,
    gpu_memory: int | None = None,
    gpu_vendor: str | None = "nvidia",
    gpu_name: str = "Test GPU",
) -> MachineInventorySnapshot:
    accelerators = ()
    if gpu_memory is not None:
        accelerators = (
            MachineAcceleratorSnapshot(
                kind="gpu",
                vendor=gpu_vendor,
                name=gpu_name,
                memory_bytes=gpu_memory,
            ),
        )
    return MachineInventorySnapshot(
        platform="Windows",
        platform_version="11",
        architecture="AMD64",
        cpu=MachineCpuSnapshot(architecture="AMD64", logical_cores=12),
        ram=MachineRamSnapshot(
            total_bytes=total_ram,
            available_bytes=available_ram,
        ),
        storage=MachineStorageSnapshot(path="C:/cert-prep", free_bytes=free_disk),
        accelerators=accelerators,
    )
