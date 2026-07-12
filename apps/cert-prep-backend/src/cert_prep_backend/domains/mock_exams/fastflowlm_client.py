from __future__ import annotations

from collections.abc import Callable, Sequence
import json
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from cert_prep_backend.api.errors import ProviderUnavailableError


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


_NO_PROXY_HANDLER = ProxyHandler({})
_REJECT_REDIRECTS = _RejectRedirects()
_LOOPBACK_OPENER = build_opener(_NO_PROXY_HANDLER, _REJECT_REDIRECTS)


class FastFlowLMClient:
    """OpenAI-compatible HTTP client for FastFlowLM."""

    def __init__(self, *, base_url: str, timeout_seconds: float) -> None:
        self.base_url = _validated_loopback_base_url(base_url)
        self.timeout_seconds = timeout_seconds

    def served_model_names(
        self,
        *,
        request_json: Callable[..., dict[str, Any]] | None = None,
    ) -> set[str]:
        request = request_json or self.request_json
        return extract_openai_model_names(
            request("GET", "/models", timeout_seconds=min(5.0, self.timeout_seconds))
        )

    def chat_json(
        self,
        model: str,
        messages: Sequence[dict[str, str]],
        *,
        max_tokens: int,
        context_tokens: int,
        request_json: Callable[..., dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        content = self.chat_content(
            model,
            messages,
            max_tokens=max_tokens,
            context_tokens=context_tokens,
            json_mode=True,
            request_json=request_json,
        )
        try:
            payload = json.loads(content)
        except json.JSONDecodeError as exc:
            raise ProviderUnavailableError("FastFlowLM returned invalid JSON.") from exc
        if not isinstance(payload, dict):
            raise ProviderUnavailableError("FastFlowLM returned a non-object JSON response.")
        return payload

    def chat_content(
        self,
        model: str,
        messages: Sequence[dict[str, str]],
        *,
        max_tokens: int,
        context_tokens: int,
        json_mode: bool = False,
        request_json: Callable[..., dict[str, Any]] | None = None,
    ) -> str:
        request = {
            "model": model,
            "messages": list(messages),
            "temperature": 0,
            "max_tokens": max_tokens,
            "stream": False,
            "extra_body": {"num_ctx": context_tokens},
        }
        if json_mode:
            request["response_format"] = {"type": "json_object"}
        request_fn = request_json or self.request_json
        try:
            response = request_fn("POST", "/chat/completions", body=request)
        except ProviderUnavailableError as exc:
            if json_mode and _is_response_format_error(exc):
                request.pop("response_format", None)
                response = request_fn("POST", "/chat/completions", body=request)
            else:
                raise
        content = chat_completion_content(response)
        if content is None:
            raise ProviderUnavailableError("FastFlowLM returned an unreadable response.")
        return content

    def request_json(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        timeout_seconds: float | None = None,
    ) -> dict[str, Any]:
        data = None
        headers = {"Accept": "application/json"}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
            headers["Authorization"] = "Bearer flm"
        request = Request(
            f"{self.base_url}{path}",
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with _LOOPBACK_OPENER.open(
                request,
                timeout=timeout_seconds or self.timeout_seconds,
            ) as response:
                payload = response.read().decode("utf-8")
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace").strip()
            raise ProviderUnavailableError(
                f"FastFlowLM HTTP {exc.code}: {detail or exc.reason}"
            ) from exc
        except (OSError, URLError, ValueError) as exc:
            raise ProviderUnavailableError(str(exc)) from exc
        try:
            decoded = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise ProviderUnavailableError("FastFlowLM returned invalid response JSON.") from exc
        if not isinstance(decoded, dict):
            raise ProviderUnavailableError("FastFlowLM returned non-object response JSON.")
        return decoded


def _validated_loopback_base_url(value: str) -> str:
    parsed = urlsplit(value)
    try:
        port = parsed.port
    except ValueError as exc:
        raise ProviderUnavailableError("FastFlowLM base URL has an invalid port.") from exc
    if (
        parsed.scheme != "http"
        or parsed.hostname != "127.0.0.1"
        or port is None
        or port == 0
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path.rstrip("/") != "/v1"
    ):
        raise ProviderUnavailableError(
            "FastFlowLM base URL must be http://127.0.0.1:<port>/v1."
        )
    return f"http://127.0.0.1:{port}/v1"


def extract_openai_model_names(response: Any) -> set[str]:
    """Extract model identifiers from OpenAI-compatible model-list responses."""

    names: set[str] = set()
    model_items = []
    if isinstance(response, dict):
        if isinstance(response.get("data"), list):
            model_items.extend(response["data"])
        if isinstance(response.get("models"), list):
            model_items.extend(response["models"])
    for item in model_items:
        if isinstance(item, str):
            names.add(item)
            continue
        if not isinstance(item, dict):
            continue
        for key in ("id", "model", "name"):
            value = item.get(key)
            if isinstance(value, str) and value.strip():
                names.add(value.strip())
                break
    return names


def chat_completion_content(response: dict[str, Any]) -> str | None:
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    first = choices[0]
    if not isinstance(first, dict):
        return None
    message = first.get("message")
    if isinstance(message, dict) and isinstance(message.get("content"), str):
        return message["content"]
    if isinstance(first.get("text"), str):
        return first["text"]
    return None


def _is_response_format_error(exc: Exception) -> bool:
    """Return True when *exc* is an HTTP 400 caused by an unsupported response_format.

    Avoids broad substring matching that could trigger on unrelated error
    messages containing the word ``response_format`` (e.g. proxy error pages).
    """

    error_text = str(exc).lower()
    if "response_format" not in error_text:
        return False
    return "http 400" in error_text
