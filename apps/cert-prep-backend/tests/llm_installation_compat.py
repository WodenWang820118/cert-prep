"""Legacy fixture vocabulary for the frozen pre-extraction characterization tests.

Production has no manager facade. This test adapter builds the production ports
and delegates to the same use cases as HTTP, SSE and application lifespan.
"""

from cert_prep_backend.bootstrap.app import build_llm_installation
from cert_prep_backend.llm_provisioning.application import use_cases
from cert_prep_backend.llm_provisioning.application.ports import LLMInstallation
from cert_prep_contracts.llm_installation import LLMRequirementKind


class LLMInstallationManager(LLMInstallation):
    def __init__(self, **kwargs):
        runtime = build_llm_installation(**kwargs)
        super().__init__(runtime.jobs, runtime.installers, runtime.work, runtime.clock, runtime.new_id)
        use_cases.recover_llm_installations(self)

    @property
    def _jobs(self):
        return self.jobs._jobs

    @property
    def _installers(self):
        return self.installers._installers

    @property
    def _job_threads(self):
        return self.work._job_threads

    @property
    def _cancellation_signals(self):
        return self.work._cancellation_signals

    def requirements(self):
        return use_cases.list_llm_requirements(self)

    def requirement(self, kind):
        installer = self.installers.get(LLMRequirementKind(kind))
        return installer.requirement() if installer is not None else None

    def start_installation(self, kind):
        return use_cases.start_llm_installation(self, kind)

    def start_model_installation(self):
        return use_cases.download_selected_model(self)

    def get_installation(self, job_id):
        return use_cases.view_llm_installation(self, job_id)

    def cancel_installation(self, job_id):
        return use_cases.cancel_llm_installation(self, job_id)

    def close(self):
        use_cases.stop_llm_installations(self)

    def _update_job(self, job_id, **kwargs):
        use_cases._update_job(self, job_id, **kwargs)
