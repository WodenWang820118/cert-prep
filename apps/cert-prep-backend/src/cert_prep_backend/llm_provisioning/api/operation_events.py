"""Server-sent events of LLM installations. The stream itself is the
platform's; the snapshots and when they end are LLM Provisioning's."""

from __future__ import annotations

from dataclasses import asdict
from typing import Annotated

from fastapi import APIRouter, Depends, Header

from cert_prep_backend.api.errors import not_found_error
from cert_prep_backend.platform.change_notifications import DatabaseChangeNotifier
from cert_prep_backend.platform.dependencies import get_database_change_notifier
from cert_prep_backend.platform.sse import operation_snapshot_stream, streaming_response
from cert_prep_backend.llm_provisioning.api.router import get_llm_installation_manager
from cert_prep_backend.llm_provisioning.application import use_cases as llm_installations
from cert_prep_backend.llm_provisioning.application.ports import LLMInstallation
from cert_prep_backend.llm_provisioning.domain.installation import TERMINAL_JOB_STATUSES


router = APIRouter(tags=["operation-events"])
SSE_RESPONSES = {
    200: {
        "description": "Server-sent operation snapshots.",
        "content": {"text/event-stream": {}},
    }
}
LastEventIdHeader = Annotated[str | None, Header(alias="Last-Event-ID")]


@router.get("/llm/installations/{job_id}/events", responses=SSE_RESPONSES)
def llm_installation_events(
    job_id: str,
    last_event_id: LastEventIdHeader = None,
    manager: LLMInstallation = Depends(get_llm_installation_manager),
    notifier: DatabaseChangeNotifier = Depends(get_database_change_notifier),
):
    try:
        _llm_installation_snapshot(manager, job_id)
    except KeyError as exc:
        raise not_found_error("LLM installation job was not found.") from exc
    return streaming_response(
        operation_snapshot_stream(
            notifier=notifier,
            snapshot=lambda: _llm_installation_snapshot(manager, job_id),
            event_name="llm-installation",
            is_terminal=_installation_ended,
            last_event_id=last_event_id,
        )
    )


def _llm_installation_snapshot(manager: LLMInstallation, job_id: str) -> dict:
    return asdict(llm_installations.view_llm_installation(manager, job_id))


def _installation_ended(snapshot: dict) -> bool:
    return snapshot["status"] in TERMINAL_JOB_STATUSES


__all__ = ["router"]
