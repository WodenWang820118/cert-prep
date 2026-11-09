from __future__ import annotations

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
    ) -> None:
        self._client = Client(
            host=settings.ollama_host,
            timeout=settings.ollama_timeout_seconds,
        )
        self._model = settings.ollama_model
        self._keep_alive = keep_alive
        self._released = False

    def translate(self, japanese: str) -> str:
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
            options=TRANSLATION_OPTIONS,
            think=False,
            stream=False,
            keep_alive=self._keep_alive,
        )
        return str(response.message.content or '').strip()

    def release_resources(self) -> None:
        if self._released or self._keep_alive == 0:
            return
        self._released = True
        self._client.generate(model=self._model, keep_alive=0)


