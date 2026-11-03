"""Server-sent events of runtime installations and model downloads. The stream itself is the
platform's; the snapshots and when they end are Runtime Provisioning's."""

from __future__ import annotations

from dataclasses import asdict
from typing import Annotated

from fastapi import APIRouter, Depends, Header

from cert_prep_backend.api.errors import not_found_error
from cert_prep_backend.platform.change_notifications import DatabaseChangeNotifier
from cert_prep_backend.platform.dependencies import get_database_change_notifier
from cert_prep_backend.platform.sse import operation_snapshot_stream, streaming_response
from cert_prep_backend.runtime_provisioning.api.router import get_runtime_installation_manager
from cert_prep_backend.runtime_provisioning.application import use_cases as runtime_installations
from cert_prep_backend.runtime_provisioning.application.ports import RuntimeInstallation
from cert_prep_backend.runtime_provisioning.domain.installation import TERMINAL_JOB_STATUSES


router = APIRouter(tags=["operation-events"])
SSE_RESPONSES = {
    200: {
        "description": "Server-sent operation snapshots.",
        "content": {"text/event-stream": {}},
    }
}
LastEventIdHeader = Annotated[str | None, Header(alias="Last-Event-ID")]


@router.get("/runtime/installations/{job_id}/events", responses=SSE_RESPONSES)
def runtime_installation_events(
    job_id: str,
    last_event_id: LastEventIdHeader = None,
    manager: RuntimeInstallation = Depends(get_runtime_installation_manager),
    notifier: DatabaseChangeNotifier = Depends(get_database_change_notifier),
):
    try:
        _runtime_installation_snapshot(manager, job_id)
    except KeyError as exc:
        raise not_found_error("Runtime installation job was not found.") from exc
    return streaming_response(
        operation_snapshot_stream(
            notifier=notifier,
            snapshot=lambda: _runtime_installation_snapshot(manager, job_id),
            event_name="runtime-installation",
            is_terminal=_installation_ended,
            last_event_id=last_event_id,
        )
    )


@router.get("/llm/model-downloads/{job_id}/events", responses=SSE_RESPONSES)
def model_download_events(
    job_id: str,
    last_event_id: LastEventIdHeader = None,
    manager: RuntimeInstallation = Depends(get_runtime_installation_manager),
    notifier: DatabaseChangeNotifier = Depends(get_database_change_notifier),
):
    try:
        _model_download_snapshot(manager, job_id)
    except KeyError as exc:
        raise not_found_error("Model download job was not found.") from exc
    return streaming_response(
        operation_snapshot_stream(
            notifier=notifier,
            snapshot=lambda: _model_download_snapshot(manager, job_id),
            event_name="model-download",
            is_terminal=_installation_ended,
            last_event_id=last_event_id,
        )
    )


def _runtime_installation_snapshot(manager: RuntimeInstallation, job_id: str) -> dict:
    return asdict(runtime_installations.view_runtime_installation(manager, job_id))


def _model_download_snapshot(manager: RuntimeInstallation, job_id: str) -> dict:
    """A model download's events have always left out the installation kind."""

    snapshot = _runtime_installation_snapshot(manager, job_id)
    snapshot.pop("kind", None)
    return snapshot


def _installation_ended(snapshot: dict) -> bool:
    return snapshot["status"] in TERMINAL_JOB_STATUSES


__all__ = ["router"]
