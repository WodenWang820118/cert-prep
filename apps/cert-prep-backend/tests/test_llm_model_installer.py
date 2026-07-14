from __future__ import annotations

from cert_prep_backend.domains.runtime_installations.installers import LLMModelInstaller
from cert_prep_contracts.llm import ModelPullProgress
from cert_prep_contracts.runtime import (
    RuntimeInstallationStatus,
    RuntimeInstallProgress,
)


class RecordingOnboardingProvider:
    provider = "fastflowlm"
    model = "qwen3.5:4b"

    def prepare_model_onboarding(self, progress) -> None:
        progress(ModelPullProgress(status="runtime validated"))

    def pull_model(self, progress) -> None:
        progress(
            ModelPullProgress(
                status="provider download complete",
                completed=23,
                total=23,
            )
        )

    def verify_model_onboarding(self, progress) -> None:
        progress(ModelPullProgress(status="generation ready"))


def test_model_installer_enters_commit_before_final_onboarding_verification() -> None:
    provider = RecordingOnboardingProvider()
    progress: list[RuntimeInstallProgress] = []
    installer = LLMModelInstaller(
        provider,
        fastflowlm_terms_accepted=lambda: True,
    )

    status = installer.install(progress.append)

    assert status == RuntimeInstallationStatus.SUCCEEDED
    commit_index = next(
        index for index, item in enumerate(progress) if item.phase == "committing"
    )
    assert progress[commit_index].detail == "Committing the selected model."
    assert all(item.cancellable is True for item in progress[:commit_index])
    assert [item.detail for item in progress[commit_index:]] == [
        "Committing the selected model.",
        "Verifying model onboarding.",
        "generation ready",
        "Model onboarding verified.",
    ]
    assert all(
        item.phase == "committing" and item.cancellable is False
        for item in progress[commit_index:]
    )
    assert all(
        item.completed == item.total == 23 for item in progress[commit_index:]
    )
