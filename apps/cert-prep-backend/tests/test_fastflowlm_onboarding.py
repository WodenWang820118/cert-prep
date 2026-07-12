from __future__ import annotations

import copy
import json
from pathlib import Path
import subprocess
from typing import Any

import pytest

from cert_prep_backend.api.errors import ProviderUnavailableError
from cert_prep_backend.domains.mock_exams.fastflowlm_onboarding import (
    FastFlowLMModelOnboarding,
    parse_installed_fastflowlm_models,
    run_fastflowlm_command,
    start_fastflowlm_onboarding_server,
    validate_fastflowlm_preflight,
)
from cert_prep_backend.domains.mock_exams.fastflowlm_server import (
    start_fastflowlm_server_process,
)
from cert_prep_backend.domains.runtime_installations.installers import LLMModelInstaller
from cert_prep_contracts.llm import DEFAULT_LLM_PRIMARY_MODEL


FIXTURE_DIR = Path(__file__).parent / "fixtures" / "fastflowlm"
EXECUTABLE = (Path.cwd() / "trusted-fastflowlm" / "flm.exe").resolve()


def _fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURE_DIR / name).read_text(encoding="utf-8"))


def test_v0943_cli_fixtures_match_the_required_schema() -> None:
    validation = _fixture("validate-v0.9.43.json")
    installed = _fixture("list-installed-v0.9.43.json")

    validate_fastflowlm_preflight(validation)
    assert parse_installed_fastflowlm_models(installed) == {
        "qwen3.5:2b",
        DEFAULT_LLM_PRIMARY_MODEL,
    }
    primary = next(
        item for item in installed["models"] if item["model"] == DEFAULT_LLM_PRIMARY_MODEL
    )
    assert primary["name"] == DEFAULT_LLM_PRIMARY_MODEL
    assert primary["installed"] is True
    assert primary["flm_min_version"] == "0.9.43"
    assert primary["files"] == [
        "config.json",
        "model.q4nx",
        "tokenizer.json",
        "tokenizer_config.json",
        "vision_weight.q4nx",
        "chat_template.jinja",
    ]


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("object", "other"),
        ("platform", "linux"),
        ("amd_device_found", False),
        ("amd_device_found", 1),
        ("npu_driver_ok", "true"),
        ("ready", None),
    ],
)
def test_fastflowlm_preflight_rejects_non_exact_values(field: str, value: Any) -> None:
    payload = _fixture("validate-v0.9.43.json")
    payload[field] = value

    with pytest.raises(ProviderUnavailableError, match="ready Windows XDNA2"):
        validate_fastflowlm_preflight(payload)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda payload: payload.pop("models"),
        lambda payload: payload.__setitem__("models", {}),
        lambda payload: payload["models"].append("qwen3.5:4b"),
        lambda payload: payload["models"][1].__setitem__("model", " qwen3.5:4b "),
        lambda payload: payload["models"][1].__setitem__("installed", 1),
    ],
)
def test_installed_model_parser_rejects_non_exact_entries(mutation) -> None:
    payload = _fixture("list-installed-v0.9.43.json")
    mutation(payload)

    with pytest.raises(ProviderUnavailableError, match="installed-model response"):
        parse_installed_fastflowlm_models(payload)


def test_owned_onboarding_uses_exact_cli_order_model_and_dedicated_port() -> None:
    events: list[Any] = []
    process = _RecordingProcess()
    client = _RecordingClient(events=events)
    runner = _CommandRunner(events=events)
    onboarding = _onboarding(
        command_runner=runner,
        port_allocator=lambda: 58431,
        process_starter=lambda executable, model, port: (
            events.append(("serve", executable, model, port)) or process
        ),
        client_factory=lambda base_url, timeout: (
            events.append(("client", base_url, timeout)) or client
        ),
        process_terminator=lambda owned: events.append(("terminate", owned)),
    )

    onboarding.prepare(lambda progress: events.append(("progress", progress.status)))
    events.append(("pull", DEFAULT_LLM_PRIMARY_MODEL))
    onboarding.verify(lambda progress: events.append(("progress", progress.status)))

    commands = [event[1] for event in events if event[0] == "command"]
    assert commands == [
        ("validate", "--json"),
        ("list", "--filter", "installed", "--json"),
        ("list", "--filter", "installed", "--json"),
        ("check", DEFAULT_LLM_PRIMARY_MODEL),
    ]
    assert ("serve", EXECUTABLE, DEFAULT_LLM_PRIMARY_MODEL, 58431) in events
    assert ("client", "http://127.0.0.1:58431/v1", 30.0) in events
    assert ("models",) in events
    completion = next(event for event in events if event[0] == "completion")
    assert completion[1:] == (
        DEFAULT_LLM_PRIMARY_MODEL,
        [{"role": "user", "content": "Reply with OK."}],
        4,
        256,
    )
    assert events[-2:] == [
        ("terminate", process),
        ("progress", "FastFlowLM model onboarding verified"),
    ]


def test_onboarding_refuses_non_primary_model_before_resolving() -> None:
    resolved = False

    def resolve() -> Path:
        nonlocal resolved
        resolved = True
        return EXECUTABLE

    onboarding = FastFlowLMModelOnboarding(
        model="qwen3.5:2b",
        executable_resolver=resolve,
        command_timeout_seconds=30,
        server_start_timeout_seconds=1,
    )

    with pytest.raises(ProviderUnavailableError, match=DEFAULT_LLM_PRIMARY_MODEL):
        onboarding.prepare(lambda _progress: None)
    assert resolved is False


def test_onboarding_rejects_only_2b_after_pull_without_starting_server() -> None:
    events: list[Any] = []
    installed = _fixture("list-installed-v0.9.43.json")
    installed["models"] = [installed["models"][0]]
    runner = _CommandRunner(events=events, installed=installed)
    onboarding = _onboarding(
        command_runner=runner,
        process_starter=lambda *_args: pytest.fail("server must not start"),
    )

    with pytest.raises(ProviderUnavailableError, match="did not report qwen3.5:4b"):
        onboarding.verify(lambda _progress: None)

    assert [event[1] for event in events] == [
        ("list", "--filter", "installed", "--json")
    ]


def test_owned_process_exit_after_models_cannot_be_hidden_by_http_fake() -> None:
    process = _RecordingProcess()
    terminated: list[Any] = []
    client = _RecordingClient(process=process, exit_after_models=True)
    onboarding = _onboarding(
        process_starter=lambda *_args: process,
        client_factory=lambda *_args: client,
        process_terminator=terminated.append,
    )

    with pytest.raises(ProviderUnavailableError, match="exited unexpectedly"):
        onboarding.verify(lambda _progress: None)

    assert client.completion_calls == 0
    assert terminated == [process]


def test_owned_models_response_rejects_extra_fallback_model() -> None:
    process = _RecordingProcess()
    terminated: list[Any] = []
    client = _RecordingClient(models={DEFAULT_LLM_PRIMARY_MODEL, "qwen3.5:2b"})
    onboarding = _onboarding(
        process_starter=lambda *_args: process,
        client_factory=lambda *_args: client,
        process_terminator=terminated.append,
        monotonic=iter((0.0, 1.0)).__next__,
    )

    with pytest.raises(ProviderUnavailableError, match="only the pinned model"):
        onboarding.verify(lambda _progress: None)

    assert client.completion_calls == 0
    assert terminated == [process]


def test_fastflowlm_pull_only_provider_cannot_bypass_verified_onboarding() -> None:
    provider = _PullOnlyFastFlowLMProvider()
    installer = LLMModelInstaller(
        provider,
        fastflowlm_terms_accepted=lambda: True,
    )

    with pytest.raises(ProviderUnavailableError, match="verified model onboarding"):
        installer.install(lambda _progress: None)

    assert provider.pull_calls == 0


@pytest.mark.parametrize("failure_point", ["client", "models", "completion", "empty"])
def test_owned_onboarding_always_terminates_after_process_start(failure_point: str) -> None:
    process = _RecordingProcess()
    terminated: list[Any] = []
    client = _RecordingClient(failure_point=failure_point)

    def create_client(*_args):
        if failure_point == "client":
            raise ProviderUnavailableError("client failed")
        return client

    onboarding = _onboarding(
        process_starter=lambda *_args: process,
        client_factory=create_client,
        process_terminator=terminated.append,
        monotonic=iter((0.0, 1.0)).__next__,
    )

    with pytest.raises(ProviderUnavailableError):
        onboarding.verify(lambda _progress: None)

    assert terminated == [process]


def test_cli_runner_uses_absolute_executable_and_fixed_working_directory(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_run(command, **kwargs):
        captured["command"] = command
        captured["kwargs"] = kwargs
        return subprocess.CompletedProcess(command, 0, stdout="{}", stderr="")

    monkeypatch.setattr(
        "cert_prep_backend.domains.mock_exams.fastflowlm_onboarding.subprocess.run",
        fake_run,
    )

    run_fastflowlm_command(EXECUTABLE, ("validate", "--json"), 12.0)

    assert captured["command"] == [str(EXECUTABLE), "validate", "--json"]
    assert captured["kwargs"]["cwd"] == EXECUTABLE.parent
    assert captured["kwargs"]["stdin"] is subprocess.DEVNULL
    assert captured["kwargs"]["timeout"] == 12.0
    assert "shell" not in captured["kwargs"]


def test_server_start_uses_exact_owned_serve_command(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}
    process = _RecordingProcess()

    def fake_popen(command, **kwargs):
        captured["command"] = command
        captured["kwargs"] = kwargs
        return process

    monkeypatch.setattr(
        "cert_prep_backend.domains.mock_exams.fastflowlm_onboarding.subprocess.Popen",
        fake_popen,
    )

    assert start_fastflowlm_onboarding_server(
        EXECUTABLE,
        DEFAULT_LLM_PRIMARY_MODEL,
        58431,
    ) is process
    assert captured["command"] == [
        str(EXECUTABLE),
        "serve",
        DEFAULT_LLM_PRIMARY_MODEL,
        "--host",
        "127.0.0.1",
        "--port",
        "58431",
        "--quiet",
        "--cors",
        "0",
    ]
    assert captured["kwargs"]["cwd"] == EXECUTABLE.parent
    assert captured["kwargs"]["stdin"] is subprocess.DEVNULL
    assert captured["kwargs"]["stdout"] is subprocess.DEVNULL
    assert captured["kwargs"]["stderr"] is subprocess.DEVNULL


def test_generation_server_start_disables_cors_and_ambient_cwd(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}
    process = _RecordingProcess()

    def fake_popen(command, **kwargs):
        captured["command"] = command
        captured["kwargs"] = kwargs
        return process

    monkeypatch.setattr(
        "cert_prep_backend.domains.mock_exams.fastflowlm_server.subprocess.Popen",
        fake_popen,
    )

    assert start_fastflowlm_server_process(
        executable=EXECUTABLE,
        model=DEFAULT_LLM_PRIMARY_MODEL,
        host="127.0.0.1",
        port=52625,
        creationflags=0,
    ) is process
    assert captured["command"][-2:] == ["--cors", "0"]
    assert captured["kwargs"]["cwd"] == EXECUTABLE.parent


class _CommandRunner:
    def __init__(
        self,
        *,
        events: list[Any] | None = None,
        installed: dict[str, Any] | None = None,
    ) -> None:
        self.events = events if events is not None else []
        self.installed = installed or _fixture("list-installed-v0.9.43.json")

    def __call__(
        self,
        executable: Path,
        arguments,
        timeout_seconds: float,
    ) -> subprocess.CompletedProcess[str]:
        self.events.append(("command", tuple(arguments), executable, timeout_seconds))
        if tuple(arguments) == ("validate", "--json"):
            payload = _fixture("validate-v0.9.43.json")
        elif tuple(arguments) == ("list", "--filter", "installed", "--json"):
            payload = copy.deepcopy(self.installed)
        elif tuple(arguments) == ("check", DEFAULT_LLM_PRIMARY_MODEL):
            return subprocess.CompletedProcess(arguments, 0, stdout="model check passed", stderr="")
        else:
            raise AssertionError(f"Unexpected command: {arguments}")
        return subprocess.CompletedProcess(
            arguments,
            0,
            stdout=json.dumps(payload),
            stderr="",
        )


class _RecordingProcess:
    pid = 4242

    def __init__(self) -> None:
        self.returncode: int | None = None

    def poll(self) -> int | None:
        return self.returncode


class _RecordingClient:
    def __init__(
        self,
        *,
        events: list[Any] | None = None,
        process: _RecordingProcess | None = None,
        exit_after_models: bool = False,
        failure_point: str | None = None,
        models: set[str] | None = None,
    ) -> None:
        self.events = events if events is not None else []
        self.process = process
        self.exit_after_models = exit_after_models
        self.failure_point = failure_point
        self.models = models if models is not None else {DEFAULT_LLM_PRIMARY_MODEL}
        self.completion_calls = 0

    def served_model_names(self) -> set[str]:
        self.events.append(("models",))
        if self.failure_point == "models":
            raise ProviderUnavailableError("models failed")
        if self.exit_after_models and self.process is not None:
            self.process.returncode = 1
        return self.models

    def chat_content(
        self,
        model: str,
        messages: list[dict[str, str]],
        *,
        max_tokens: int,
        context_tokens: int,
    ) -> str:
        self.completion_calls += 1
        self.events.append(
            ("completion", model, messages, max_tokens, context_tokens)
        )
        if self.failure_point == "completion":
            raise ProviderUnavailableError("completion failed")
        if self.failure_point == "empty":
            return ""
        return "OK"


class _PullOnlyFastFlowLMProvider:
    provider = "fastflowlm"
    model = DEFAULT_LLM_PRIMARY_MODEL

    def __init__(self) -> None:
        self.pull_calls = 0

    def pull_model(self, _progress) -> None:
        self.pull_calls += 1


def _onboarding(**overrides) -> FastFlowLMModelOnboarding:
    options = {
        "model": DEFAULT_LLM_PRIMARY_MODEL,
        "executable_resolver": lambda: EXECUTABLE,
        "command_timeout_seconds": 30.0,
        "server_start_timeout_seconds": 0.1,
        "command_runner": _CommandRunner(),
        "port_allocator": lambda: 58431,
        "process_starter": lambda *_args: _RecordingProcess(),
        "client_factory": lambda *_args: _RecordingClient(),
        "process_terminator": lambda _process: None,
        "monotonic": lambda: 0.0,
        "sleeper": lambda _seconds: None,
    }
    options.update(overrides)
    return FastFlowLMModelOnboarding(**options)
