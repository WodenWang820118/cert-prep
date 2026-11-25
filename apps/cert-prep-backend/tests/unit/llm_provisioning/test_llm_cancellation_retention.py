"""Cancellation signals share the repository's job retention lifetime."""

from llm_characterization_support import (
    installer as installer,
    make_installation as make_installation,
    no_ollama_start as no_ollama_start,
    runtime_clock as runtime_clock,
    worker_gates as worker_gates,
)

from cert_prep_backend.llm_provisioning.application.use_cases import start_llm_installation
from cert_prep_contracts.llm_installation import (
    LLMInstallationStatus as Status,
    LLMRequirementKind as Kind,
)


def test_completed_jobs_retain_cancellation_signals_only_until_eviction(make_installation):
    installation = make_installation()
    completed = [start_llm_installation(installation, Kind.OLLAMA) for _ in range(500)]

    assert all(job.status == Status.SUCCEEDED for job in completed)
    retained = installation.jobs.list_all()
    assert [job.id for job in retained] == [job.id for job in completed[-100:]]
    assert len(retained) == 100
    # A missing signal cannot be set; a retained one can. That is the retention fact.
    for job in retained:
        assert installation.work.cancellation_requested(job.id) is False
        installation.work.signal_cancellation(job.id)
        assert installation.work.cancellation_requested(job.id) is True
    for job in completed[:-100]:
        installation.work.signal_cancellation(job.id)
        assert installation.work.cancellation_requested(job.id) is False
