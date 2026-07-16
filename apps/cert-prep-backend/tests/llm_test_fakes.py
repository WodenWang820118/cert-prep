from collections.abc import Sequence
from threading import Event

from cert_prep_backend.core.config import DEFAULT_OLLAMA_MODEL
from cert_prep_backend.domains.mock_exams.models import DraftSuggestion, SourceChunk
from cert_prep_backend.domains.mock_exams.ports import ProviderHealth
from cert_prep_contracts.hardware import (
    MachineCpuSnapshot,
    MachineInventorySnapshot,
    MachineRamSnapshot,
    MachineStorageSnapshot,
)
from cert_prep_contracts.llm import ModelPullProgress
from cert_prep_contracts.runtime import (
    RuntimeInstallationStatus,
    RuntimeInstallProgress,
    RuntimeRequirementKind,
    RuntimeRequirementSnapshot,
)


GIB = 1024 * 1024 * 1024


class FakeProfileInstaller:
    kind = RuntimeRequirementKind.OLLAMA_MODEL
    provider = "ollama"

    def __init__(
        self,
        profile,
        events: list[tuple[object, ...]],
        *,
        fallback_profiles=(),
    ) -> None:
        self.profile = profile
        self.model = profile.local_model
        self.fallback_profiles = tuple(fallback_profiles)
        self._events = events
        self._events.append(
            (
                "init",
                profile.profile_id,
                tuple(profile.profile_id for profile in self.fallback_profiles),
            )
        )

    def requirement(self) -> RuntimeRequirementSnapshot:
        return RuntimeRequirementSnapshot(
            kind=self.kind,
            label="Ollama profile model",
            available=False,
            detail="profile model missing",
            unavailable_reason="model_missing",
            version=self.model,
        )

    def validate_installable(self) -> None:
        return None

    def install(self, progress) -> RuntimeInstallationStatus:
        self._events.append(
            (
                "install",
                self.model,
                tuple(profile.local_model for profile in self.fallback_profiles),
            )
        )
        progress(RuntimeInstallProgress("created profile model", completed=100, total=100))
        return RuntimeInstallationStatus.SUCCEEDED

def _profile_inventory(
    *,
    total_ram: int,
    free_disk: int,
) -> MachineInventorySnapshot:
    return MachineInventorySnapshot(
        platform="Windows",
        platform_version="11",
        architecture="AMD64",
        cpu=MachineCpuSnapshot(architecture="AMD64", logical_cores=12),
        ram=MachineRamSnapshot(
            total_bytes=total_ram,
            available_bytes=max(total_ram // 2, 1),
        ),
        storage=MachineStorageSnapshot(
            path="C:/cert-prep",
            free_bytes=free_disk,
            total_bytes=256 * GIB,
        ),
    )

class RecordingDownloadProvider:
    provider = "ollama"
    model = DEFAULT_OLLAMA_MODEL

    def __init__(self, *, available: bool, detail: str) -> None:
        self.available = available
        self.detail = detail
        self.pull_calls = 0

    def health(self) -> ProviderHealth:
        return ProviderHealth(
            provider=self.provider,
            model=self.model,
            available=self.available,
            detail=self.detail,
        )

    def generate_drafts(self, chunks: Sequence[SourceChunk], limit: int) -> list[DraftSuggestion]:
        return []

    def pull_model(self, progress) -> None:
        self.pull_calls += 1
        progress(ModelPullProgress(status="pulling manifest"))
        progress(ModelPullProgress(status="downloading", completed=50, total=100))
        progress(ModelPullProgress(status="success", completed=100, total=100))

class RecordingOllamaClient:
    def __init__(
        self,
        *,
        models: list[str],
        chat_content: str = "ok",
        fail_models: dict[str, Exception] | None = None,
    ) -> None:
        self.models = models
        self.chat_content = chat_content
        self.fail_models = fail_models or {}
        self.chat_calls: list[dict] = []
        self.pull_calls = 0

    def list(self) -> dict:
        return {"models": [{"model": model} for model in self.models]}

    def chat(self, **kwargs) -> dict:
        self.chat_calls.append(kwargs)
        model = kwargs.get("model")
        if isinstance(model, str) and model in self.fail_models:
            raise self.fail_models[model]
        return {"message": {"content": self.chat_content}}

    def pull(self, *_args, **_kwargs):
        self.pull_calls += 1
        raise AssertionError("provider probe must not pull models")

class FlakyListOllamaClient(RecordingOllamaClient):
    def __init__(self, *, models: list[str]) -> None:
        super().__init__(models=models)
        self.list_calls = 0

    def list(self) -> dict:
        self.list_calls += 1
        if self.list_calls == 1:
            raise RuntimeError("connection refused")
        return super().list()

class FailingListOllamaClient(RecordingOllamaClient):
    def __init__(self) -> None:
        super().__init__(models=[])
        self.list_calls = 0

    def list(self) -> dict:
        self.list_calls += 1
        raise RuntimeError("connection refused")

class BlockingDownloadProvider(RecordingDownloadProvider):
    def __init__(self, release_pull: Event) -> None:
        super().__init__(available=False, detail="model not found")
        self._release_pull = release_pull

    def pull_model(self, progress) -> None:
        self.pull_calls += 1
        progress(ModelPullProgress(status="downloading", completed=1, total=100))
        self._release_pull.wait(timeout=5)
        progress(ModelPullProgress(status="success", completed=100, total=100))

class FailingDownloadProvider(RecordingDownloadProvider):
    def __init__(self) -> None:
        super().__init__(available=False, detail="model not found")

    def pull_model(self, progress) -> None:
        self.pull_calls += 1
        progress(ModelPullProgress(status="pulling manifest"))
        raise RuntimeError("connection refused")


class RecordingOnboardingProvider(RecordingDownloadProvider):
    provider = "future-provider"
    model = "future-model"

    def __init__(self) -> None:
        super().__init__(available=False, detail="model not found")
        self.events: list[str] = []

    def prepare_model_onboarding(self, progress) -> None:
        self.events.append("validate/list")
        progress(ModelPullProgress(status="runtime validated"))

    def pull_model(self, progress) -> None:
        self.events.append("pull")
        super().pull_model(progress)

    def verify_model_onboarding(self, progress) -> None:
        self.events.append("check/serve/models/completion")
        progress(ModelPullProgress(status="generation ready"))
