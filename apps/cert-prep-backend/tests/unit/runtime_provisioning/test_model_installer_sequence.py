"""Pin the bridge's optional onboarding sequence and independent progress counters."""

import pytest

from cert_prep_backend.platform.errors import ProviderUnavailableError
from cert_prep_backend.runtime_provisioning.infrastructure.installers import LLMModelInstaller
from cert_prep_contracts.llm import ModelPullProgress


class Provider:
    provider = "future-provider"
    model = "chosen-model"

    def __init__(self):
        self.calls = []

    def prepare_model_onboarding(self, progress):
        self.calls.append("prepare")
        progress(ModelPullProgress(status="prepare", completed=99, total=100))
        progress(ModelPullProgress(status=None))

    def pull_model(self, progress):
        self.calls.append("pull")
        progress(ModelPullProgress(status="download", completed=2, total=10))
        progress(ModelPullProgress(status=None, completed=None, total=20))

    def verify_model_onboarding(self, progress):
        self.calls.append("verify")
        progress(ModelPullProgress(status="verify", completed=0, total=None))
        progress(ModelPullProgress(status=None))


def test_onboarding_order_and_count_retention():
    provider = Provider()
    progress = []
    LLMModelInstaller(provider).install(progress.append)
    assert provider.calls == ["prepare", "pull", "verify"]
    assert [(item.detail, item.completed, item.total) for item in progress] == [
        ("Preparing model onboarding.", None, None),
        ("prepare", 99, 100),
        ("model onboarding running", None, None),
        ("Downloading the selected model.", None, None),
        ("download", 2, 10),
        ("model download running", 2, 20),
        ("Committing the selected model.", 2, 20),
        ("Verifying model onboarding.", 2, 20),
        ("verify", 0, 20),
        ("model verification running", 0, 20),
        ("Model onboarding verified.", 0, 20),
    ]


@pytest.mark.parametrize("stage", ["prepare_model_onboarding", "pull_model", "verify_model_onboarding"])
def test_each_onboarding_stage_translates_failure(stage):
    provider = Provider()

    def fail(progress):
        raise ValueError("provider failed")

    setattr(provider, stage, fail)
    with pytest.raises(ProviderUnavailableError, match="future-provider unavailable: provider failed"):
        LLMModelInstaller(provider).install(lambda progress: None)
