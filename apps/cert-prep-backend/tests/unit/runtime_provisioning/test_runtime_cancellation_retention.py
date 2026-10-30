"""Cancellation signals share the repository's job retention lifetime."""

from runtime_characterization_support import (
    installer as installer,
    make_manager as make_manager,
    no_ollama_start as no_ollama_start,
    runtime_clock as runtime_clock,
    worker_gates as worker_gates,
)

from cert_prep_contracts.runtime import (
    RuntimeInstallationStatus as Status,
    RuntimeRequirementKind as Kind,
)


def test_completed_jobs_retain_cancellation_signals_only_until_eviction(make_manager):
    manager = make_manager()
    completed = [manager.start_installation(Kind.OLLAMA) for _ in range(500)]

    assert all(job.status == Status.SUCCEEDED for job in completed)
    assert list(manager._jobs) == [job.id for job in completed[-100:]]
    assert len(manager._cancellation_signals) == len(manager._jobs) == 100
    assert set(manager._cancellation_signals) == set(manager._jobs)
