"""Deterministic Modelfile rendering for cert-prep Ollama profiles."""

from __future__ import annotations

import hashlib

from cert_prep_contracts.llm_profiles import OllamaModelProfile, OllamaParameterValue


DEFAULT_CERT_PREP_SYSTEM_PROMPT = (
    "You are a local cert-prep study assistant. Use only the provided source "
    "text when generating practice questions. Preserve visible questions and "
    "answer choices exactly when they come from source material. Do not reveal "
    "hidden chain-of-thought; provide only concise user-facing rationales."
)


def render_modelfile(profile: OllamaModelProfile) -> str:
    """Render a deterministic Modelfile text for hashing and diagnostics."""

    parameters = parameters_from_profile(profile)
    lines = [f"FROM {profile.base_model}"]
    for key in sorted(parameters):
        lines.append(f"PARAMETER {key} {_render_parameter_value(parameters[key])}")
    lines.extend(
        [
            'SYSTEM """',
            profile.system_prompt.strip(),
            '"""',
            "",
        ]
    )
    return "\n".join(lines)


def modelfile_sha256(profile: OllamaModelProfile) -> str:
    """Return the SHA-256 of the deterministic Modelfile text."""

    return hashlib.sha256(render_modelfile(profile).encode("utf-8")).hexdigest()


def parameters_from_profile(profile: OllamaModelProfile) -> dict[str, OllamaParameterValue]:
    """Return Ollama create parameters for a profile."""

    parameters = dict(profile.parameters)
    parameters["num_ctx"] = profile.context_window
    return parameters


def _render_parameter_value(value: OllamaParameterValue) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


__all__ = [
    "DEFAULT_CERT_PREP_SYSTEM_PROMPT",
    "modelfile_sha256",
    "parameters_from_profile",
    "render_modelfile",
]
