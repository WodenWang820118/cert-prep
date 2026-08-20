from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from dataclasses import asdict, is_dataclass
from enum import Enum
from typing import Any

from fastapi.responses import StreamingResponse

from cert_prep_backend.persistence.change_notifications import DatabaseChangeNotifier


SSE_HEARTBEAT_SECONDS = 15.0


def operation_snapshot_stream(
    *,
    notifier: DatabaseChangeNotifier,
    snapshot: Callable[[], Any],
    event_name: str,
    is_terminal: Callable[[Any], bool],
    last_event_id: str | None,
) -> Iterator[str]:
    """Emit the current operation snapshot after durable database changes."""

    sequence = _parse_last_event_id(last_event_id)
    observed_revision = notifier.revision()
    initial_snapshot = snapshot()
    previous_payload = _json_value(initial_snapshot)

    try:
        yield encode_sse_event(
            event_id=_next_sequence(sequence),
            event_name=event_name,
            data=previous_payload,
        )
        sequence += 1
        if is_terminal(initial_snapshot):
            return

        while True:
            next_revision = notifier.wait_for_change(
                observed_revision,
                timeout_seconds=SSE_HEARTBEAT_SECONDS,
            )
            if next_revision == observed_revision:
                yield ": cert-prep heartbeat\n\n"
                continue
            observed_revision = next_revision

            current_snapshot = snapshot()
            current_payload = _json_value(current_snapshot)
            if current_payload == previous_payload:
                continue
            previous_payload = current_payload
            yield encode_sse_event(
                event_id=_next_sequence(sequence),
                event_name=event_name,
                data=current_payload,
            )
            sequence += 1
            if is_terminal(current_snapshot):
                return
    except GeneratorExit:
        return


def streaming_response(stream: Iterator[str]) -> StreamingResponse:
    return StreamingResponse(
        stream,
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
        },
    )


def encode_sse_event(*, event_id: int, event_name: str, data: Any) -> str:
    payload = json.dumps(
        _json_value(data),
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return f"id: {event_id}\nevent: {event_name}\ndata: {payload}\n\n"


def _parse_last_event_id(value: str | None) -> int:
    if value is None or not value.strip():
        return 0
    try:
        return max(0, int(value))
    except ValueError:
        return 0


def _next_sequence(sequence: int) -> int:
    return sequence + 1


def _json_value(value: Any) -> Any:
    if is_dataclass(value):
        return _json_value(asdict(value))
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_value(item) for item in value]
    if isinstance(value, tuple):
        return [_json_value(item) for item in value]
    return value


__all__ = [
    "SSE_HEARTBEAT_SECONDS",
    "encode_sse_event",
    "operation_snapshot_stream",
    "streaming_response",
]
