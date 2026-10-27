from __future__ import annotations

from typing import Any

import ollama


class OllamaClient:
    """Small injectable wrapper around the third-party Ollama client."""

    def __init__(self, *, host: str, timeout_seconds: float, client: Any | None = None) -> None:
        self._client = client or ollama.Client(host=host, timeout=timeout_seconds)

    def list(self) -> Any:
        return self._client.list()

    def chat(self, **kwargs: Any) -> Any:
        return self._client.chat(**kwargs)

    def pull(self, *args: Any, **kwargs: Any) -> Any:
        return self._client.pull(*args, **kwargs)
