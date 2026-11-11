from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from ollama import Client

from cert_prep_backend.platform.config import Settings


TRANSLATION_OPTIONS = {
    'temperature': 0,
    'num_ctx': 2048,
    'num_predict': 512,
}


class OllamaTraditionalChineseTranslator:
    def __init__(
        self,
        settings: Settings,
        *,
        keep_alive: str | float | int | None = 0,
        server: Any | None = None,
    ) -> None:
        self._client = Client(
            host=settings.ollama_host,
            timeout=settings.ollama_timeout_seconds,
        )
        self._model = settings.ollama_model
        self._keep_alive = keep_alive
        self._released = False
        self._server = server

    def translate(self, japanese: str) -> str:
        with self._while_server_in_use():
            response = self._client.chat(
                model=self._model,
                messages=[
                    {
                        'role': 'system',
                        'content': (
                            'Translate Japanese into natural Traditional Chinese used in Taiwan. '
                            'Return only the translation. Preserve names, numbers, and meaning.'
                        ),
                    },
                    {'role': 'user', 'content': japanese},
                ],
                options=self._options(),
                think=False,
                stream=False,
                keep_alive=self._keep_alive,
            )
        return str(response.message.content or '').strip()

    def release_resources(self) -> None:
        if self._released or self._keep_alive == 0:
            return
        self._released = True
        with self._while_server_in_use():
            self._client.generate(model=self._model, keep_alive=0)

    def _options(self) -> dict[str, int]:
        """The fixed translation options, plus ``num_gpu=0`` when the choice is CPU.

        A machine with no GPU whose choice is still Auto keeps the options unchanged.
        The override is read per call, the same decision generation uses.
        """

        options = dict(TRANSLATION_OPTIONS)
        server = self._server
        if server is not None and server.cpu_request_override():
            options['num_gpu'] = 0
        return options

    @contextmanager
    def _while_server_in_use(self) -> Iterator[None]:
        """Count this request against an owned server. No server means no admission."""

        server = self._server
        if server is None:
            yield
            return
        with server.admission():
            yield


