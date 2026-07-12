from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
import subprocess
from typing import Any

from cert_prep_backend.domains.mock_exams.fastflowlm_server import (
    start_fastflowlm_server_process,
)


class FastFlowLMIOMixin:
    """HTTP request and owned-server lifecycle helpers for FastFlowLM."""

    def _served_model_names(self) -> set[str]:
        return self._client.served_model_names(request_json=self._request_json)

    def _served_model_names_for_generation(self) -> set[str]:
        try:
            return self._served_model_names()
        except Exception as exc:
            return self._server_manager.served_model_names_for_generation(exc)

    def _start_owned_server_process(
        self,
        *,
        executable: Path,
        model: str,
        host: str,
        port: int,
        creationflags: int,
    ) -> subprocess.Popen:
        return start_fastflowlm_server_process(
            executable=executable,
            model=model,
            host=host,
            port=port,
            creationflags=creationflags,
        )

    def _model_to_serve_for_auto_start(self) -> str:
        unusable_models = self._runtime_unusable_models()
        for candidate in (self.model, *self.fallback_models):
            if candidate not in unusable_models:
                return candidate
        return self.model

    def _chat_json(
        self,
        model: str,
        messages: Sequence[dict[str, str]],
        *,
        max_tokens: int,
        context_tokens: int,
    ) -> dict[str, Any]:
        return self._client.chat_json(
            model,
            messages,
            max_tokens=max_tokens,
            context_tokens=context_tokens,
            request_json=self._request_json,
        )

    def _request_json(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        timeout_seconds: float | None = None,
    ) -> dict[str, Any]:
        return self._client.request_json(
            method,
            path,
            body=body,
            timeout_seconds=timeout_seconds,
        )
